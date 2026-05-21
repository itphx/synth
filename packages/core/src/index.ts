// @synth/core — ядро системы
// Содержит общую реализацию для standalone и backend режимов

export { FileStore } from './storage/file-store.js';
export type { StorageConfig } from './storage/file-store.js';
export { SessionManager } from './sessions/manager.js';
export { EventBus, sseEventStream } from './events/bus.js';
export { QueueProcessor, QueueProcessorManager, enqueueUserMessage } from './queue/processor.js';

export {
  ProviderFactory,
  BaseProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  ProviderError,
  ContextLengthExceededError,
  RateLimitError,
} from './providers/index.js';
export type { LLMMessage, CancellationToken, ProviderConfig } from './providers/index.js';

export {
  debug,
  info,
  warning,
  error,
  critical,
  setLevelForGroup,
  getAllGroups,
  setAllGroups,
  resetGroupOverrides,
  LOG_LEVEL_NAMES,
} from './logger.js';

export { DebugCollector } from './debug.js';

export { ContextConfig, ContextBuilder, InterviewManager } from './engine/context/index.js';
export type { BuildSystemPromptParams, ContextBuilderOptions } from './engine/context/index.js';
export { FileProfileStore } from './storage/profile-store.js';
