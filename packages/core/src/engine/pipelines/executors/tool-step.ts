/**
 * ADR-101 (Pipeline Engine): исполнитель шага вида `tool`.
 *
 * Шаг вызывает **зарегистрированный инструмент** через общий
 * `executeToolDef` (`engine/tools/tool-execution.ts`) — тот же путь, что у
 * сессий: валидация аргументов схемой тула, единый формат ошибок, санитизация
 * вывода.
 *
 * ## Права
 *
 * Перед вызовом — permission-обёртка пайплайна (`permissions.ts`): тот же
 * `PermissionEvaluator`, что у сессий (ADR-025/ADR-029).
 *
 * - `allow` — инструмент исполняется;
 * - `deny` — шаг `failed` с кодом `permission.denied` (обхода нет);
 * - `ask` — **эскалация в human-гейт**: наблюдателя-сессии у пайплайна нет →
 *   прогон встаёт на паузу (`gate.awaiting`, `kind: 'tool_approval'`), а
 *   одобрение оператора (`resume({approved: true})`) даёт инструменту право
 *   исполняться (ADR-101 §6).
 */
import type { StepResult } from '@itphx/synth-shared';

import { t } from '../../system-messages.js';
import { executeToolDef } from '../../tools/tool-execution.js';
import { checkPipelineToolPermission, type PipelinePermissionDeps } from '../permissions.js';
import type { StepExecutionContext, StepExecutor, StepOutcome } from '../types.js';
import { buildToolContext, findTool, stepWorkingDir, type PipelineToolLookup } from './common.js';

/** Опции исполнителя tool-шага. */
export interface ToolStepExecutorOptions {
  /** Права инструментов (ADR-029) — permission-обёртка пайплайна. */
  permissions?: PipelinePermissionDeps;
  /** Реестр инструментов (ADR-071) — если не задан, тул берётся из контекста шага. */
  toolRegistry?: PipelineToolLookup;
}

/** Исполнитель шага вида `tool`. */
export function createToolStepExecutor(opts: ToolStepExecutorOptions = {}): StepExecutor {
  return {
    kind: 'tool',
    execute: (ctx: StepExecutionContext) => executeToolStep(ctx, opts),
  };
}

/**
 * Исполнение tool-шага: проверка права → вызов инструмента → результат шага.
 *
 * Повторный вызов после одобрения оператора (`ctx.gateDecision.approved`) —
 * право считается выданным, поэтому permission-проверка не повторяется.
 */
export async function executeToolStep(
  ctx: StepExecutionContext,
  opts: ToolStepExecutorOptions = {},
): Promise<StepOutcome> {
  const toolName = ctx.node.tool?.trim();
  if (!toolName) {
    return failed(ctx, 'pipeline.tool_not_found', t('pipeline.tool_not_found', {
      tool: ctx.node.tool ?? '',
      node: ctx.node.id,
    }));
  }

  const args: Record<string, unknown> = { ...(ctx.node.toolArgs ?? {}) };
  const decision = ctx.gateDecision;

  if (decision) {
    // Решение оператора по гейту: отклонение — шаг провален, инструмент не
    // вызывается; одобрение — право выдано, инструмент исполняется.
    if (!decision.approved) {
      return gateRejected(ctx);
    }
  } else {
    const toolDef = findTool(ctx, opts.toolRegistry, toolName);
    const workingDir = stepWorkingDir(ctx);
    const permission = checkPipelineToolPermission(
      {
        toolName,
        params: args,
        workingDir,
        ...(toolDef ? { capabilities: toolDef.capabilities } : {}),
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
        tool: toolName,
        reason: permission.reason ?? '',
      }));
    }
    if (permission.action === 'ask') {
      // Эскалация в human-гейт: наблюдателя-сессии нет (ADR-101 §6).
      return {
        kind: 'gate',
        gate: {
          kind: 'tool_approval',
          nodeId: ctx.node.id,
          toolName,
          args,
          ...(permission.reason ? { reason: permission.reason } : {}),
          ...(ctx.node.timeoutSec !== undefined ? { timeoutSec: ctx.node.timeoutSec } : {}),
        },
      };
    }
  }

  const toolDef = findTool(ctx, opts.toolRegistry, toolName);
  if (!toolDef) {
    return failed(ctx, 'pipeline.tool_not_found', t('pipeline.tool_not_found', {
      tool: toolName,
      node: ctx.node.id,
    }));
  }

  const toolContext = buildToolContext(ctx, stepWorkingDir(ctx));
  const result = await executeToolDef(toolDef, args, toolContext, toolName);

  if (result.isError) {
    return failed(ctx, 'pipeline.tool_failed', t('pipeline.tool_failed', {
      node: ctx.node.id,
      tool: toolName,
      error: result.content,
    }));
  }

  return {
    status: 'ok',
    attempt: ctx.attempt,
    output: {
      content: result.content,
      isError: false,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    },
  };
}

/** Провал шага с кодом ошибки. */
function failed(ctx: StepExecutionContext, code: string, message: string): StepResult {
  return {
    status: 'failed',
    attempt: ctx.attempt,
    error: { code, message },
  };
}

/** Отклонение гейта оператором. */
function gateRejected(ctx: StepExecutionContext): StepResult {
  return {
    status: 'failed',
    attempt: ctx.attempt,
    error: {
      code: 'pipeline.gate_rejected',
      message: t('pipeline.gate_rejected', { node: ctx.node.id }),
    },
  };
}
