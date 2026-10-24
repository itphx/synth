/**
 * ADR-101 (Pipeline Engine): общие помощники исполнителей шагов.
 *
 * Исполнители (`tool`/`script`/`human`/`agent`) делят три вещи: поиск
 * инструмента (реестр или контекст шага), проверку права на него (тот же
 * permission-слой, ADR-025/ADR-029) и вызов через `executeToolDef`. Вынесено
 * сюда, чтобы правила не расходились между видами шага: agent-шаг (Э4.3b)
 * проверяет право и вызывает тулы **тем же** кодом, что и tool-шаг.
 */
import { generateId } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';

import { executeToolDef } from '../../tools/tool-execution.js';
import { checkPipelineToolPermission, type PipelinePermissionDecision, type PipelinePermissionDeps } from '../permissions.js';
import type { StepExecutionContext } from '../types.js';

/**
 * Минимальный контракт реестра инструментов для исполнителей (ADR-071).
 *
 * Совместим с `ToolRegistry` ядра (`get(name)`) — движок и исполнители видят
 * один и тот же реестр.
 */
export interface PipelineToolLookup {
  /** Инструмент по имени (`undefined` — нет). */
  get(name: string): ToolDefinition | undefined;
}

/**
 * Поиск инструмента: сначала реестр (актуальные регистрации/переопределения),
 * затем — постоянный список тулов контекста шага (ADR-070 §2.9).
 */
export function findTool(
  ctx: StepExecutionContext,
  lookup: PipelineToolLookup | undefined,
  name: string,
): ToolDefinition | undefined {
  return lookup?.get(name) ?? ctx.step?.tools.find((tool) => tool.name === name);
}

/**
 * `ToolContext` для вызова тула из шага пайплайна.
 *
 * Сессии у шага нет (ADR-101 §1) — `sessionId` здесь просто параметр-пакет с
 * префиксом `pipeline:` (по нему тулы, пишущие в сессию, отсеивают вызов).
 *
 * Проект прогона — метаданные хода (ADR-107): плагинный тул (память)
 * ограничивает себя данными проекта, а не всего инстанса.
 */
export function buildToolContext(
  ctx: StepExecutionContext,
  workingDir: string,
): ToolContext {
  const projectId = ctx.projectId ?? ctx.step?.projectId;
  return {
    sessionId: `pipeline:${ctx.runId}`,
    messageId: generateId(),
    abortSignal: ctx.signal,
    ...(ctx.step?.agent?.id ? { agentRole: ctx.step.agent.id } : {}),
    ...(projectId ? { projectId } : {}),
    workingDir,
  };
}

/** Рабочий каталог шага: workspace проекта (ADR-075), иначе — cwd процесса. */
export function stepWorkingDir(ctx: StepExecutionContext): string {
  return ctx.step?.workspace ?? process.cwd();
}

/**
 * Проверка права на инструмент шага пайплайна — **единая точка** для всех
 * видов шага (ADR-101 §2.7).
 *
 * Входы permission-слоя — те же, что у сессий: режим пайплайна как
 * `sessionMode`, рабочий каталог проекта, гейт `workspace`, capabilities
 * агента. `deps` не задан — PermissionEvaluator с пустыми правилами (тул
 * разрешён по умолчанию), как и у остальных исполнителей.
 */
export function checkStepToolPermission(
  ctx: StepExecutionContext,
  deps: PipelinePermissionDeps | undefined,
  toolName: string,
  params: Record<string, unknown>,
  capabilities?: readonly string[],
): PipelinePermissionDecision {
  return checkPipelineToolPermission(
    {
      toolName,
      params,
      workingDir: stepWorkingDir(ctx),
      ...(capabilities ? { capabilities } : {}),
      mode: ctx.mode,
      ...(ctx.step ? { workspaceReady: ctx.step.workspaceReady } : {}),
      ...(ctx.step?.agent?.capabilities
        ? { agentCapabilities: ctx.step.agent.capabilities }
        : {}),
    },
    deps,
  );
}

/**
 * Вызов инструмента шага: `ToolContext` пайплайна + `executeToolDef`
 * (валидация аргументов схемой тула, единый формат ошибок, санитизация
 * вывода). Не бросает: ошибка тула — в `result.isError`.
 */
export async function executeStepTool(
  ctx: StepExecutionContext,
  toolDef: ToolDefinition,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return executeToolDef(toolDef, args, buildToolContext(ctx, stepWorkingDir(ctx)), toolName);
}
