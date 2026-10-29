import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, isInsideAnyRoot, toolRoots, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { sniffBinary } from './fs-read.js';
import { generateUnifiedDiff } from './fs-write.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/** Лимит правок за один вызов (защита от «мегапатча» в один tool_call). */
export const MAX_PATCH_EDITS = 50;
/**
 * Предел размера файла для атомарной мультифайловой правки: оригиналы держим
 * в памяти для отката, поэтому «разумный» объём обязателен.
 */
export const MAX_PATCH_FILE_BYTES = 5 * 1024 * 1024;

/** Одна правка: точный текст → замена (без unified diff). */
const patchEditSchema = z.object({
  file_path: z.string().min(1).describe('Path to the file to patch (absolute or relative to the working directory)'),
  old_string: z.string().min(1).describe('Exact text to replace; must be unique unless replace_all is set'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false)'),
});

/** Состояние одного файла в памяти: оригинал (для отката) и текущее содержимое. */
interface PatchFileState {
  /** Путь для текстов сообщений — из первой правки этого файла (как ввёл агент). */
  displayPath: string;
  resolvedPath: string;
  original: string;
  content: string;
  mode: number;
  replacements: number;
}

function patchError(
  key: 'fs.patch_not_found' | 'fs.patch_multiple' | 'fs.patch_file_missing' | 'fs.patch_not_regular' | 'fs.patch_too_large' | 'fs.patch_binary',
  params: Record<string, string>,
  metadata: Record<string, unknown>,
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...metadata, i18n: i18nMeta(key, params) },
  };
}

