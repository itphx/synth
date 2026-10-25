import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolvePath, validateInputPath, isSymlinkEscape, pathEscapesWorkspaceResult } from './path-utils.js';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecutionError } from '../../execution/ports/index.js';
import { BackgroundLimitExceededError } from '../background/types.js';
import { BackgroundUnsupportedError } from '../processes/types.js';
import type { ProcessService } from '../processes/service.js';

const MAX_OUTPUT_LENGTH = 100_000;
const DEFAULT_TIMEOUT = 30_000;

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 *
 * `processService` — сервис фоновых шелл-процессов (PROP-097). Не задан —
 * режим `background: true` недоступен (`process.deps_unavailable`).
 */
export interface ShellToolExtra {
  processService?: ProcessService;
}

export const executeShellTool: ToolDefinition = {
  name: 'execute_shell',
  description:
    'Execute a shell command. Returns stdout and stderr. Use only for legitimate development tasks. Commands run in the working directory. Timeout: 30 seconds. '
    + 'Set background=true to run the command in the background: it returns immediately, the full output is written to a log file, and a notification with the result arrives automatically — do not poll for the status.',
  parameters: z.object({
    command: z.string().describe('The command to execute (e.g., "npm test", "ls -la")'),
    timeout: z.number().int().min(1000).max(120000).optional()
      .describe('Timeout in milliseconds (default: 30000; in background mode there is no timeout by default)'),
    cwd: z.string().optional()
      .describe('Working directory for the command (absolute or relative to the working directory; defaults to working directory)'),
    background: z.boolean().optional()
      .describe('Run the command in the background and return immediately; a notification with the result arrives automatically (do not poll for the status)'),
  }),
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — команда не стартует (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as { command: string; timeout?: number; cwd?: string; background?: boolean };
    const timeout = params.timeout ?? DEFAULT_TIMEOUT;
    if (params.cwd !== undefined) validateInputPath(params.cwd, 'cwd');
    const cwd = resolvePath(params.cwd, ctx.workingDir);
    if (isSymlinkEscape(ctx.workingDir, cwd)) return pathEscapesWorkspaceResult(cwd);

    // ADR-036: деобфускация в точке потребления — команда может содержать ⟦SYNTH_SECRET_N⟧
    const command = await deobfuscateText(ctx, params.command);

    // PROP-097: фоновый запуск — команда не блокирует ход, результат придёт
    // уведомлением (см. engine/processes).
    if (params.background === true) {
      return await startBackgroundProcess(params, command, cwd, ctx);
    }

    try {
      // ADR-077: исполнение — через порт (inline-реализация повторяет
      // прежний `sh -c`: тот же бинарь, таймаут, maxBuffer 10 МБ и окружение
      // `{...process.env, HOME: process.env.HOME || '/root'}`).
      const { stdout, stderr } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'shell', command, shell: 'sh' },
        // ADR-077: бинарное требование тула (`sh`) — в remote-режиме команда
        // уходит в адрес пула, где оболочка есть. Inline-режим поле игнорирует.
        requires: toolRuntimeRequires('execute_shell'),
        cwd,
        timeoutMs: timeout,
        // «Стоп» (POST /sessions/:id/abort → toolAbortController.abort) убивает
        // процесс SIGTERM — зомби-процессов не остаётся.
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        env: { HOME: process.env.HOME || '/root' },
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
      const execError = err as ExecutionError;

      // Прерывание по «Стоп» — вернуть единый маркер отмены + частичный вывод
      if (isAborted(ctx)) {
        const partial = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
        return abortedResult(this.name, partial || undefined);
      }

      // Fallback, если детекция окружения не сработала, а `sh` не установлен.
      if (execError.code === 'ENOENT') {
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

/**
 * Фоновый запуск команды (PROP-097).
 *
 * Ход **не блокируется**: тул возвращает управление сразу, вывод процесса
 * пишется в лог, а по завершении приходит уведомление в сессию (сообщение
 * роли USER + автоход) и событие `process.exited`.
 *
 * Таймаут в фоне по умолчанию **не задан** (процесс переживает ход агента);
 * явный `timeout` передаётся как есть.
 */
async function startBackgroundProcess(
  params: { command: string; timeout?: number; background?: boolean },
  command: string,
  cwd: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const extra = ctx.extra as ShellToolExtra | undefined;
  const service = extra?.processService;
  if (!service || !ctx.sessionId) {
    return {
      content: sm('process.deps_unavailable'),
      isError: true,
      metadata: { i18n: i18nMeta('process.deps_unavailable') },
    };
  }

  try {
    const started = await service.spawn({
      sessionId: ctx.sessionId,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      command,
      cwd,
      // Явный таймаут — как задал; без него фоновый процесс живёт без срока.
      ...(params.timeout !== undefined ? { timeoutMs: params.timeout } : {}),
      env: { HOME: process.env.HOME || '/root' },
    });
    return {
      content: sm('process.background_started', { id: started.processId, log: started.logPath }),
      metadata: {
        process_id: started.processId,
        background_run_id: started.runId,
        status: 'running',
        log_path: started.logPath,
        command: params.command,
        i18n: i18nMeta('process.background_started', { id: started.processId, log: started.logPath }),
      },
    };
  } catch (err) {
    if (err instanceof BackgroundLimitExceededError) {
      return {
        content: sm('process.background_limit', { limit: String(err.limit) }),
        isError: true,
        metadata: {
          background_run_limit: err.limitKind,
          i18n: i18nMeta('process.background_limit', { limit: String(err.limit) }),
        },
      };
    }
    if (err instanceof BackgroundUnsupportedError) {
      return {
        content: sm('process.background_unsupported'),
        isError: true,
        metadata: { i18n: i18nMeta('process.background_unsupported') },
      };
    }
    throw err;
  }
}
