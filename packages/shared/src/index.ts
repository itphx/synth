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
  type PostgresStorageConfig,
  postgresStorageConfigSchema,
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
  type DecisionConfig,
  decisionConfigSchema,
  type WebhooksConfig,
  webhooksConfigSchema,
  type RemoteConfig,
  type MicroFirstConfig,
  type SecurityConfig,
  securityTlsConfigSchema,
  type SecurityTlsConfig,
  type PromptInjectionConfig,
  type ProtectedPathsConfig,
  type LLMGatewayConfig,
  type LLMGatewayRateLimitConfig,
  type LLMGatewayAuditConfig,
} from './config/index.js';
export { defaultConfig, loadConfig } from './config/index.js';
export { resolveDataDir, resolvePort, resolveWorkspacesRoot, resolveDefaultWorkspace, resolveWorkspaceOutsideRootPolicy, resolveSecretKey, resolveStorageBackend, resolvePostgresConfig, resolvePostgresPassword, resolveDegradedMode, resolveStorageFallbackDir, resolveIgnoreRules, resolveHome, resolveProfilesPath, resolveCredentialsPath, ensureDataDir, createDefaultConfig, resolveDeployMode, findConfigPath, defaultConfigPath, ensureConfigFile, ensureFirstRun, resolveDecisionProvider, resolveDecisionModel, resolveMaxUploadBytes } from './config/index.js';
export type { StorageBackend, ResolvedPostgresConfig } from './config/index.js';
export { applyEnvOverrides, envOverrideName, toSnakeCase, parseEnvValue, ENV_OVERRIDES } from './config/index.js';
// ADR-099: резолверы доверия TLS/CA (`security.tls`).
export { resolveTlsConfig, resolveTlsTrust, isPemContent, TLS_ENV } from './config/index.js';
export type { ResolvedTlsConfig, ResolvedTlsTrust, TlsConfigSource } from './config/index.js';
// ADR-099 (D1): HTTP/HTTPS-прокси единого egress-слоя.
export {
  PROXY_ENV,
  PROXY_PASSWORD_ENV,
  PROXY_TLS_ENV,
  PROXY_URL_FIELDS,
  STANDARD_PROXY_ENV,
  ProxyConfigError,
  NoProxyMatcher,
  parseProxyUrl,
  isSocksProxyProtocol,
  redactProxyUrl,
  resolveProxyConfig,
  resolveProxyTls,
  mergeProxyConfig,
  validateProxyConfig,
  emptyResolvedProxyConfig,
  proxyUrlFor,
  proxyEntryFor,
  defaultProxyEntry,
  shouldProxyUrl,
  proxyStatus,
} from './config/index.js';
export type {
  ProxyConfigSource,
  ProxyConfigOrigin,
  ResolveProxyConfigOptions,
  ProxyCredentials,
  ProxyCredentialSet,
  ProxyUrlField,
  ResolvedProxyConfig,
  ResolvedProxyTls,
  EgressProxyStatus,
  ProxyPasswordStatus,
  ProxyAuthChallenge,
  ProxyCheckResult,
  ParsedProxyUrl,
} from './config/index.js';
export {
  type ProxyConfig,
  type ProxyAuthConfig,
  type ProxyAuthType,
  type ProxyTlsConfig,
  proxyConfigSchema,
  proxyAuthConfigSchema,
  proxyTlsConfigSchema,
  PROXY_AUTH_TYPES,
} from './config/index.js';
// ADR-099 × PROP-032: единый построитель TLS-опций PostgreSQL (sslmode + security.tls).
export {
  buildPostgresSslOptions,
  findDsnTlsParams,
  normalizePostgresSslMode,
  POSTGRES_SSL_MODES,
  POSTGRES_SSL_MODE_ALIASES,
  DSN_TLS_PARAMS,
} from './config/index.js';
export type {
  PostgresSslMode,
  PostgresSslBuildInput,
  PostgresSslBuildResult,
} from './config/index.js';
export type { DeployMode } from './config/index.js';
export type { EnvOverrideDefinition, EnvOverrideType, ParsedEnvValue } from './config/index.js';
