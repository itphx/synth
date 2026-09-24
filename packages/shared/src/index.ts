// @itphx/synth-shared — общие типы, интерфейсы, схемы, протоколы, конфигурация

export * from './types/index.js';
export * from './i18n/index.js';
export {
  type ToolDefinition,
  type ToolForLLM,
  type ToolContext,
  type ToolResult,
  type ToolExecutor,
  type PendingToolCall,
  type CompletedToolCall,
  ToolCapability,
  TOOL_CAPABILITY_META,
} from './types/tools.js';
export * from './interfaces/index.js';
export * from './schemas/index.js';
export * from './protocols/index.js';
export * from './utils/index.js';
export * from './skills/frontmatter.js';
export { SYNTH_VERSION } from './version.js';
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
  type McpServerConfig,
  type McpConfig,
  type ToolsDisabledConfig,
  toolsDisabledConfigSchema,
  type SkillsConfig,
  skillsConfigSchema,
  type CommandsConfig,
  commandsConfigSchema,
  type InstructionsConfig,
  type InstructionsLazyConfig,
  type InstructionsFetchConfig,
  type InstructionSourceConfig,
  instructionsConfigSchema,
  instructionSourceConfigSchema,
  type RouterConfig,
  type RouterContentConfig,
  type RouterEscalationConfig,
  type RouterCostConfig,
  type RouterSubagentConfig,
  type RemoteConfig,
  type MicroFirstConfig,
  type SecurityConfig,
  type PromptInjectionConfig,
  type ProtectedPathsConfig,
  type LLMGatewayConfig,
  type LLMGatewayRateLimitConfig,
  type LLMGatewayAuditConfig,
} from './config/index.js';
export { defaultConfig, loadConfig } from './config/index.js';
export { resolveDataDir, resolvePort, resolveWorkspacesRoot, resolveDefaultWorkspace, ensureDataDir, createDefaultConfig, resolveDeployMode, findConfigPath, defaultConfigPath, ensureConfigFile, ensureFirstRun } from './config/index.js';
export type { DeployMode } from './config/index.js';
