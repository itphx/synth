import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { resolvePath, validateInputPath } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_LENGTH = 100_000;
const DEFAULT_TIMEOUT = 30_000;

export const executeShellTool: ToolDefinition = {
  name: 'execute_shell',
  description:
    'Execute a shell command. Returns stdout and stderr. Use only for legitimate development tasks. Commands run in the working directory. Timeout: 30 seconds.',
  parameters: z.object({
    command: z.string().describe('The command to execute (e.g., "npm test", "ls -la")'),
    timeout: z.number().int().min(1000).max(120000).optional()
      .describe('Timeout in milliseconds (default: 30000)'),
    cwd: z.string().optional()
      .describe('Working directory for the command (absolute or relative to the working directory; defaults to working directory)'),
  }),
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as { command: string; timeout?: number; cwd?: string };
    const timeout = params.timeout ?? DEFAULT_TIMEOUT;
    if (params.cwd !== undefined) validateInputPath(params.cwd, 'cwd');
    const cwd = resolvePath(params.cwd, ctx.workingDir);

    // AD-036: деобфускация в точке потребления — команда может содержать ⟦SYNTH_SECRET_N⟧
    const command = await deobfuscateText(ctx, params.command);

    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
        cwd,
        timeout,
        // «Стоп» (POST /sessions/:id/abort → toolAbortController.abort) убивает
        // процесс SIGTERM — зомби-процессов не остаётся.
        signal: ctx.abortSignal,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || '/root' },
      });

      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;

      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + sm('tool.output_truncated');
      }

      return {
        content: output || sm('tool.empty_output'),
        metadata: { command: params.command, exitCode: 0, truncated: output.length > MAX_OUTPUT_LENGTH },
      };
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; killed?: boolean; code?: number; message?: string };

      // Прерывание по «Стоп» — вернуть единый маркер отмены + частичный вывод
      if (isAborted(ctx)) {
        const partial = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
        return abortedResult(this.name, partial || undefined);
      }

      // Fallback, если детекция окружения не сработала, а `sh` не установлен.
      if ((execError as { code?: unknown }).code === 'ENOENT') {
        return {
          content: sm('tool.binary_missing', { tool: this.name, binary: 'sh' }),
          isError: true,
          metadata: {
            command: params.command,
            i18n: i18nMeta('tool.binary_missing', { tool: this.name, binary: 'sh' }),
          },
        };
      }

      let output = '';
      if (execError.stdout) output += execError.stdout;
      if (execError.stderr) output += (output ? '\n--- stderr ---\n' : '') + execError.stderr;
      output += (output ? '\n' : '') + sm('tool.shell_error', { message: execError.message || sm('tool.command_failed_default') });

      return {
        content: output.slice(0, MAX_OUTPUT_LENGTH),
        isError: true,
        metadata: { command: params.command, exitCode: execError.code ?? -1, killed: execError.killed },
      };
    }
  },
};
