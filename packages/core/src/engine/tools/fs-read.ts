import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, toolRoots, pathEscapesWorkspaceResult, isIgnoredSearchPath } from './path-utils.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import { DEFAULT_MAX_OUTPUT_BYTES, isExecutionError, type ExecutionError } from '../../execution/ports/index.js';
import { SEARCH_TIMEOUT_MS, classifySearchPath, searchPathErrorResult } from './search.js';
import { MAX_LINE_LENGTH, clampLine } from './line-limits.js';
import { sniffMime } from '../attachments/sniff-mime.js';
import { ingestMediaFile, isIngestibleMediaMime } from './fs-read-media.js';

/**
 * Пределы `read_file` — паритет с opencode
 * (`packages/core/src/tool/read-filesystem.ts`: `MAX_READ_LINES`/`MAX_READ_BYTES`/
 * `MAX_LINE_LENGTH`). Каталог читается теми же пределами (строк = записей).
 */
export const MAX_READ_LINES = 2_000;
export const MAX_READ_BYTES = 50 * 1024;
/**
 * Максимальная длина одной возвращаемой строки — общая константа с поисковыми
 * тулами (`line-limits.ts`; прежде константа жила только здесь).
 */
export { MAX_LINE_LENGTH };
/** Сколько первых байт смотрим, чтобы отличить бинарь от текста. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Доля непечатных байт, при которой файл считается бинарным. */
const BINARY_NON_PRINTABLE_RATIO = 0.3;

/** `glob`: сколько путей возвращать по умолчанию и максимум. */
export const DEFAULT_GLOB_LIMIT = 100;
export const MAX_GLOB_LIMIT = 1_000;

interface DirectoryPage {
  lines: string[];
  /** Всего записей в каталоге (не только попавших в страницу). */
  totalEntries: number;
  truncated: boolean;
}

/**
 * Страница листинга каталога: сначала каталоги, потом файлы, внутри группы —
 * по имени; у записей есть размер. `offset` — 0-based, `limit` — записей.
 *
 * Общая точка для `read_file` (путь-каталог) и `list_directory`, чтобы два
 * листинга не расходились по формату и порядку.
 */
async function listDirectoryPage(dirPath: string, offset: number, limit: number): Promise<DirectoryPage> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of sorted.slice(offset)) {
    if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
      truncated = true;
      break;
    }
    const fullPath = join(dirPath, entry.name);
    const suffix = entry.isDirectory() ? '/' : '';
    let text: string;
    try {
      const info = await stat(fullPath);
      text = `${entry.name}${suffix} (${info.size} bytes)`;
    } catch {
      text = `${entry.name}${suffix}`;
    }
    const size = Buffer.byteLength(text, 'utf-8') + (lines.length > 0 ? 1 : 0);
    if (bytes + size > MAX_READ_BYTES) {
      truncated = true;
      break;
    }
    lines.push(text);
    bytes += size;
  }

  return { lines, totalEntries: sorted.length, truncated };
}

/**
 * Похож ли буфер на бинарный: NUL-байт или высокая доля непечатных символов.
 * Байты ≥ 0x80 — это UTF-8 (кириллица и т.п.), они печатные.
 */
function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of buf) {
    if (byte === 0) return true;
    // \t (9), \n (10), \r (13) — обычный текст
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) nonPrintable++;
  }
  return nonPrintable / buf.length > BINARY_NON_PRINTABLE_RATIO;
}

/** Первые `BINARY_SNIFF_BYTES` байт файла → признак «это бинарь». */
export async function sniffBinary(filePath: string): Promise<boolean> {
  return (await sniffFileHead(filePath)).binary;
}

/**
 * Первые `BINARY_SNIFF_BYTES` байт файла: признак «бинарь» **и** MIME по
 * сигнатуре (ADR-115).
 *
 * Один проход вместо двух: `read_file` по тем же байтам решает, читать файл
 * как текст, отказать («бинарь») или принять как медиа-вложение (картинка/PDF).
 * MIME — тем же детектором, что у сервиса вложений (`attachments/sniff-mime.ts`),
 * второго определения MIME в ядре нет.
 */
