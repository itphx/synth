import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, toolRoots, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { sniffBinary } from './fs-read.js';
import { MAX_TOOL_FILE_BYTES } from './file-limits.js';
import { detectLineEndings, fromLfView, toLfView } from './line-endings.js';
import { writeFileAtomic } from './atomic-file-write.js';

export function generateUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [];

  result.push(`--- a/${filePath}`);
  result.push(`+++ b/${filePath}`);

  const eq = longestCommonSubsequence(oldLines, newLines);
  let oi = 0; let ni = 0;
  for (let i = 0; i < eq.length; i++) {
    const entry = eq[i]!;
    const targetOld = entry[0];
    const targetNew = entry[1];
    if (oi < targetOld || ni < targetNew) {
      result.push(`@@ -${oi + 1},${targetOld - oi} +${ni + 1},${targetNew - ni} @@`);
      for (let j = oi; j < targetOld; j++) result.push(`-${oldLines[j]}`);
      for (let j = ni; j < targetNew; j++) result.push(`+${newLines[j]}`);
    }
    result.push(` ${oldLines[targetOld]}`);
    oi = targetOld + 1;
    ni = targetNew + 1;
  }
  if (oi < oldLines.length || ni < newLines.length) {
    result.push(`@@ -${oi + 1},${oldLines.length - oi} +${ni + 1},${newLines.length - ni} @@`);
    for (let j = oi; j < oldLines.length; j++) result.push(`-${oldLines[j]}`);
    for (let j = ni; j < newLines.length; j++) result.push(`+${newLines[j]}`);
  }

  return result.join('\n');
}

function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const m = a.length; const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prevRow = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1] ? (prevRow[j - 1] ?? 0) + 1 : Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
    }
  }

  const result: [number, number][] = [];
  let i = m; let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift([i - 1, j - 1]); i--; j--; }
    else if ((dp[i - 1]![j] ?? 0) > (dp[i]![j - 1] ?? 0)) i--;
    else j--;
  }
  return result;
}

/**
 * Коды отказов файловых тулов — единый контракт `content` + `metadata.i18n`
 * (ADR-041): текст для модели (en) и шаблон с параметрами для UI.
 */
type FsToolErrorKey =
  | 'fs.no_changes'
  | 'fs.empty_old_string'
  | 'fs.mixed_line_endings'
  | 'fs.edit_binary'
  | 'fs.write_binary'
  | 'fs.file_too_large';