export const patchTool: ToolDefinition = {
  name: 'patch',
  description:
    'Apply several exact string replacements across one or more files in a single atomic call (all-or-nothing). '
    + 'Provide a JSON list of edits: each edit has file_path, old_string, new_string and optional replace_all. '
    + 'Nothing is written unless all edits can be applied: 0 matches or an ambiguous match without replace_all fails the whole call. '
    + 'read_file prefixes every line with its number ("N: "); that prefix is for reading only — never include it in old_string or new_string. '
    + 'Paths are resolved against the project working directory; prefer relative paths. Absolute paths outside the session perimeter are rejected, and paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    edits: z.array(patchEditSchema).min(1).max(MAX_PATCH_EDITS).describe('1..50 exact replacements applied in order'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const edits = parsed.data.edits;

    // ---------------------------------------------------------------------
    // Фаза 1: валидация и расчёт результата в памяти. Ничего не пишем.
    // ---------------------------------------------------------------------
    const files = new Map<string, PatchFileState>();
    const order: string[] = [];
    const roots = toolRoots(ctx);

    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]!;
      validateInputPath(edit.file_path, 'file_path');
      const resolvedPath = resolvePath(edit.file_path, ctx.workingDir);
      if (isSymlinkEscapeInRoots(roots, resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);
      // Абсолютный путь вне периметра — отказ на уровне тула (в отличие от
      // относительного «../…», который гейтит permission-слой).
      if (isAbsolute(edit.file_path) && !isInsideAnyRoot(resolvedPath, roots)) {
        return pathEscapesWorkspaceResult(resolvedPath);
      }

      let state = files.get(resolvedPath);
      if (!state) {
        const loaded = await loadPatchTarget(resolvedPath, edit.file_path);
        if ('error' in loaded) return loaded.error;
        state = loaded.state;
        files.set(resolvedPath, state);
        order.push(resolvedPath);
      }

      // ADR-036: деобфускация в точке потребления — тексты правки могут содержать ⟦SYNTH_SECRET_N⟧
      const oldString = await deobfuscateText(ctx, edit.old_string);
      const newString = await deobfuscateText(ctx, edit.new_string);

      const occurrences = state.content.split(oldString).length - 1;
      if (occurrences === 0) {
        return patchError(
          'fs.patch_not_found',
          { path: edit.file_path, index: String(index + 1) },
          { path: resolvedPath, index },
        );
      }
      const replaceAll = edit.replace_all === true;
      if (occurrences > 1 && !replaceAll) {
        return patchError(
          'fs.patch_multiple',
          { path: edit.file_path, index: String(index + 1), count: String(occurrences) },
          { path: resolvedPath, index, count: occurrences },
        );
      }

      // Правки применяются последовательно в памяти: следующая видит результат предыдущей.
      state.content = replaceAll
        ? state.content.replaceAll(oldString, newString)
        : state.content.replace(oldString, newString);
      state.replacements += replaceAll ? occurrences : 1;
    }

    // ---------------------------------------------------------------------
    // Фаза 2: запись. Атомарно по файлу (tmp в том же каталоге → rename);
    // при сбое посередине — best-effort откат уже перезаписанных файлов.
    // ---------------------------------------------------------------------
    const tmpFiles: string[] = [];
    const written: PatchFileState[] = [];
    let currentPath = '';
    try {
      for (const key of order) {
        const file = files.get(key)!;
        currentPath = file.resolvedPath;
        const tmp = join(dirname(file.resolvedPath), `${basename(file.resolvedPath)}.synth-tmp-${randomUUID()}`);
        tmpFiles.push(tmp);
        await writeFile(tmp, file.content, { encoding: 'utf-8', mode: file.mode });
        await rename(tmp, file.resolvedPath);
        written.push(file);
      }
    } catch (err) {
      // Временные файлы (включая уже переименованный — его rename удалил сам) убираем best-effort.
      for (const tmp of tmpFiles) {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
      // Уже перезаписанные файлы возвращаем к оригиналам.
      for (const file of written) {
        await writeFile(file.resolvedPath, file.original, { encoding: 'utf-8', mode: file.mode }).catch(() => undefined);
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: sm('fs.patch_write_failed', { path: currentPath, error: message }),
        isError: true,
        metadata: { path: currentPath, i18n: i18nMeta('fs.patch_write_failed', { path: currentPath, error: message }) },
      };
    }

    // ---------------------------------------------------------------------
    // Успех: сводка + по строке на файл; в metadata — диффы и счётчики.
    // ---------------------------------------------------------------------
    const summaryFiles = order.map((key) => files.get(key)!);
    const totalReplacements = summaryFiles.reduce((sum, file) => sum + file.replacements, 0);
    const lines = [
      sm('fs.patch_applied', { files: String(summaryFiles.length), replacements: String(totalReplacements) }),
      ...summaryFiles.map((file) => sm('fs.patch_file_line', {
        path: file.displayPath,
        count: String(file.replacements),
      })),
    ];
    return {
      content: lines.join('\n'),
      metadata: {
        files: summaryFiles.map((file) => ({
          path: file.displayPath,
          replacements: file.replacements,
          diff: generateUnifiedDiff(file.original, file.content, file.displayPath),
        })),
        totalReplacements,
        i18n: i18nMeta('fs.patch_applied', { files: String(summaryFiles.length), replacements: String(totalReplacements) }),
      },
    };
  },
};

/** Прочитать и проверить файл-цель до правок (обычный файл, текст, разумный размер). */
async function loadPatchTarget(
  resolvedPath: string,
  displayPath: string,
): Promise<{ state: PatchFileState } | { error: ToolResult }> {
  const info = await stat(resolvedPath).catch(() => null);
  if (!info) {
    return {
      error: patchError('fs.patch_file_missing', { path: displayPath }, { path: resolvedPath }),
    };
  }
  if (!info.isFile()) {
    return {
      error: patchError('fs.patch_not_regular', { path: displayPath }, { path: resolvedPath }),
    };
  }
  if (info.size > MAX_PATCH_FILE_BYTES) {
    const params = {
      path: displayPath,
      bytes: String(info.size),
      limit: String(MAX_PATCH_FILE_BYTES),
    };
    return {
      error: patchError('fs.patch_too_large', params, { path: resolvedPath, bytes: info.size, limit: MAX_PATCH_FILE_BYTES }),
    };
  }
  if (await sniffBinary(resolvedPath)) {
    return {
      error: patchError('fs.patch_binary', { path: displayPath }, { path: resolvedPath }),
    };
  }
  const content = await readFile(resolvedPath, 'utf-8');
  return {
    state: {
      displayPath,
      resolvedPath,
      original: content,
      content,
      mode: info.mode & 0o777,
      replacements: 0,
    },
  };
}
