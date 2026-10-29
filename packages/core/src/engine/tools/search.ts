import { z } from 'zod';
import { relative } from 'node:path';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscapeInRoots, toolRoots, pathEscapesWorkspaceResult, isIgnoredSearchPath } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecutionError } from '../../execution/ports/index.js';

/** `grep_files`: сколько строк совпадений отдавать по умолчанию и максимум. */
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 1_000;

/**
 * Путь из строки результата `rg` (`path:line:text`) — относительно каталога
 * поиска (для фильтра служебных путей, см. `isIgnoredSearchPath`).
 */
function linePath(line: string, searchDir: string): string {
  const first = line.indexOf(':');
  const filePath = first > 0 ? line.slice(0, first) : line;
  return filePath.startsWith(searchDir) ? relative(searchDir, filePath) : filePath;
}

export const grepFilesTool: ToolDefinition = {
  name: 'grep_files',
  description:
    `Search file contents using ripgrep's regular expression syntax or literal text matching (literal=true). Returns file paths, line numbers, and matching lines; narrow the search with path or include. Returns at most ${DEFAULT_SEARCH_LIMIT} matching lines by default (limit up to ${MAX_SEARCH_LIMIT}). Path is resolved against the project working directory; prefer relative paths. Paths outside it require explicit user approval and are normally denied.`,
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
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
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

    // ADR-036: деобфускация в точке потребления — паттерн может содержать ⟦SYNTH_SECRET_N⟧
    const pattern = await deobfuscateText(ctx, params.pattern);
    const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    try {
      // Один `-n` (раньше флаг дублировался как `--line-number` и `-n`)
      const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];

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

      rgArgs.push(pattern, searchDir);

      // ADR-077: исполнение — через порт (inline-реализация повторяет
      // прежний `execFile('rg', …)`: argv без shell, таймаут 30 с,
      // maxBuffer 10 МБ, базовое окружение — `process.env`).
      const { stdout } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'argv', file: 'rg', args: rgArgs },
        // ADR-077: бинарное требование тула (`rg`) — в remote-режиме команда
        // уходит в адрес пула, где ripgrep есть.
        requires: toolRuntimeRequires('grep_files'),
        timeoutMs: 30_000,
        // «Стоп» (toolAbortController.abort) убивает процесс SIGTERM
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      const lines = stdout
        .split('\n')
        .filter(Boolean)
        // Служебные пути (`.git`, скрытые без `hidden`) отсекаем по сегментам
        // пути относительно каталога поиска: маска `--glob` перекрывает
        // скрытие рипгрепа, а негативный `--glob '!.git/**'` матчится
        // относительно cwd процесса, а не пути поиска.
        .filter((line) => !isIgnoredSearchPath(linePath(line, searchDir), params.hidden === true));
      if (lines.length > limit) {
        // Лимит — общий по строкам совпадений, а не «200 на файл»
        const truncated = lines.slice(0, limit);
        truncated.push(sm('search.matches_truncated', { shown: String(limit), total: String(lines.length) }));
        return {
          content: truncated.join('\n'),
          metadata: { pattern: params.pattern, matches: lines.length, truncated: true },
        };
      }

      return {
        content: lines.length > 0 ? lines.join('\n') : sm('search.no_matches'),
        metadata: { pattern: params.pattern, matches: lines.length },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены, не «ошибка поиска»
      if (isAborted(ctx)) return abortedResult(this.name);
      const execError = err as ExecutionError;
      if (execError.code === 1) {
        return { content: sm('search.no_matches'), metadata: { pattern: params.pattern, matches: 0 } };
      }
      if (execError.code === 127 || (execError.stderr && execError.stderr.includes('not found'))) {
        return { content: sm('search.rg_not_installed'), isError: true, metadata: { i18n: i18nMeta('search.rg_not_installed') } };
      }
      return {
        content: sm('search.error', { error: execError.stderr || String(err) }),
        isError: true,
        metadata: { pattern: params.pattern },
      };
    }
  },
};
