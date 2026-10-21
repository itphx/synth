/**
 * ADR-101 (Pipeline Engine): публичная поверхность движка пайплайнов.
 *
 * Движок — второй оркестратор рядом с `ChatOrchestrator` (ADR-101 §1): шаг
 * пайплайна не является сессией, прогон ведётся по графу спецификации, а
 * журнал — append-only.
 *
 * Модули:
 * - `types.ts` — контракт исполнителя, контекст шага, точки расширения;
 * - `paths.ts` — точечные пути данных прогона;
 * - `condition.ts` — вычисление условий перехода (структурированный DSL);
 * - `mapping.ts` — маппинг входа шага;
 * - `planner.ts` — правила переходов и лимит переходов;
 * - `payload.ts` — санитизация данных прогона и журнала;
 * - `engine.ts` — `PipelineEngine`.
 */
export { PipelineEngine } from './engine.js';
export { evaluateCondition } from './condition.js';
export { resolveSpecVars, resolveStepInput } from './mapping.js';
export { nextNodeId, MAX_PIPELINE_TRANSITIONS } from './planner.js';
export { resolvePathValue, resolvePipelinePath } from './paths.js';
export { sanitizeRecord, sanitizeTrigger, sanitizeValue } from './payload.js';
export {
  PipelineEngineError,
  NoopPipelineExitHandler,
  PIPELINE_ERROR_CODES,
} from './types.js';
export type {
  ConditionContext,
  PipelineEngineDeps,
  PipelineEngineLogger,
  PipelineErrorCode,
  PipelineExitContext,
  PipelineExitHandler,
  PipelineGateDecision,
  PipelinePathContext,
  PipelineRunOptions,
  StepExecutionContext,
  StepExecutor,
} from './types.js';
export type { PlannerContext } from './planner.js';
