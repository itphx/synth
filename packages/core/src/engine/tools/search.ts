import { z } from 'zod';
import { isAbsolute, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, toolRoots, pathEscapesWorkspaceResult, isIgnoredSearchPath } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import { DEFAULT_MAX_OUTPUT_BYTES, isExecutionError, type ExecutionError } from '../../execution/ports/index.js';

/** `grep_files`: сколько строк совпадений отдавать по умолчанию и максимум. */
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 1_000;

/**
 * Предел времени поиска (`grep_files`/`glob`), мс.
 *
 * Предел фиксированный: поиск — быстрая операция, а увеличение лимита
 * усложнило бы конфиг без практической пользы. При истечении модель получает
 * actionable-текст (`tool.search_timeout`) с подсказкой сузить поиск, а не
 * «ошибку поиска».
 */
export const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Состояние пути поиска — проверяется до запуска `rg`.
 *
 * - `directory` — обычный каталог поиска;
 * - `file` — путь указывает на файл: для `grep_files` это допустимая цель
 *   (ripgrep ищет внутри файла), для `glob` — нет (там путь это `cwd`);
 * - `missing` — пути нет (`ENOENT`);
 * - `not_directory` — путь не каталог: компонент пути оказался файлом
 *   (`ENOTDIR`, например `dir/file.txt/sub`).
 */
export type SearchPathState = 'directory' | 'file' | 'missing' | 'not_directory';

/**
 * Классификация пути поиска.
 *
 * Нужна, чтобы отказ поиска был actionable: «путь не найден» и «путь не
 * каталог» — разные причины с разными подсказками, а не общий
 * «(file search error)».
 */
export async function classifySearchPath(searchDir: string): Promise<SearchPathState> {
  try {
    const info = await stat(searchDir);
    return info.isDirectory() ? 'directory' : 'file';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOTDIR' ? 'not_directory' : 'missing';
  }
}

/** Ключи отказа поиска, связанные с путём. */
type SearchPathErrorKey = 'search.path_not_found' | 'search.path_not_directory';

/** Отказ поиска из-за пути (не найден / не каталог) — с подсказкой в metadata. */
export function searchPathErrorResult(key: SearchPathErrorKey, path: string): ToolResult {
  const params = { path };
  return {
    content: sm(key, params),
    isError: true,
    metadata: { path, i18n: i18nMeta(key, params) },
  };
}

/** Одно совпадение поиска (`grep_files`). */
interface GrepMatch {
  /** Файл совпадения (путь, как его отдал ripgrep). */
  file: string;
  /** Номер строки (1-based). */
  line: number;
  /** Текст строки. */
  text: string;
}

/** Совпадения одного файла — группа вывода. */
interface GrepGroup {
  /** Путь для вывода (относительный). */
  path: string;
  /** Совпадения файла (по возрастанию номера строки). */
  matches: GrepMatch[];
}

/**
 * Разбор строки результата `rg` (`path:line:text`).
 *
 * Особый случай: если цель поиска — один файл, ripgrep не печатает путь
 * (`line:text`) — тогда файл известен заранее (`searchDir`). Этот разбор идёт
 * первым: иначе двоеточие с цифрами в самом тексте (`12:30`) приняли бы за
 * разделитель `путь:строка`.
 */
function parseMatchLine(raw: string, searchDir: string, singleFile: boolean): GrepMatch | null {
  if (singleFile) {
    const withoutPath = /^(\d+):([\s\S]*)$/.exec(raw);
    if (!withoutPath) return null;
    return { file: searchDir, line: Number(withoutPath[1]), text: withoutPath[2] ?? '' };
  }
  const withPath = /^(.*?):(\d+):([\s\S]*)$/.exec(raw);
  if (!withPath) return null;
  const file = withPath[1] ?? '';
  const line = Number(withPath[2]);
  if (file === '' || !Number.isInteger(line)) return null;
  return { file, line, text: withPath[3] ?? '' };
}

/**
 * Путь файла для вывода: относительно рабочего каталога, если файл внутри
 * него, иначе — относительно каталога поиска.
 */