function fsErrorResult(
  key: FsToolErrorKey,
  params: Record<string, string>,
  metadata: Record<string, unknown> = {},
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...metadata, i18n: i18nMeta(key, params) },
  };
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically. '
    + 'Overwriting an existing binary file is refused — use another tool for binary data. '
    + 'Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    file_path: z.string().describe('Path to the file to write (absolute or relative to the working directory)'),
    content: z.string().describe('Content to write to the file'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { file_path: string; content: string };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    // ADR-036: деобфускация в точке потребления — контент может содержать ⟦SYNTH_SECRET_N⟧
    const content = await deobfuscateText(ctx, params.content);

    // Предел объёма: содержимое держится в памяти целиком.
    if (Buffer.byteLength(content, 'utf-8') > MAX_TOOL_FILE_BYTES) {
      return fsErrorResult(
        'fs.file_too_large',
        { limit: String(MAX_TOOL_FILE_BYTES) },
        { path: resolvedPath, limit: MAX_TOOL_FILE_BYTES },
      );
    }

    // Перезапись бинарного файла текстом — отказ (файл не читается как текст,
    // а «текст» в бинаре всё равно ломает его структуру).
    const existing = await stat(resolvedPath).catch(() => null);
    if (existing?.isFile() && (await sniffBinary(resolvedPath))) {
      return fsErrorResult('fs.write_binary', { path: params.file_path }, { path: resolvedPath });
    }

    const dir = dirname(resolvedPath);
    await mkdir(dir, { recursive: true });
    // Права существующего файла сохраняются (tmp → rename иначе создал бы
    // файл с правами по умолчанию).
    const mode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    await writeFileAtomic(resolvedPath, content, mode);

    const lines = content.split('\n');
    return {
      content: sm('fs.file_written', { path: params.file_path, lines: String(lines.length), bytes: String(content.length) }),
      metadata: {
        path: resolvedPath,
        lines: lines.length,
        bytes: content.length,
        i18n: i18nMeta('fs.file_written', { path: params.file_path, lines: String(lines.length), bytes: String(content.length) }),
      },
    };
  },
};

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Make exact string replacements in a file. The edit will FAIL if old_string is not unique in the file. '
    + 'read_file prefixes every line with its number ("N: "); that prefix is for reading only — never include it in old_string or new_string. '
    + 'If the match is ambiguous, provide more surrounding context (or use replace_all). '
    + 'Line endings of the file are preserved: an LF file is edited as is, a CRLF file is matched in LF view and written back as CRLF, '
    + 'a file with mixed line endings is refused. '
    + 'Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    file_path: z.string().describe('Path to the file to modify (absolute or relative to the working directory)'),
    old_string: z.string().describe('Text to replace (must be unique in file)'),
    new_string: z.string().describe('Text to replace it with'),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { file_path: string; old_string: string; new_string: string; replace_all?: boolean };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    // ADR-036: деобфускация в точке потребления — текст патча может содержать ⟦SYNTH_SECRET_N⟧
    const oldString = await deobfuscateText(ctx, params.old_string);
    const newString = await deobfuscateText(ctx, params.new_string);

    // Отказы до чтения файла: правка «сама в себя» и пустой old_string
    // (при replace_all он вставляет текст между каждым символом — порча файла).
    if (oldString === newString) {
      return fsErrorResult('fs.no_changes', {}, { path: resolvedPath });
    }
    if (oldString === '') {
      return fsErrorResult('fs.empty_old_string', {}, { path: resolvedPath });
    }

    const info = await stat(resolvedPath).catch(() => null);
    if (info && info.size > MAX_TOOL_FILE_BYTES) {
      return fsErrorResult(
        'fs.file_too_large',
        { limit: String(MAX_TOOL_FILE_BYTES) },
        { path: resolvedPath, bytes: info.size, limit: MAX_TOOL_FILE_BYTES },
      );
    }
    if (await sniffBinary(resolvedPath)) {
      return fsErrorResult('fs.edit_binary', { path: params.file_path }, { path: resolvedPath });
    }

    const raw = await readFile(resolvedPath, 'utf-8');
    const style = detectLineEndings(raw);
    if (style === 'mixed') {
      return fsErrorResult('fs.mixed_line_endings', {}, { path: resolvedPath });
    }

    // CRLF-файл правим в LF-виде (текст из `read_file` приходит с LF) и
    // возвращаем CRLF — файл не теряет ни одного `\r\n`.
    const crlf = style === 'crlf';
    const content = crlf ? toLfView(raw) : raw;
    const oldView = crlf ? toLfView(oldString) : oldString;
    const newView = crlf ? toLfView(newString) : newString;

    const occurrences = content.split(oldView).length - 1;
    if (occurrences === 0) {
      return { content: sm('fs.replace_not_found', { path: params.file_path }), isError: true, metadata: { i18n: i18nMeta('fs.replace_not_found', { path: params.file_path }) } };
    }
    const replaceAll = params.replace_all === true;
    if (occurrences > 1 && !replaceAll) {
      return {
        content: sm('fs.replace_multiple', { count: String(occurrences) }),
        isError: true,
        metadata: { i18n: i18nMeta('fs.replace_multiple', { count: String(occurrences) }) },
      };
    }

    const newContent = replaceAll
      ? content.replaceAll(oldView, newView)
      : content.replace(oldView, newView);
    const written = crlf ? fromLfView(newContent) : newContent;
    const mode = info ? info.mode & 0o777 : undefined;
    await writeFileAtomic(resolvedPath, written, mode);

    const diff = generateUnifiedDiff(content, newContent, params.file_path);
    const count = replaceAll ? occurrences : 1;
    return {
      content: sm('fs.file_edited', { path: params.file_path, count: String(count) }),
      metadata: {
        path: resolvedPath,
        replacements: count,
        diff,
        i18n: i18nMeta('fs.file_edited', { path: params.file_path, count: String(count) }),
      },
    };
  },
};

export const createDirectoryTool: ToolDefinition = {
  name: 'create_directory',
  description: 'Create a new directory. Creates parent directories as needed. Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    path: z.string().describe('Path to the directory to create (absolute or relative to the working directory)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { path: string };
    validateInputPath(params.path, 'path');
    const resolvedPath = resolvePath(params.path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    await mkdir(resolvedPath, { recursive: true });
    return {
      content: sm('fs.dir_created', { path: params.path }),
      metadata: { path: resolvedPath, i18n: i18nMeta('fs.dir_created', { path: params.path }) },
    };
  },
};

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file at the specified path. Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    file_path: z.string().describe('Path to the file to delete (absolute or relative to the working directory)'),
  }),
  capabilities: [ToolCapability.FILE_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { file_path: string };
    validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    await rm(resolvedPath, { force: false });
    return {
      content: sm('fs.file_deleted', { path: params.file_path }),
      metadata: { path: resolvedPath, i18n: i18nMeta('fs.file_deleted', { path: params.file_path }) },
    };
  },
};
