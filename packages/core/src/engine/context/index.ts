export { ContextConfig } from './config.js';
export { ContextBuilder, type BuildSystemPromptParams, type ContextBuilderOptions } from './builder.js';
export {
  type PromptTier,
  type PromptBlock,
  sortPromptBlocks,
  joinPromptBlocks,
} from './prompt-blocks.js';
// ADR-090: реестр провайдеров блоков системного промпта.
export {
  PromptBlockRegistrationError,
  PromptBlockRegistry,
} from './prompt-block-registry.js';
export type {
  PromptBlockRegistrationOptions,
  RegisteredPromptBlock,
} from './prompt-block-registry.js';
export {
  type PromptStateReason,
  type ComposedPromptLike,
  DEFAULT_AGENT_KEY,
  agentKeyOf,
  hashText,
  buildPromptState,
  isPrefixUnchanged,
  isBlockChanged,
  computeExpected,
  validateExpected,
} from './prompt-state.js';
export {
  SystemPromptComposer,
  type ComposerContext,
  type ComposerSessionLike,
  type ComposedPrompt,
  type SystemPromptComposerDeps,
} from './composer.js';
// Среда исполнения инструментов (ADR-135/PROP-135) — вид системного блока
// `[СРЕДА ИСПОЛНЕНИЯ]`.
export {
  EXECUTION_ENVIRONMENT_KINDS,
  resolveExecutionEnvironmentKind,
  type ExecutionEnvironmentKind,
} from './environment.js';
export {
  type StateMessageType,
  type UnavailableTool,
  type SyncStateMessagesDeps,
  type SyncStateMessagesResult,
  wrapStateContent,
  createStateMessage,
  findLastStateMessage,
  buildModeChangeContent,
  buildAgentSwitchContent,
  buildPlanUpdatedContent,
  buildTodosUpdatedContent,
  syncStateMessages,
} from './state-messages.js';
export { isInterviewCompleted } from './interview.js';
export { ContextOptimizer, type SummarizationResult, type SlidingWindowResult } from './optimizer.js';