function displayPath(file: string, searchDir: string, workingDir: string): string {
  const fromWorking = relative(workingDir, file);
  if (fromWorking !== '' && !fromWorking.startsWith('..') && !isAbsolute(fromWorking)) return fromWorking;
  const fromSearch = relative(searchDir, file);
  return fromSearch !== '' ? fromSearch : file;
}

/**
 * Группировка совпадений по файлу (как в opencode): сначала путь, затем
 * строки совпадений. Порядок детерминированный — файлы по имени, внутри
 * файла — по номеру строки (ripgrep обходит дерево параллельно, порядок
 * вывода не гарантирован).
 */
function groupMatches(matches: GrepMatch[], searchDir: string, workingDir: string): GrepGroup[] {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.file);
    if (list) list.push(match);
    else byFile.set(match.file, [match]);
  }
  const groups: GrepGroup[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.line - b.line);
    groups.push({ path: displayPath(file, searchDir, workingDir), matches: list });
  }
  groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return groups;
}

/** Текстовый вывод групп: `path:` + `  Line N: text` на каждое совпадение. */
function formatGroups(groups: GrepGroup[]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    out.push(`${group.path}:`);
    for (const match of group.matches) out.push(`  Line ${match.line}: ${match.text}`);
  }
  return out;
}

