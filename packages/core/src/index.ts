// @itphx/synth-core — ядро системы
// Содержит общую реализацию для standalone и backend режимов

export { FileStore } from './storage/file-store.js';
export type { StorageConfig } from './storage/file-store.js';
export { SessionManager } from './sessions/manager.js';
export { parseTtl, startEphemeralSweeper, DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS } from './sessions/ephemeral.js';
export { computeSessionStats, MAX_SUBAGENT_DEPTH } from './sessions/stats.js';
export type { SessionStatsDeps } from './sessions/stats.js';
export { EventBus, sseEventStream } from './events/bus.js';
export { HookBus, HOOK_ASYNC_TIMEOUT_MS } from './engine/hooks/index.js';
export type { HookHandler, HookRegistrationOptions, HookEmitResult } from './engine/hooks/index.js';
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
export { syncProvidersFromEnv } from './providers/sync-from-env.js';

export {
  debug,
  info,
  warning,
  error,
  critical,
  setLevelForGroup,
  getAllGroups,
  setGroups,
  setAllGroups,
  resetGroupOverrides,
  LOG_LEVEL_NAMES,
} from './logger.js';

export { DebugCollector } from './debug.js';

export { ContextConfig, ContextBuilder, isInterviewCompleted } from './engine/context/index.js';
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
export {
  detectRuntimeDeps,
  resetRuntimeDepsCache,
  isRuntimeDepAvailable,
  probeBinary,
  ALL_RUNTIME_DEPS_AVAILABLE,
  RUNTIME_DEP_BINARY,
  TOOL_RUNTIME_DEP,
} from './engine/tools/runtime-deps.js';
export type { RuntimeDeps, RuntimeDependency } from './engine/tools/runtime-deps.js';
export { createAgentRegistry, AgentRegistry, loadSystemAgentDefinitions, normalizeAgentModes, isModeApplicable, DEFAULT_AGENT_ID } from './engine/agents/index.js';
export { McpClient, McpManager } from './engine/mcp/index.js';
export type { McpToolDef, McpToolResult } from './engine/mcp/index.js';
export { resolveMcpScope } from './engine/mcp/index.js';
export type { McpScopeServer, McpScopeSession, McpScopeDecision } from './engine/mcp/index.js';
export {
  evaluateMcpNetworkAccess,
  isIpInCidr,
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
export type { JsonStoreConfig, JsonStoreLike } from './storage/json-store.js';
// AD-076 §T2: шифрование секретов at-rest и хранилище SSH-ключей.
export * as crypto from './security/crypto.js';
export {
  CryptoError,
  SecretDecryptionError,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  resolveMasterKey,
} from './security/crypto.js';
export type {
  CryptoErrorCode,
  ResolveMasterKeyOptions,
  MasterKeyResult,
} from './security/crypto.js';
export { SSHKeyStore, SSHKeyStoreError } from './storage/ssh-key-store.js';
export type {
  SSHKeyStoreConfig,
  SSHKeyStoreErrorCode,
  RotateMasterKeyOptions,
  RotateMasterKeyResult,
} from './storage/ssh-key-store.js';
// AD-076: one-shot ротация мастер-ключа секретов (SSH-ключи).
export { rotateSecretsMasterKey, MasterKeyRotationError } from './security/rotate.js';
export type {
  RotateSecretsMasterKeyOptions,
  RotateSecretsMasterKeyResult,
  MasterKeyRotationErrorCode,
  MasterKeySource,
} from './security/rotate.js';
// AD-076 §T3: git-сервис ядра, SSH-окружение и фабрика git-роутов.
export { GitService, resolveRepoPath, deriveRepoName } from './git/git-service.js';
export type { GitEnvOptions, GitFetchOptions } from './git/git-service.js';
export { isSshUrl, createSshEnv, SshEnvError } from './git/ssh-env.js';
export type { CreateSshEnvOptions, SshEnv, SshEnvErrorCode } from './git/ssh-env.js';
export { createGitRoutes } from './server/routes/git.js';
export type { GitRoutesAuth, GitProjectStore, GitRoutesOptions } from './server/routes/git.js';
// AD-014/AD-017/AD-075: единая фабрика проектов (standalone и managed через opts).
export { createProjectRoutes } from './server/routes/projects.js';
export type {
  ProjectRoutesAuth,
  ProjectRoutesOptions,
  ProjectRouteMessages,
  ProjectStatsSource,
} from './server/routes/projects.js';
// AD-075: единая project-aware фабрика FS-роутов (standalone + managed через opts).
export { createFsRoutes } from './server/routes/fs.js';
export type { FsRoutesOptions, FsRoutesAuth } from './server/routes/fs.js';
export { resolveProjectWorkspace, isTextFile } from './server/fs-workspace.js';
export type { ResolveProjectWorkspaceOptions } from './server/fs-workspace.js';
// AD-076 §T5: SSH-ключи агентов (flat + nested-роуты).
export { createSshKeyRoutes, createAgentSshKeyRoutes } from './server/routes/ssh-keys.js';
export type { SshKeyRoutesAuth, SshKeyRoutesOptions } from './server/routes/ssh-keys.js';
export { ProjectStore } from './storage/project-store.js';
export type { ProjectStoreConfig, ProjectStoreLike } from './storage/project-store.js';
export { McpRegistryStore } from './storage/mcp-registry-store.js';
export type {
  McpRegistryStoreConfig,
  AddMcpRegistryEntryInput,
  UpdateMcpRegistryEntryInput,
} from './storage/mcp-registry-store.js';
// AD-089: реестр биндингов внешних событий и журнал обработки/решений Router.
export { EventBindingStore, EVENT_BINDINGS_SCHEMA_VERSION } from './storage/event-binding-store.js';
export type { EventBindingStoreConfig, UpsertEventBindingInput } from './storage/event-binding-store.js';
export { EventJournalStore } from './storage/event-journal-store.js';
export type { EventJournalStoreConfig, EventJournalEntry } from './storage/event-journal-store.js';
// AD-051 (срез) / AD-089: реестр расписаний планировщика.
export { ScheduleStore, SCHEDULES_SCHEMA_VERSION } from './storage/schedule-store.js';
export type { ScheduleStoreConfig, ScheduleRunUpdate } from './storage/schedule-store.js';
// AD-051: append-only история срабатываний расписаний.
export { JobStore } from './storage/job-store.js';
export type { JobStoreConfig, JobListOptions } from './storage/job-store.js';
// AD-089: ядро маршрутизации событий и единый funnel создания сессии.
export { EventRouter } from './engine/events/event-router.js';
export type { EventRouterDeps } from './engine/events/event-router.js';
export { EventIngress } from './engine/events/ingest.js';
export type { EventIngestInput, EventIngressDeps } from './engine/events/ingest.js';
export {
  RequestSessionService,
  eventToMessage,
  eventToMessageText,
} from './engine/events/request-session.js';
export type {
  RequestSessionOptions,
  RequestSessionServiceDeps,
} from './engine/events/request-session.js';
export type {
  EventDelivery,
  EventRouterConfig,
  RouteRuleInput,
  RouteRuleProvider,
  SessionResolution,
} from './engine/events/types.js';
// AD-051 (срез) / AD-089: планировщик расписаний (cron/interval).
export {
  nextCronDate,
  isValidCron,
  parseDurationMs,
  isValidDuration,
  nextRunAt,
  SchedulerRuleProvider,
  SchedulerService,
  startScheduler,
  DEFAULT_SCHEDULER_TICK_MS,
} from './engine/scheduler/index.js';
export type { ScheduleTrigger, SchedulerServiceDeps } from './engine/scheduler/index.js';
// AD-046: скиллы (реестр/discovery/каталог/instance-запись/роуты).
export { SkillService } from './engine/skills/service.js';
export type { SkillServiceOptions, SkillListOptions } from './engine/skills/service.js';
export { SkillRegistry } from './engine/skills/registry.js';
export type { SkillRegistryOptions } from './engine/skills/registry.js';
export { buildSkillSources, scanSkillSource, mergeSkillScans } from './engine/skills/discovery.js';
export { buildSkillCatalog, formatSkillsCatalogBlock, toSkillSummary } from './engine/skills/catalog.js';
export type { ComposerSkillEntry, ComposerSkillsCatalog, BuildSkillCatalogOptions } from './engine/skills/catalog.js';
export { parseSkillFile } from './engine/skills/parser.js';
export { SkillWatcher } from './engine/skills/watcher.js';
export type {
  SkillSource,
  DiscoveredSkill,
  SkillScanResult,
  SkillCatalogOptions,
  SkillScopeOptions,
  LoadedSkill,
  SkillRuntime,
  SkillOrigin,
} from './engine/skills/types.js';
export { resolveProjectSkillSeed, resolveProjectMcpSeed } from './engine/skills/seed.js';
export { migrateSessionScopeSnapshots, SESSION_SCOPE_SNAPSHOT_MIGRATION } from './storage/migrations.js';
export type { SessionScopeMigrationDeps } from './storage/migrations.js';
export { SkillStore } from './storage/skill-store.js';
export type { SkillStoreConfig, CreateSkillInput, UpdateSkillMarkdownInput } from './storage/skill-store.js';
export { createSkillRoutes } from './server/routes/skills.js';
export type { SkillRoutesDeps, SkillRoutesOptions, SkillRoutesMessages } from './server/routes/skills.js';
// AD-069 §9.3: прозрачность проектных инструкций (резолвер снимка + API-роут).
export {
  ProjectInstructionsResolver,
  buildInstructionsInfo,
  createInstructionsInfoResolver,
  resolveInstructionsTrusted,
} from './engine/context/instructions.js';
export type {
  InstructionsTrustOptions,
  InstructionsInfo,
  InstructionsInfoQuery,
  InstructionsInfoResolver,
  InstructionsReportDiagnostic,
  InstructionsReportFile,
  InstructionsReportLevel,
} from './engine/context/instructions.js';
export { createContextRoutes } from './server/routes/context.js';
export type {
  ContextRoutesOptions,
  ContextRoutesMessages,
  ContextProjectStore,
} from './server/routes/context.js';
// AD-046 §7: slash-команды и bundles.
export { CommandService } from './engine/commands/service.js';
export type { CommandServiceOptions, CommandSkillSource } from './engine/commands/service.js';
export { CommandRegistry } from './engine/commands/registry.js';
export { buildCommandSources, scanCommandSource, mergeCommandScans } from './engine/commands/discovery.js';
export { parseCommandFile } from './engine/commands/parser.js';
export { renderTemplate } from './engine/commands/template.js';
export { parseBundleFile, loadBundle } from './engine/commands/bundles.js';
export { parseCommandInput, resolveCatalog } from './engine/commands/resolver.js';
export { BUILTIN_COMMANDS, isBuiltinCommand, renderHelp, renderSkillsList, renderCommandsList } from './engine/commands/builtin.js';
export type {
  TemplateCommand,
  CommandSource,
  CommandScanResult,
  CommandConflictConfig,
  CommandRuntimeConfig,
  CommandContext,
  CommandSkillEntry,
  CommandCatalog,
  CommandEntry,
  LoadedBundle,
} from './engine/commands/types.js';
export { SkillBundleStore } from './storage/skill-bundle-store.js';
export type { SkillBundleStoreConfig } from './storage/skill-bundle-store.js';
export { createCommandRoutes } from './server/routes/commands.js';
export type { CommandRoutesDeps, CommandRoutesOptions, CommandRoutesMessages } from './server/routes/commands.js';
export { createSkillBundleRoutes } from './server/routes/skill-bundles.js';
export type { SkillBundleRoutesDeps, SkillBundleRoutesOptions, SkillBundleRoutesMessages } from './server/routes/skill-bundles.js';
export { createSessionSkillScopeRoutes, createProjectSkillScopeRoutes, createSkillSettingsRoutes } from './server/routes/skill-scope.js';
export type { SkillScopeRoutesDeps, SkillScopeRoutesOptions } from './server/routes/skill-scope.js';
export { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig, mergeMcpNetworkPolicy } from './storage/runtime-settings.js';
export type { RuntimeSettings, LlmGatewayRuntimeSettings } from './storage/runtime-settings.js';
export { estimateTokens, calibrateCharsPerToken, RATIO_EWMA_ALPHA } from './engine/context/token-ratio.js';
export { createLocalAuth } from './auth/local.js';
export type { AuthKit, LocalAuthConfig } from './auth/local.js';
// Standalone: устойчивый локальный API-ключ ({dataDir}/secrets/api-key).
export { localApiKeyFilePath, resolveOrCreateLocalApiKey } from './auth/local-key.js';
export { createSettingsRoutes } from './server/routes/settings.js';
export type { SettingsRoutesDeps } from './server/routes/settings.js';
export { createDictionaryRoutes } from './server/routes/dictionaries.js';
export type { DictionaryRoutesAuth, DictionaryRoutesOptions } from './server/routes/dictionaries.js';
export { createProviderRoutes } from './server/routes/providers.js';
export type { ProviderRoutesAuth, ProviderRoutesOptions, ProviderRouteMessages } from './server/routes/providers.js';
export { createModelRoutes } from './server/routes/models.js';
export type { ModelRoutesAuth, ModelRoutesOptions, ModelRouteMessages } from './server/routes/models.js';
export { createAgentRoutes } from './server/routes/agents.js';
export type { AgentRoutesAuth, AgentRoutesOptions, AgentRouteMessages } from './server/routes/agents.js';
export { createMcpRoutes } from './server/routes/mcp.js';
export type { McpRoutesAuth, McpRoutesDeps, McpRouteMessages } from './server/routes/mcp.js';
export { createEventRoutes } from './server/routes/events.js';
export type {
  EventRoutesAuth,
  EventRoutesDeps,
  EventRoutesOptions,
  EventRouteMessages,
} from './server/routes/events.js';
export { createSchedulerRoutes } from './server/routes/schedules.js';
export type {
  SchedulerRoutesAuth,
  SchedulerRoutesDeps,
  SchedulerRoutesOptions,
  SchedulerRouteMessages,
} from './server/routes/schedules.js';
export { createMessageRoutes } from './server/routes/messages.js';
export type { MessageRoutesAuth, MessageRoutesOptions, MessageRouteMessages } from './server/routes/messages.js';
export { createQueueRoutes } from './server/routes/queue.js';
export type { QueueRoutesAuth, QueueRoutesOptions, QueueRouteMessages } from './server/routes/queue.js';
export { createSessionRoutes } from './server/routes/sessions.js';
export type { SessionRoutesAuth, SessionRoutesDeps, SessionRoutesOptions, SessionRouteMessages } from './server/routes/sessions.js';
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
