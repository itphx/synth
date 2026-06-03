// @synth/shared — общие типы, интерфейсы, схемы, протоколы, конфигурация

export * from './types/index.js';
export * from './interfaces/index.js';
export * from './schemas/index.js';
export * from './protocols/index.js';
export * from './utils/index.js';
export * from './model-metadata.js';

// Конфигурация — выборочный экспорт (избегаем конфликта AuthConfig/TestUser)
export {
  type SynthConfig,
  type ServerConfig,
  type StorageConfig,
  type AuthConfig as SynthAuthConfig,
  type LLMConfig,
  type CoreConfig,
  type RunnerConfig,
  type UIConfig,
  type I18nConfig,
  type LoggingConfig,
  type TsmConfig,
  type ContextConfigSchema,
  type SummarizationConfig,
} from './config/index.js';
export { defaultConfig, loadConfig } from './config/index.js';
export { resolveDataDir, resolvePort, resolveWorkspacesRoot, ensureDataDir, createDefaultConfig } from './config/index.js';
