import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscape, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

export const grepFilesTool: ToolDefinition = {
  name: 'grep_files',
  description:
    'Search file contents using regular expressions. Returns file paths, line numbers, and matching content. Supports full regex syntax.',
  parameters: z.object({
    pattern: z.string().describe('The regex pattern to search for in file contents'),
    path: z.string().optional().describe('Directory to search in (defaults to working directory)'),
    include: z.string().optional().describe('File pattern filter (e.g., "*.ts", "*.{ts,tsx}")'),
  }),
  capabilities: [ToolCapability.SEARCH],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — поиск не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as { pattern: string; path?: string; include?: string };
    if (params.path !== undefined) validateInputPath(params.path, 'path');
    const searchDir = resolvePath(params.path, ctx.workingDir);
    if (isSymlinkEscape(ctx.workingDir, searchDir)) return pathEscapesWorkspaceResult(searchDir);

    // ADR-036: деобфускация в точке потребления — паттерн может содержать ⟦SYNTH_SECRET_N⟧
    const pattern = await deobfuscateText(ctx, params.pattern);

    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '-n'];

      if (params.include) {
        for (const g of params.include.split(',').map((s) => s.trim())) {
          rgArgs.push('--glob', g);
        }
      }

      rgArgs.push(pattern, searchDir);

      const { stdout } = await execFileAsync('rg', rgArgs, {
        timeout: 30_000,
        // «Стоп» (toolAbortController.abort) убивает процесс SIGTERM
        signal: ctx.abortSignal,
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = stdout.split('\n').filter(Boolean);
      if (lines.length > 200) {
        const truncated = lines.slice(0, 200);
        truncated.push(sm('search.matches_truncated', { total: String(lines.length) }));
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
      const execError = err as { code?: number; stderr?: string };
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