async function sniffFileHead(filePath: string): Promise<{ binary: boolean; mime?: string }> {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    const head = buf.subarray(0, bytesRead);
    return { binary: looksBinary(head), mime: sniffMime(head) };
  } finally {
    await handle.close();
  }
}

/** Обрезка слишком длинной строки с маркером (в вывод не уходит «простыня»). */
function clampReadLine(line: string): string {
  return clampLine(line, sm('fsread.line_truncated'));
}

interface TextPage {
  /** Строки вывода с исходной 1-based нумерацией (`N: текст`). */
  lines: string[];
  totalLines: number;
  truncated: boolean;
  /** Размер вывода в байтах (UTF-8). */
  bytes: number;
}

/**
 * Страница текстового файла: читаем потоком через `readline` — в память не
 * поднимается всё содержимое даже большого файла. `offset` — 0-based,
 * нумерация строк в выводе — исходная 1-based (первая строка страницы имеет
 * номер `offset + 1`).
 *
 * `totalLines` считаем тем же проходом до EOF (счётчик, без хранения строк):
 * метаданные честно сообщают размер файла, а память остаётся постоянной.
 */
async function readTextPage(filePath: string, offset: number, limit: number): Promise<TextPage> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  let lineNo = 0;
  let totalLines = 0;
  let bytes = 0;
  let truncated = false;

  try {
    for await (const raw of rl) {
      lineNo += 1;
      totalLines = lineNo;
      if (lineNo <= offset) continue;
      if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
        truncated = true;
        continue;
      }
      const text = clampReadLine(raw);
      const line = `${lineNo}: ${text}`;
      const size = Buffer.byteLength(line, 'utf-8') + (lines.length > 0 ? 1 : 0);
      if (bytes + size > MAX_READ_BYTES) {
        truncated = true;
        continue;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { lines, totalLines, truncated, bytes };
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read the contents of a file or directory. Each text line is prefixed by its 1-based line number as "N: <content>"; '
    + 'the prefix is for reference only and is not part of the file content. '
    + 'Binary files are not decoded: images and PDFs are attached to the current turn (the model sees them), '
    + 'for other binary files use execute_shell with file/xxd to inspect the bytes. '
    + `Defaults to and is capped at ${MAX_READ_LINES} lines and ${MAX_READ_BYTES / 1024} KB of output; long lines are truncated. `
    + 'Use offset and limit to read large files or directories in sections. '
    + 'Prefer one larger read over many small slices, and use grep_files to find specific content in large files. '
    + 'Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    file_path: z.string().optional().describe('Path to the file or directory to read (absolute or relative to the working directory; defaults to working directory)'),
    offset: z.number().int().min(0).optional().describe('Line or directory entry to start reading from (0-based)'),
    limit: z.number().int().min(1).optional().describe(`Maximum number of lines or directory entries to read (defaults to and capped at ${MAX_READ_LINES})`),
  }),
  capabilities: [ToolCapability.FILE_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { file_path?: string; offset?: number; limit?: number };
    if (params.file_path !== undefined) validateInputPath(params.file_path, 'file_path');
    const resolvedPath = resolvePath(params.file_path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    const offset = params.offset ?? 0;
    const limit = Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES);
    const info = await stat(resolvedPath);

    // Каталог: отдаём листинг (те же правила, что у list_directory), а не ошибку чтения.
    if (info.isDirectory()) {
      const page = await listDirectoryPage(resolvedPath, offset, limit);
      const lines = [...page.lines];
      // Следующий offset — продолжение чтения без повторного обхода файла.
      const nextOffset = offset + lines.length;
      let truncationNote: string | undefined;
      if (page.truncated) {
        truncationNote = sm('fsread.directory_truncated', { count: String(page.lines.length), next: String(nextOffset) });
        lines.push(truncationNote);
      }
      return {
        content: lines.join('\n') || sm('fsread.empty_directory'),
        metadata: {
          path: resolvedPath,
          type: 'directory',
          totalEntries: page.totalEntries,
          offset,
          limit,
          truncated: page.truncated,
          // Маркер усечения — текстом: общий бунд вывода возвращает его в
          // конец, если срежет хвост (см. `tool-execution.ts`).
          ...(truncationNote ? { truncationNote } : {}),
          nextOffset,
          bytes: Buffer.byteLength(lines.join('\n'), 'utf-8'),
        },
      };
    }

    // ADR-115: картинка/PDF — не текст: отдаём файл модели как вложение текущего
    // хода (ссылка в `ToolResult.attachments` → `_injectToolAttachments`).
    // MIME — по сигнатуре (тот же детектор, что у сервиса вложений).
    const head = await sniffFileHead(resolvedPath);
    const displayPath = params.file_path ?? resolvedPath;
    if (head.mime && isIngestibleMediaMime(head.mime)) {
      const outcome = await ingestMediaFile({ ctx, resolvedPath, size: info.size });
      if (outcome.kind === 'attached') {
        return {
          content: `${sm('attach.tool.attached', { path: displayPath })} (${outcome.mime}, ${outcome.size} bytes)`,
          metadata: {
            i18n: i18nMeta('attach.tool.attached', { path: displayPath }),
            path: resolvedPath,
            type: 'media',
            mime: outcome.mime,
            size: outcome.size,
            blob_path: outcome.ref.blobPath,
            ...(outcome.name ? { name: outcome.name } : {}),
          },
          attachments: [outcome.ref],
        };
      }
      // Отказ — не падение. Вложения выключены (или сервиса нет) и файл не
      // прочитался → прежняя ошибка с подсказкой; лимит и запрещённый MIME →
      // понятная причина.
      if (outcome.reason === 'too_large') {
        const limit = String(outcome.limit);
        return {
          content: sm('attach.tool.too_large', { path: displayPath, size: String(info.size), limit }),
          isError: true,
          metadata: {
            i18n: i18nMeta('attach.tool.too_large', { path: displayPath, size: String(info.size), limit }),
            path: resolvedPath,
            type: 'media',
            reason: 'too_large',
            size: info.size,
            limit: outcome.limit,
          },
        };
      }
      if (outcome.reason === 'unsupported_mime') {
        return {
          content: sm('attach.tool.unsupported_mime', { path: displayPath, detail: outcome.detail }),
          isError: true,
          metadata: {
            i18n: i18nMeta('attach.tool.unsupported_mime', { path: displayPath, detail: outcome.detail }),
            path: resolvedPath,
            type: 'media',
            reason: 'unsupported_mime',
            mime: head.mime,
          },
        };
      }
      // Вложения выключены / файл не прочитался — прежнее поведение
      // `read_file` (подсказка в тексте).
      return {
        content: sm('fsread.binary', { path: displayPath }),
        isError: true,
        metadata: { path: resolvedPath, type: 'binary', i18n: i18nMeta('fsread.binary', { path: displayPath }) },
      };
    }

    if (head.binary) {
      // Бинарный файл модели как текст не отдаём: «кракозябры» бесполезны и
      // занимают бюджет контекста. Подсказываем правильный инструмент.
      return {
        content: sm('fsread.binary', { path: displayPath }),
        isError: true,
        metadata: { path: resolvedPath, type: 'binary', i18n: i18nMeta('fsread.binary', { path: displayPath }) },
      };
    }

    const page = await readTextPage(resolvedPath, offset, limit);
    const lines = [...page.lines];
    // Следующий offset — продолжение чтения без повторного обхода файла.
    const nextOffset = offset + lines.length;
    let truncationNote: string | undefined;
    if (page.truncated) {
      truncationNote = sm('fsread.truncated', { count: String(page.lines.length), next: String(nextOffset) });
      lines.push(truncationNote);
    }

    // Пустой файл и `offset` за концом — разные случаи: пустой говорит сам за
    // себя, для второго подсказываем фактическое число строк.
    const content = lines.join('\n')
      || (page.totalLines === 0
        ? sm('fsread.empty_file')
        : sm('fsread.offset_out_of_range', { offset: String(offset), total: String(page.totalLines) }));

    return {
      content,
      metadata: {
        path: resolvedPath,
        type: 'file',
        totalLines: page.totalLines,
        offset,
        limit,
        truncated: page.truncated,
        // Маркер усечения — текстом: общий бунд вывода возвращает его в
        // конец, если срежет хвост (см. `tool-execution.ts`).
        ...(truncationNote ? { truncationNote } : {}),
        nextOffset,
        bytes: page.bytes,
      },
    };
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description:
    'List files and directories in a given path. Use this to explore the project structure. '
    + `Returns at most ${MAX_READ_LINES} entries by default (limit up to ${MAX_READ_LINES}); use offset and limit to page through large directories. `
    + 'Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    path: z.string().optional().describe('Path to the directory to list (absolute or relative to the working directory; defaults to working directory)'),
    offset: z.number().int().min(0).optional().describe('Directory entry to start listing from (0-based)'),
    limit: z.number().int().min(1).optional()
      .describe(`Maximum number of directory entries to list (defaults to and capped at ${MAX_READ_LINES})`),
  }),
  capabilities: [ToolCapability.FILE_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { path?: string; offset?: number; limit?: number };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const resolvedPath = resolvePath(params.path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), resolvedPath)) return pathEscapesWorkspaceResult(resolvedPath);

    const offset = params.offset ?? 0;
    const limit = Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES);
    const page = await listDirectoryPage(resolvedPath, offset, limit);
    const lines = [...page.lines];
    // Следующий offset — продолжение листинга без повторного обхода каталога.
    const nextOffset = offset + lines.length;
    let truncationNote: string | undefined;
    if (page.truncated) {
      truncationNote = sm('fsread.directory_truncated', { count: String(page.lines.length), next: String(nextOffset) });
      lines.push(truncationNote);
    }

    return {
      content: lines.join('\n') || sm('fsread.empty_directory'),
      metadata: {
        path: resolvedPath,
        count: page.totalEntries,
        offset,
        limit,
        truncated: page.truncated,
        // Маркер усечения — текстом: общий бунд вывода возвращает его в
        // конец, если срежет хвост (см. `tool-execution.ts`).
        ...(truncationNote ? { truncationNote } : {}),
        nextOffset,
      },
    };
  },
};

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). Returns matching paths relative to the search directory, sorted by name. '
    + `Returns at most ${DEFAULT_GLOB_LIMIT} paths by default (limit up to ${MAX_GLOB_LIMIT}); hidden files are skipped unless hidden=true and .git is always excluded. `
    + 'Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.',
  parameters: z.object({
    pattern: z.string().describe('Glob pattern to match files against (e.g., "src/**/*.ts")'),
    path: z.string().optional().describe('Directory to search in (absolute or relative to the working directory; defaults to working directory)'),
    hidden: z.boolean().optional().describe('Include hidden files and directories (default: false)'),
    limit: z.number().int().min(1).max(MAX_GLOB_LIMIT).optional()
      .describe(`Maximum number of matching files to return (default: ${DEFAULT_GLOB_LIMIT}, max: ${MAX_GLOB_LIMIT})`),
  }),
  capabilities: [ToolCapability.FILE_READ, ToolCapability.SEARCH],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as { pattern: string; path?: string; hidden?: boolean; limit?: number };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const searchDir = resolvePath(params.path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), searchDir)) return pathEscapesWorkspaceResult(searchDir);

    // Путь проверяем до запуска `rg`: каталог поиска — это `cwd` процесса,
    // поэтому «путь не найден» и «путь не каталог» — разные причины с
    // разными подсказками (общий «(file search error)» модели ничего не
    // объяснял).
    const pathState = await classifySearchPath(searchDir);
    if (pathState === 'missing') return searchPathErrorResult('search.path_not_found', params.path ?? searchDir);
    if (pathState !== 'directory') {
      return searchPathErrorResult('search.path_not_directory', params.path ?? searchDir);
    }

    const limit = Math.min(params.limit ?? DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);

    // Поиск — через `rg --files` (как opencode): учитывает .gitignore, отдаёт
    // пути относительно `cwd`. Скрытые — только по запросу; `.git` не сыплем.
    // `--no-config` — пользовательский `RIPGREP_CONFIG_PATH` не должен менять
    // поведение тула (иначе чужие флаги/маски ломают выдачу).
    const rgArgs = ['--files', '--color', 'never', '--no-config'];
    if (params.hidden) rgArgs.push('--hidden');
    rgArgs.push('--glob', params.pattern, '--glob', '!.git/**');

    try {
      const { stdout } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'argv', file: 'rg', args: rgArgs },
        // ADR-077: бинарное требование тула (`rg`) — в remote-режиме команда
        // уходит в адрес пула, где ripgrep есть.
        requires: toolRuntimeRequires('glob'),
        cwd: searchDir,
        timeoutMs: SEARCH_TIMEOUT_MS,
        // «Стоп» (toolAbortController.abort) убивает процесс SIGTERM
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      // Сортировка по имени: обход `rg` не детерминирован, а модели нужен
      // стабильный порядок (раньше описание обещало сортировку по mtime — это
      // было неправдой). Служебные пути (`.git`, скрытые без `hidden`) —
      // отсекаем сами: маска `--glob` перекрывает скрытие рипгрепа.
      const hidden = params.hidden === true;
      const files = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((path) => !isIgnoredSearchPath(path, hidden))
        .sort();
      const selected = files.slice(0, limit);
      const truncated = files.length > limit;

      const lines = [...selected];
      let truncationNote: string | undefined;
      if (truncated) {
        truncationNote = sm('fsread.glob_truncated', { count: String(selected.length), total: String(files.length) });
        lines.push(truncationNote);
      }

      return {
        content: lines.length > 0 ? lines.join('\n') : sm('fsread.no_files'),
        metadata: {
          pattern: params.pattern,
          count: selected.length,
          total: files.length,
          truncated,
          // Маркер усечения — текстом: общий бунд вывода возвращает его в
          // конец, если срежет хвост (см. `tool-execution.ts`).
          ...(truncationNote ? { truncationNote } : {}),
          ...(selected.length === 0 ? { i18n: i18nMeta('fsread.no_files') } : {}),
        },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка поиска»
      if (isAborted(ctx)) return abortedResult(this.name);
      const execError = err as ExecutionError;
      // rg: код 1 — «файлов не найдено», это не ошибка
      if (execError.code === 1) {
        return {
          content: sm('fsread.no_files'),
          metadata: { pattern: params.pattern, count: 0, total: 0, i18n: i18nMeta('fsread.no_files') },
        };
      }
      // Таймаут — actionable-текст (подсказка сузить поиск), не «ошибка поиска».
      if (isExecutionError(err) && err.reason === 'timeout') {
        return {
          content: sm('tool.search_timeout', { seconds: String(SEARCH_TIMEOUT_MS / 1000) }),
          isError: true,
          metadata: {
            pattern: params.pattern,
            reason: 'timeout',
            timeoutMs: SEARCH_TIMEOUT_MS,
            i18n: i18nMeta('tool.search_timeout', { seconds: String(SEARCH_TIMEOUT_MS / 1000) }),
          },
        };
      }
      // ripgrep не установлен в окружении исполнения — общий ключ тулов
      // (`tool.binary_missing`), а не «(file search error)».
      if (execError.code === 'ENOENT' || execError.code === 127) {
        const missingParams = { tool: this.name, binary: 'rg' };
        return {
          content: sm('tool.binary_missing', missingParams),
          isError: true,
          metadata: { pattern: params.pattern, i18n: i18nMeta('tool.binary_missing', missingParams) },
        };
      }
      // Каталог поиска перестал быть каталогом между проверкой и запуском.
      if (execError.code === 'ENOTDIR') {
        return searchPathErrorResult('search.path_not_directory', params.path ?? searchDir);
      }
      return {
        content: sm('fsread.glob_error'),
        isError: true,
        metadata: { pattern: params.pattern, i18n: i18nMeta('fsread.glob_error') },
      };
    }
  },
};