export const grepFilesTool: ToolDefinition = {
  name: 'grep_files',
  description:
    `Search file contents using ripgrep's regular expression syntax or literal text matching (literal=true). Returns matching lines grouped by file (a path line, then "  Line N: text" per match); narrow the search with path or include. Returns at most ${DEFAULT_SEARCH_LIMIT} matching lines by default (limit up to ${MAX_SEARCH_LIMIT}). Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.`,
  parameters: z.object({
    pattern: z.string().describe('The regex pattern (or literal text with literal=true) to search for in file contents'),
    path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
    include: z.string().optional().describe('File pattern filter (e.g., "*.ts", "*.{ts,tsx}")'),
    literal: z.boolean().optional().describe('Treat pattern as exact text instead of a regular expression (default: false)'),
    caseSensitive: z.boolean().optional().describe('Use case-sensitive matching (default: true; false → case-insensitive)'),
    hidden: z.boolean().optional().describe('Search hidden files and directories (default: false; .git is always excluded)'),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
      .describe(`Maximum number of matching lines to return (default: ${DEFAULT_SEARCH_LIMIT}, max: ${MAX_SEARCH_LIMIT})`),
  }),
  capabilities: [ToolCapability.SEARCH],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — поиск не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as {
      pattern: string;
      path?: string;
      include?: string;
      literal?: boolean;
      caseSensitive?: boolean;
      hidden?: boolean;
      limit?: number;
    };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const searchDir = resolvePath(params.path, ctx.workingDir);
    if (isSymlinkEscapeInRoots(toolRoots(ctx), searchDir)) return pathEscapesWorkspaceResult(searchDir);

    // Путь проверяем до запуска `rg`: «путь не найден» и «путь не каталог» —
    // разные причины, у каждой своя подсказка (иначе модель получает общий
    // «(file search error)» и не понимает, что исправлять).
    const pathState = await classifySearchPath(searchDir);
    if (pathState === 'missing') return searchPathErrorResult('search.path_not_found', params.path ?? searchDir);
    if (pathState === 'not_directory') {
      return searchPathErrorResult('search.path_not_directory', params.path ?? searchDir);
    }

    // ADR-036: деобфускация в точке потребления — паттерн может содержать ⟦SYNTH_SECRET_N⟧
    const pattern = await deobfuscateText(ctx, params.pattern);
    const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const hidden = params.hidden === true;
    // Цель поиска — один файл: ripgrep тогда не печатает путь в строке вывода.
    const singleFile = pathState === 'file';

    try {
      // Один `-n` (раньше флаг дублировался как `--line-number` и `-n`)
      const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--no-config'];

      if (params.literal) rgArgs.push('--fixed-strings');
      // Явное указание регистра: по умолчанию ripgrep «умный» (smart-case),
      // а тул обещает строгий регистр, пока не задано caseSensitive: false.
      rgArgs.push(params.caseSensitive === false ? '-i' : '--case-sensitive');

      if (params.hidden) rgArgs.push('--hidden', '--glob', '!.git/**');

      if (params.include) {
        for (const g of params.include.split(',').map((s) => s.trim()).filter(Boolean)) {
          rgArgs.push('--glob', g);
        }
      }

      // `--` отделяет паттерн от флагов: шаблон, начинающийся с `-`, не должен
      // приниматься за опцию ripgrep (паритет с opencode).
      rgArgs.push('--', pattern, searchDir);

      // ADR-077: исполнение — через порт (inline-реализация повторяет
      // прежний `execFile('rg', …)`: argv без shell, таймаут 30 с,
      // maxBuffer 10 МБ, базовое окружение — `process.env`).
      const { stdout } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'argv', file: 'rg', args: rgArgs },
        // ADR-077: бинарное требование тула (`rg`) — в remote-режиме команда
        // уходит в адрес пула, где ripgrep есть.
        requires: toolRuntimeRequires('grep_files'),
        timeoutMs: SEARCH_TIMEOUT_MS,
        // «Стоп» (toolAbortController.abort) убивает процесс SIGTERM
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      const matches: GrepMatch[] = [];
      for (const raw of stdout.split('\n')) {
        if (!raw) continue;
        const match = parseMatchLine(raw, searchDir, singleFile);
        if (!match) continue;
        // Служебные пути (`.git`, скрытые без `hidden`) отсекаем по сегментам
        // пути относительно каталога поиска: маска `--glob` перекрывает
        // скрытие рипгрепа, а негативный `--glob '!.git/**'` матчится
        // относительно cwd процесса, а не пути поиска. Явно названный файл
        // (цель поиска) не фильтруется — его запросили самим.
        if (!singleFile && isIgnoredSearchPath(relative(searchDir, match.file), hidden)) continue;
        matches.push(match);
      }

      const groups = groupMatches(matches, searchDir, ctx.workingDir);
      const total = groups.reduce((sum, group) => sum + group.matches.length, 0);

      if (total > limit) {
        // Лимит — общий по строкам совпадений, а не «200 на файл»
        const shown: GrepGroup[] = [];
        let remaining = limit;
        for (const group of groups) {
          if (remaining <= 0) break;
          const taken = group.matches.slice(0, remaining);
          shown.push({ path: group.path, matches: taken });
          remaining -= taken.length;
        }
        const truncated = formatGroups(shown);
        truncated.push(sm('search.matches_truncated', { shown: String(limit), total: String(total) }));
        return {
          content: truncated.join('\n'),
          metadata: { pattern: params.pattern, matches: total, truncated: true },
        };
      }

      return {
        content: groups.length > 0 ? formatGroups(groups).join('\n') : sm('search.no_matches'),
        metadata: { pattern: params.pattern, matches: total },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка поиска»
      if (isAborted(ctx)) return abortedResult(this.name);
      const execError = err as ExecutionError;
      if (execError.code === 1) {
        return { content: sm('search.no_matches'), metadata: { pattern: params.pattern, matches: 0 } };
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
      // Невалидный regex — отдельная причина: модель должна исправить шаблон
      // (иначе она видит «Search error» и не понимает, что именно сломано).
      if (execError.stderr && /regex parse error|error parsing regex/i.test(execError.stderr)) {
        const detail = execError.stderr.trim().replace(/^rg:\s*/i, '').split('\n').slice(0, 3).join(' ').slice(0, 300);
        const invalidParams = { error: detail };
        return {
          content: sm('search.invalid_regex', invalidParams),
          isError: true,
          metadata: { pattern: params.pattern, i18n: i18nMeta('search.invalid_regex', invalidParams) },
        };
      }
      // rg не установлен в окружении исполнения.
      if (execError.code === 'ENOENT' || execError.code === 127 || (execError.stderr && execError.stderr.includes('not found'))) {
        return { content: sm('search.rg_not_installed'), isError: true, metadata: { i18n: i18nMeta('search.rg_not_installed') } };
      }
      // Путь перестал быть каталогом между проверкой и запуском `rg`.
      if (execError.code === 'ENOTDIR') {
        return searchPathErrorResult('search.path_not_directory', params.path ?? searchDir);
      }
      return {
        content: sm('search.error', { error: execError.stderr || String(err) }),
        isError: true,
        metadata: { pattern: params.pattern },
      };
    }
  },
};
