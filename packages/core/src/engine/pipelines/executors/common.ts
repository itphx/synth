/**
 * ADR-101 (Pipeline Engine): общие помощники исполнителей шагов.
 *
 * Исполнители (`tool`/`script`/`human`) делят три вещи: поиск инструмента
 * (реестр или контекст шага), сборку `ToolContext` для вызова тула и сборку
 * результата шага. Вынесено сюда, чтобы правила не расходились между видами
 * шага.
 */
import { generateId } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition } from '@itphx/synth-shared';

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
 */
export function buildToolContext(
  ctx: StepExecutionContext,
  workingDir: string,
): ToolContext {
  return {
    sessionId: `pipeline:${ctx.runId}`,
    messageId: generateId(),
    abortSignal: ctx.signal,
    ...(ctx.step?.agent?.id ? { agentRole: ctx.step.agent.id } : {}),
    workingDir,
  };
}

/** Рабочий каталог шага: workspace проекта (ADR-075), иначе — cwd процесса. */
export function stepWorkingDir(ctx: StepExecutionContext): string {
  return ctx.step?.workspace ?? process.cwd();
}
