// @itphx/synth-core — ядро системы
// Содержит общую реализацию для standalone и backend режимов

export { FileStore } from './storage/file-store.js';
export type { StorageConfig } from './storage/file-store.js';
export { SessionManager } from './sessions/manager.js';
export { computeSessionStats, MAX_SUBAGENT_DEPTH } from './sessions/stats.js';
export type { SessionStatsDeps } from './sessions/stats.js';
export { EventBus, sseEventStream } from './events/bus.js';
export { QueueProcessor, QueueProcessorManager, enqueueUserMessage } from './queue/processor.js';
export type { ProcessMessageFn } from './queue/processor.js';

export {
  ProviderFactory,
  BaseProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  RemoteProvider,
  setRemoteTokenProvider,
  clearRemoteTokenProviders,
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
export { ContextOptimizer } from './engine/context/index.js';
export type { BuildSystemPromptParams, ContextBuilderOptions, SummarizationResult, SlidingWindowResult } from './engine/context/index.js';

export { ChatOrchestrator } from './engine/orchestrator.js';
export type { OrchestratorOptions, ProcessMessageResult, ModelPricing } from './engine/orchestrator.js';
export { runSubagentResume, validateSubagentResume, SubagentResumeError } from './engine/tools/task-resume.js';
export type { SubagentResumeDeps, SubagentResumeOptions, SubagentResumeResult, SubagentResumeErrorCode } from './engine/tools/task-resume.js';
export { SUBAGENT_MAX_ATTEMPTS, SUBAGENT_RETRY_DELAYS_MS } from './engine/tools/task.js';
export type { SubagentRetryConfig, SubagentRunConfig } from './engine/tools/task.js';

export { ModelRouter, ContentClassifier, ProviderPool, QualityChecker, DictionaryStore, DICTIONARY_LANGUAGES } from './engine/router/index.js';
export type { StoredDictionary, DictionaryLanguage } from './engine/router/index.js';
export type { RoutingRequest, RoutingDecision, ContentCategory, ClassifyRequest, ClassifyResult, QualityCheckInput, QualityCheckResult } from './engine/router/index.js';

export { createToolRegistry, ToolRegistry } from './engine/tools/index.js';
export { createAgentRegistry, AgentRegistry, loadSystemAgentDefinitions, normalizeAgentModes, isModeApplicable, DEFAULT_AGENT_ID } from './engine/agents/index.js';
export { McpClient, McpManager } from './engine/mcp/index.js';
export type { McpToolDef, McpToolResult } from './engine/mcp/index.js';
export { resolveMcpScope } from './engine/mcp/index.js';
export type { McpScopeServer, McpScopeSession, McpScopeDecision } from './engine/mcp/index.js';
export {
  evaluateMcpNetworkAccess,
  isIpInCidr,
  parseCidr,
  hostFromUrl,
  isHttpMcpConfig,
} from './engine/mcp/index.js';
export type { McpNetworkCheckResult, HostResolver } from './engine/mcp/index.js';

export {
  PermissionEvaluator,
  PermissionApprovalManager,
  deriveSubagentPermission,
  emptyPermissionConfig,
  getToolGroups,
} from './engine/permission/index.js';
export type { PermissionCheckInput, ApprovalRequest, ApprovalDecision } from './engine/permission/index.js';

export {
  loadProtectedPaths,
  checkPath,
  clearProtectedPathsCache,
  ProtectedPathsStore,
} from './engine/security/index.js';
export type {
  ProtectedPathsPolicy,
  ProtectedPathCheckResult,
  ProtectedPathsOverride,
  ProtectedPathsStoreOptions,
  ProtectedPathsRaw,
} from './engine/security/index.js';

export { FileProfileStore } from './storage/profile-store.js';
export { JsonStore } from './storage/json-store.js';
export type { JsonStoreConfig } from './storage/json-store.js';
export { ProjectStore } from './storage/project-store.js';
export type { ProjectStoreConfig } from './storage/project-store.js';
export { McpRegistryStore } from './storage/mcp-registry-store.js';
export type {
  McpRegistryStoreConfig,
  AddMcpRegistryEntryInput,
  UpdateMcpRegistryEntryInput,
} from './storage/mcp-registry-store.js';
export { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig } from './storage/runtime-settings.js';
export type { RuntimeSettings, LlmGatewayRuntimeSettings } from './storage/runtime-settings.js';
export { estimateTokens, calibrateCharsPerToken, RATIO_EWMA_ALPHA } from './engine/context/token-ratio.js';
export { createLocalAuth } from './auth/local.js';
export type { AuthKit, LocalAuthConfig } from './auth/local.js';
export { createSettingsRoutes } from './server/routes/settings.js';
export type { SettingsRoutesDeps } from './server/routes/settings.js';
export { createDictionaryRoutes } from './server/routes/dictionaries.js';
export type { DictionaryRoutesAuth, DictionaryRoutesOptions } from './server/routes/dictionaries.js';
export { createStandaloneApp } from './server/app.js';
export type { StandaloneConfig } from './server/app.js';
export { serializeSession, serializeMessage, serializeProject } from './server/serialize.js';

export {
  GatewayProvider,
  ObfuscationMapStore,
  AuditLogger,
  RateLimiter,
  runInputGuard,
  runOutputGuard,
  detectSecrets,
  maskSecret,
  DEFAULT_PATTERNS,
  SecretPatternStore,
  obfuscateSecrets,
  deobfuscateSecrets,
  restoreSecrets,
  PLACEHOLDER_PATTERN,
  readAuditLog,
  PayloadLogger,
  writePayloadLog,
  readPayloadLog,
} from './engine/gateway/index.js';
export type {
  GatewayProviderOptions,
  InputGuardResult,
  InputGuardMeta,
  OutputGuardResult,
  AuditEventType,
  AuditEntry,
  AuditLogQuery,
  ObfuscateResult,
  SecretPattern,
  SecretDetectorPattern,
  LlmPayloadEntry,
  PayloadLogQuery,
} from './engine/gateway/index.js';

export {
  RemoteBackendClient,
  discover,
  startDeviceFlow,
  pollDeviceToken,
  refreshAccessToken,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  RemoteSession,
  RemoteError,
  RemoteEventBridge,
} from './remote/index.js';
export type {
  Origin,
  RemoteAuthType,
  RemoteCredentials,
  RemoteErrorCode,
  RemoteUser,
  RemoteClientOptions,
  RemoteAuthStatus,
  RequestOptions,
  DeviceFlowDiscovery,
  DeviceFlowSession,
  DeviceTokenResult,
  RefreshTokenResult,
  RemoteSessionOptions,
  RemoteSessionAuthStatus,
  DeviceCodeInfo,
  RemoteConfig,
  RemoteEventBridgeOptions,
} from './remote/index.js';

export {
  getProfilesPath,
  profileIdForUrl,
  loadProfiles,
  listProfiles,
  getLastProfile,
  findProfileByUrl,
  ensureProfile,
  removeProfile,
} from './profiles.js';
export type { ProfileMeta, ProfilesFile } from './profiles.js';
