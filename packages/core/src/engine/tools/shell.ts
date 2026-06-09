import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';

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
  }),
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { command: string; timeout?: number };
    const timeout = params.timeout ?? DEFAULT_TIMEOUT;

    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', params.command], {
        cwd: ctx.workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || '/root' },
      });

      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;

      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n... (вывод обрезан)';
      }

      return {
        content: output || '(пустой вывод)',
        metadata: { command: params.command, exitCode: 0, truncated: output.length > MAX_OUTPUT_LENGTH },
      };
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; killed?: boolean; code?: number; message?: string };
      let output = '';
      if (execError.stdout) output += execError.stdout;
      if (execError.stderr) output += (output ? '\n--- stderr ---\n' : '') + execError.stderr;
      output += (output ? '\n' : '') + `Ошибка: ${execError.message || 'Команда завершилась с ошибкой'}`;

      return {
        content: output.slice(0, MAX_OUTPUT_LENGTH),
        isError: true,
        metadata: { command: params.command, exitCode: execError.code ?? -1, killed: execError.killed },
      };
    }
  },
};
