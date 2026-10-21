/**
 * ADR-101 (Pipeline Engine): исполнитель шага вида `script`.
 *
 * Команда шага исполняется **только через существующий shell-тул**
 * (`execute_shell`, `engine/tools/shell.ts`) — не голым `child_process`:
 *
 * - shell-policy и защищённые пути (`definitions/*.json`) действуют (ADR-099);
 * - permission-слой проверяет команду до запуска (ADR-025/ADR-029);
 * - вывод санитизируется и обрезается тем же кодом, что у сессий.
 *
 * Права — как у tool-шага: `allow` — команда исполняется, `deny` — шаг
 * провален (`permission.denied`), `ask` — эскалация в human-гейт
 * (`tool_approval`).
 */
import type { StepResult } from '@itphx/synth-shared';

import { t } from '../../system-messages.js';
import { executeToolDef } from '../../tools/tool-execution.js';
import { executeShellTool } from '../../tools/shell.js';
import { checkPipelineToolPermission, type PipelinePermissionDeps } from '../permissions.js';
import type { StepExecutionContext, StepExecutor, StepOutcome } from '../types.js';
import { buildToolContext, findTool, stepWorkingDir, type PipelineToolLookup } from './common.js';

/** Имя shell-тула, через который исполняются script-шаги. */
export const SHELL_TOOL_NAME = 'execute_shell';

/** Минимальный таймаут shell-тула (мс) — нижняя граница схемы тула. */
const MIN_SHELL_TIMEOUT_MS = 1000;

/** Максимальный таймаут shell-тула (мс) — верхняя граница схемы тула. */
const MAX_SHELL_TIMEOUT_MS = 120_000;

/** Опции исполнителя script-шага. */
export interface ScriptStepExecutorOptions {
  /** Права инструментов (ADR-029) — permission-обёртка пайплайна. */
  permissions?: PipelinePermissionDeps;
  /** Реестр инструментов (ADR-071) — если не задан, берётся встроенный shell-тул. */
  toolRegistry?: PipelineToolLookup;
}

/** Исполнитель шага вида `script`. */
export function createScriptStepExecutor(opts: ScriptStepExecutorOptions = {}): StepExecutor {
  return {
    kind: 'script',
    execute: (ctx: StepExecutionContext) => executeScriptStep(ctx, opts),
  };
}

/**
 * Исполнение script-шага: сборка команды → проверка права → shell-тул →
 * результат шага.
 */
export async function executeScriptStep(
  ctx: StepExecutionContext,
  opts: ScriptStepExecutorOptions = {},
): Promise<StepOutcome> {
  const command = ctx.node.command?.trim();
  if (!command) {
    return failed(ctx, 'pipeline.script_failed', t('pipeline.script_failed', {
      node: ctx.node.id,
      code: '0',
      error: t('pipeline.script_no_command', { node: ctx.node.id }),
    }));
  }

  const fullCommand = buildShellCommand(command, ctx.node.args ?? []);
  const workingDir = stepWorkingDir(ctx);
  const shellTool = findTool(ctx, opts.toolRegistry, SHELL_TOOL_NAME) ?? executeShellTool;

  const decision = ctx.gateDecision;
  if (decision) {
    if (!decision.approved) {
      return {
        status: 'failed',
        attempt: ctx.attempt,
        error: {
          code: 'pipeline.gate_rejected',
          message: t('pipeline.gate_rejected', { node: ctx.node.id }),
        },
      };
    }
  } else {
    const permission = checkPipelineToolPermission(
      {
        toolName: SHELL_TOOL_NAME,
        params: { command: fullCommand },
        workingDir,
        capabilities: shellTool.capabilities,
        mode: ctx.mode,
        ...(ctx.step ? { workspaceReady: ctx.step.workspaceReady } : {}),
        ...(ctx.step?.agent?.capabilities
          ? { agentCapabilities: ctx.step.agent.capabilities }
          : {}),
      },
      opts.permissions,
    );

    if (permission.action === 'deny') {
      return failed(ctx, 'permission.denied', t('pipeline.permission_denied', {
        node: ctx.node.id,
        tool: SHELL_TOOL_NAME,
        reason: permission.reason ?? '',
      }));
    }
    if (permission.action === 'ask') {
      return {
        kind: 'gate',
        gate: {
          kind: 'tool_approval',
          nodeId: ctx.node.id,
          toolName: SHELL_TOOL_NAME,
          args: { command: fullCommand },
          ...(permission.reason ? { reason: permission.reason } : {}),
          ...(ctx.node.timeoutSec !== undefined ? { timeoutSec: ctx.node.timeoutSec } : {}),
        },
      };
    }
  }

  const toolContext = buildToolContext(ctx, workingDir);
  const params: Record<string, unknown> = { command: fullCommand };
  if (ctx.node.timeoutSec !== undefined) {
    params.timeout = Math.min(
      Math.max(ctx.node.timeoutSec * 1000, MIN_SHELL_TIMEOUT_MS),
      MAX_SHELL_TIMEOUT_MS,
    );
  }

  const result = await executeToolDef(shellTool, params, toolContext, SHELL_TOOL_NAME);
  const exitCode = typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : undefined;

  if (result.isError) {
    return failed(ctx, 'pipeline.script_failed', t('pipeline.script_failed', {
      node: ctx.node.id,
      code: String(exitCode ?? 1),
      error: result.content,
    }));
  }

  return {
    status: 'ok',
    attempt: ctx.attempt,
    output: {
      content: result.content,
      exitCode: exitCode ?? 0,
      ...(result.metadata?.truncated ? { truncated: true } : {}),
    },
  };
}

/**
 * Сборка команды шага: `node.command` + `node.args`.
 *
 * Аргументы экранируются одинарными кавычками (shell-экранирование) — иначе
 * аргумент с пробелом развалился бы на несколько.
 */
export function buildShellCommand(command: string, args: string[]): string {
  if (args.length === 0) return command;
  return [command, ...args.map(shellQuote)].join(' ');
}

/** Экранирование одного аргумента для `sh -c`. */
function shellQuote(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Провал шага с кодом ошибки. */
function failed(ctx: StepExecutionContext, code: string, message: string): StepResult {
  return {
    status: 'failed',
    attempt: ctx.attempt,
    error: { code, message },
  };
}
