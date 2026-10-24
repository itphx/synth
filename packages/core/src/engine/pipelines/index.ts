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
 * - `permissions.ts` — permission-обёртка пайплайна (ADR-025/ADR-029);
 * - `gate.ts` — общие помощники гейтов (пауза, таймаут, решение оператора);
 * - `step-context.ts` — контекст шага (проект/workspace/режим/тулы/MCP);
 * - `executors/` — исполнители видов шага (`tool`/`script`/`human`/`agent`);
 * - `engine.ts` — `PipelineEngine`.
 */
export { PipelineEngine } from './engine.js';
export { evaluateCondition } from './condition.js';
export { resolveSpecVars, resolveStepInput } from './mapping.js';
export { nextNodeId, MAX_PIPELINE_TRANSITIONS } from './planner.js';
export { resolvePathValue, resolvePipelinePath } from './paths.js';
export { sanitizeRecord, sanitizeTrigger, sanitizeValue } from './payload.js';
export { buildPipelineStepContext } from './step-context.js';
export { checkPipelineToolPermission } from './permissions.js';
export type {
  PipelinePermissionDecision,
  PipelinePermissionDeps,
  PipelineToolPermissionCheck,
} from './permissions.js';
export {
  gateDecisionResult,
  gateRejectedResult,
  gateTimeoutResult,
  humanGate,
  startGateTimeout,
} from './gate.js';
export {
  buildShellCommand,
  buildStepUserMessage,
  buildToolContext,
  checkStepToolPermission,
  createAgentStepExecutor,
  createHumanStepExecutor,
  createScriptStepExecutor,
  createToolStepExecutor,
  DEFAULT_MAX_AGENT_ITERATIONS,
  executeAgentStep,
  executeScriptStep,
  executeStepTool,
  executeToolStep,
  findTool,
  humanStepExecutor,
  SHELL_TOOL_NAME,
  stepWorkingDir,
} from './executors/index.js';
export type {
  AgentStepExecutorOptions,
  AgentStepState,
  PipelineToolLookup,
  ScriptStepExecutorOptions,
  ToolStepExecutorOptions,
} from './executors/index.js';
export type {
  PipelineAgentRegistryLike,
  PipelineInstructionsResolverLike,
  PipelineMcpManagerLike,
  PipelineProjectStoreLike,
  PipelineSkillsCatalogLike,
  PipelineStepContext,
  PipelineStepContextDeps,
  PipelineToolRegistryLike,
} from './step-context.js';
export {
  PipelineEngineError,
  isStepGateOutcome,
  NoopPipelineExitHandler,
  PIPELINE_ERROR_CODES,
} from './types.js';
export { createPipelineExitHandler } from './exits.js';
// ADR-101: встроенные шаблоны пайплайнов инстанса (сид при старте).
export {
  BUILTIN_PIPELINE_PROVENANCE,
  buildMemoryConsolidationPipelineSpec,
  ensureBuiltinPipelines,
  MEMORY_CONSOLIDATION_PIPELINE_ID,
  MEMORY_CONSOLIDATION_PIPELINE_VERSION,
} from './builtin.js';
export type {
  EnsureBuiltinPipelinesDeps,
  EnsureBuiltinPipelinesResult,
} from './builtin.js';
export type {
  PipelineExitDeps,
  PipelineExitEventBusLike,
  PipelineExitIngressLike,
  PipelineExitSessionManagerLike,
} from './exits.js';
export type {
  ConditionContext,
  PipelineEngineDeps,
  PipelineEngineLogger,
  PipelineErrorCode,
  PipelineEventPublisher,
  PipelineExitContext,
  PipelineExitHandler,
  PipelineGate,
  PipelineGateDecision,
  PipelineGateKind,
  PipelineLlmDefaults,
  PipelinePathContext,
  PipelineRunOptions,
  PipelineStepLlmRuntime,
  StepExecutionContext,
  StepExecutor,
  StepGateOutcome,
  StepOutcome,
} from './types.js';
export type { PlannerContext } from './planner.js';
