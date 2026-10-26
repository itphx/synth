// @itphx/synth-core — ядро системы
// Содержит общую реализацию для standalone и backend режимов

export { FileStore } from './storage/file-store.js';
export type { StorageConfig } from './storage/file-store.js';
export { SessionManager } from './sessions/manager.js';
export { parseTtl, startEphemeralSweeper, DEFAULT_EPHEMERAL_SWEEP_INTERVAL_MS } from './sessions/ephemeral.js';
export { computeSessionStats, MAX_SUBAGENT_DEPTH } from './sessions/stats.js';
export type { SessionStatsDeps } from './sessions/stats.js';
export { EventBus, INSTANCE_EVENT_CHANNEL, sseEventStream } from './events/bus.js';
export { extractChildSessionId, extractCreatedSession } from './events/child-session.js';
export type { CreatedSessionTarget } from './events/child-session.js';
export { HookBus, HOOK_ASYNC_TIMEOUT_MS } from './engine/hooks/index.js';
export type { HookHandler, HookRegistrationOptions, HookEmitResult } from './engine/hooks/index.js';
// ADR-090: загрузчик плагинов (`PluginHost`). Ф1: исполнение кода
// выключено по умолчанию (`plugins.executionEnabled=false`); Ф4а — `inline`
// загрузчик кода (`createInlinePluginLoader`).
export { PluginHost, DEFAULT_EXTENSION_CONTRACT_VERSION } from './engine/plugins/index.js';
export {
  PLUGIN_ACTIVATION_STEPS,
  PLUGIN_FACADE_ERROR_CODES,
  PluginFacadeError,
  PluginLoadError,
  computePluginContentHash,
  pluginLoadFailureReason,
  verifyPluginIntegrity,
  readExactHostExceptions,
  // PROP-047 §2.1: namespace памяти плагина и scoped-обёртка над портами.
  PLUGIN_MEMORY_NAMESPACE_PREFIX,
  createScopedMemory,
  pluginMemoryNamespace,
  // ADR-090 (WP-F): сервис эмбеддингов фасада и ридер настроек плагина.
  MAX_PLUGIN_EMBED_BATCH,
  MAX_PLUGIN_EMBED_TEXT_CHARS,
  MAX_PLUGIN_EMBED_TOTAL_CHARS,
  createPluginEmbedService,
  createPluginSettingsReader,
} from './engine/plugins/index.js';
export type {
  PluginHostOptions,
  PluginActivationDescriptor,
  PluginActivationHandle,
  PluginActivationResult,
  PluginActivationStep,
  PluginDeactivationResult,
  PluginDisposer,
  PluginEmbedFn,
  PluginEmbedOptions,
  PluginFacade,
  PluginFacadeErrorCode,
  PluginLoadFailureReason,
  PluginLoader,
  PluginLogger,
  PluginMemoryPorts,
  PluginModule,
  PluginScanHook,
  PluginScanResult,
  PluginIntegrityVerdict,
  PluginSettingsReader,
  PluginToolDefinition,
} from './engine/plugins/index.js';
// ADR-090 (Ф4а): загрузчик кода плагина из распакованного бандла.
export {
  DEFAULT_MAX_PLUGIN_BUNDLE_BYTES,
  DEFAULT_PLUGIN_ENTRY,
  PLUGIN_BUNDLE_EXTENSIONS,
  createInlinePluginLoader,
} from './engine/plugins/index.js';
export type { InlinePluginLoaderOptions } from './engine/plugins/index.js';
// ADR-090 (Ф4б-1/Ф4б-2): клиент wire-протокола, удалённый
// загрузчик, менеджер процесса и токен-файл инстанса.
export {
  DEFAULT_PLUGIN_HEALTH_TIMEOUT_MS,
  DEFAULT_PLUGIN_READY_TIMEOUT_MS,
  DEFAULT_PLUGIN_SERVER_ENTRY,
  DEFAULT_PLUGIN_STOP_TIMEOUT_MS,
  DEFAULT_REMOTE_PLUGIN_TIMEOUT_MS,
  LOOPBACK_PLUGIN_HOSTS,
  PLUGIN_TOKEN_FILE,
  PluginProcessManager,
  RemotePluginClient,
  RemotePluginUnavailableError,
  createRemotePluginLoader,
  pluginTokenPath,
} from './engine/plugins/index.js';
export type {
  PluginProcessHandle,
  PluginProcessManagerOptions,
  RemotePluginClientOptions,
  RemotePluginFetch,
  RemotePluginLoaderOptions,
  RemotePluginProcess,
  RemotePluginUnavailableReason,
} from './engine/plugins/index.js';
// ADR-090 (Ф5а): сервис установки/подтверждения/снятия плагина.
export {
  PluginInstaller,
  collectBundleFiles,
  readPluginManifest,
  resolvePluginEntry,
} from './engine/plugins/index.js';
export type {
  CollectedBundle,
  PluginInstallFromSourceRequest,
  PluginInstallOutcome,
  PluginInstallRequest,
  PluginInstallerDeps,
  PluginManifestReadResult,
  PluginRollbackOutcome,
  PluginUninstallResult,
  PluginUpdateOptions,
  PluginUpdateOutcome,
} from './engine/plugins/index.js';
// ADR-090 (Д1): свой tar-ридер и резолвинг dir/archive/npm/url.
export { extractPluginArchive, PluginArchiveError } from './engine/plugins/index.js';
export type { ExtractedArchive, TarExtractLimits } from './engine/plugins/index.js';
// ADR-090 Ф7: серверная политика плагинов в гибридном режиме (allow-list,
// статусы проверки сервером) — ядро enforcement'а.
export {
  resolvePluginServerPolicy,
  describePluginServerPolicy,
  pluginServerPolicyStatus,
} from './engine/plugins/hybrid-policy.js';
export {
  DEFAULT_PLUGIN_DOWNLOAD_MAX_BYTES,
  PLUGIN_INSTALL_SOURCE_KINDS,
  PluginSourceError,
  inferPluginSourceKind,
  isPluginInstallSourceKind,
  isValidNpmPackageName,
  resolvePluginSource,
} from './engine/plugins/index.js';
export type {
  PluginInstallSourceKind,
  PluginSourceContext,
  PluginSourceErrorCode,
  PluginSourceRequest,
  ResolvedPluginSource,
} from './engine/plugins/index.js';
// ADR-090 (Ф5б-1): рантайм плагинов — старт-активация установленного,
// список со статусом активации, `dispose`.
export { PluginRuntime } from './engine/plugins/index.js';
export type { PluginRuntimeDeps, PluginRuntimeEntry } from './engine/plugins/index.js';
// PROP-068 §4.3 / ADR-090 (Ф2): статический сканер расширений — правила,
// квоты, `.skillignore`, кэш сканов и дефолтный хук скана.
export {
  BINARY_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  INVISIBLE_UNICODE_PATTERNS,
  PLUGIN_IGNORE_FILE,
  PLUGIN_SCAN_RULES,
  PluginScanCache,
  createPluginScanHook,
  isBinaryContent,
  isExecutableFile,
  isIgnored,
  parseIgnorePatterns,
  scanPluginDirectory,
  scanPluginFiles,
} from './engine/plugins/scan/index.js';
export type {
  IgnorePattern,
  PluginScanEntry,
  PluginScanHookOptions,
  PluginScanOptions,
  PluginScanReport,
  ScanRule,
  ScanRuleContext,
} from './engine/plugins/scan/index.js';
// ADR-090 (Ф2): раскладка слоя плагинов на диске + карантин.
export {
  ensurePluginLayout,
  pluginBundleDirName,
  pluginInstalledDir,
  pluginQuarantineDir,
  releaseFromQuarantine,
  resolvePluginLayout,
  stagePluginBundle,
} from './engine/plugins/layout.js';
export type {
  PluginBundleStageInput,
  PluginBundleStageResult,
  PluginIntegrityFile,
  PluginLayout,
} from './engine/plugins/layout.js';
export { QueueProcessor, QueueProcessorManager, enqueueUserMessage, enqueueSteerMessage } from './queue/processor.js';
export type { ProcessMessageFn, SteerEnqueueResult } from './queue/processor.js';

export {
  ProviderFactory,
  BaseProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  RemoteProvider,
  DecisionProvider,
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
// ADR-090 (Ф3а): реестр провайдеров блоков системного
// промпта — **один** экземпляр на инстанс (композер + фасад плагинов).
export { PromptBlockRegistrationError, PromptBlockRegistry } from './engine/context/index.js';
export type { PromptBlockRegistrationOptions, RegisteredPromptBlock } from './engine/context/index.js';
// ADR-101 §10: суженный «session-like» контракт Composer'а (шаг пайплайна — не сессия).
export type { ComposerSessionLike } from './engine/context/index.js';

export { ChatOrchestrator } from './engine/orchestrator.js';
export type { OrchestratorOptions, ProcessMessageResult, ModelPricing } from './engine/orchestrator.js';
export { runSubagentResume, validateSubagentResume, SubagentResumeError } from './engine/tools/task-resume.js';
export type { SubagentResumeDeps, SubagentResumeOptions, SubagentResumeResult, SubagentResumeErrorCode } from './engine/tools/task-resume.js';
export { SUBAGENT_MAX_ATTEMPTS, SUBAGENT_RETRY_DELAYS_MS } from './engine/tools/task.js';
export type { SubagentRetryConfig, SubagentRunConfig } from './engine/tools/task.js';

export { ModelRouter, ContentClassifier, ProviderPool, QualityChecker, DictionaryStore, toCoreProviderConfig, DICTIONARY_LANGUAGES, DICTIONARY_MAX_KEYWORDS, DICTIONARY_MAX_TOOLS } from './engine/router/index.js';
export type { StoredDictionary, DictionaryLanguage } from './engine/router/index.js';
export type { RoutingRequest, RoutingDecision, ContentCategory, ClassifyRequest, ClassifyResult, QualityCheckInput, QualityCheckResult } from './engine/router/index.js';

export { createToolRegistry, ToolRegistry } from './engine/tools/index.js';
// Этап 1 roadmap 0.13 (блок 3): подсистема «вопрос пользователю» (`ask_user`) —
// сервис (постановка/ожидание/ответ/отмена), retention-очистка и типизированные
// ошибки. Публично: managed-backend собирает тот же сервис (паритет core↔backend).
export {
  QuestionService,
  startQuestionPruner,
  validateAnswers,
  MAX_FREE_ANSWER_LENGTH,
  QUESTION_ERROR_CODES,
  QuestionError,
  QuestionNotFoundError,
  QuestionAlreadySettledError,
  QuestionInvalidAnswerError,
} from './engine/question/index.js';
export type {
  QuestionServiceOptions,
  QuestionLogger,
  QuestionPrunerOptions,
  QuestionAskInput,
  QuestionOutcome,
  QuestionListFilter,
  QuestionErrorCode,
  QuestionInvalidAnswerReason,
} from './engine/question/index.js';
// Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096 —
// фоновые саб-агенты, PROP-097 — фоновые шелл-процессы): сервис реестра,
// retention-очистка и типизированные ошибки. Публично: managed-backend собирает
// тот же сервис (паритет core↔backend).
export {
  BackgroundRunService,
  startBackgroundRunPruner,
  buildSubagentNotification,
  buildProcessNotification,
  createBackgroundParentNotifier,
  processLogPath,
  PROCESS_LOG_DIR,
  BACKGROUND_RUN_ID_PREFIX,
  BACKGROUND_TERMINAL_STATUSES,
  BACKGROUND_ERROR_CODES,
  BackgroundRunError,
  BackgroundLimitExceededError,
} from './engine/background/index.js';
export type {
  BackgroundRunServiceOptions,
  BackgroundRunPrunerOptions,
  BackgroundParentNotifierDeps,
  BackgroundErrorCode,
  BackgroundFinalState,
  BackgroundFinishPatch,
  BackgroundLogger,
  BackgroundProcessInput,
  BackgroundRunLimits,
  BackgroundRunState,
  BackgroundSubagentInput,
} from './engine/background/index.js';
// PROP-097 (блок 5b): фоновые шелл-процессы — сервис запуска/остановки,
// retention-очистка логов и типизированные ошибки. Публично: managed-backend
// собирает тот же сервис (паритет core↔backend).
export {
  ProcessService,
  startProcessLogPruner,
  BackgroundUnsupportedError,
  ProcessError,
  PROCESS_ERROR_CODES,
  PROCESS_LOG_FLUSH_BYTES,
  PROCESS_LOG_FLUSH_INTERVAL_MS,
  PROCESS_LOG_TAIL_LIMIT,
} from './engine/processes/index.js';
export type {
  ProcessLogPrunerOptions,
  ProcessErrorCode,
  ProcessLimits,
  ProcessLogger,
  ProcessLogsOptions,
  ProcessLogsResult,
  ProcessServiceOptions,
  ProcessSpawnInput,
  ProcessSpawnResult,
} from './engine/processes/index.js';
// ADR-090: единая точка исполнения тулов (`safeParse → execute → catch`) и
// сужение контекста для плагинных тулов. Публичны для managed-backend:
// портал памяти вызывает админ-тул плагина через реестр тулов (ADR-107, М2).
export { executeToolDef, narrowToolContext, buildDenyResult } from './engine/tools/tool-execution.js';
export type { SecurityMessageSource, BuildDenyResultParams } from './engine/tools/tool-execution.js';
// ADR-101/ADR-051: рантайм автоматизации для встроенных тулов
// (`pipeline_*`/`schedule_*`) — порты хранилища + движок пайплайнов и
// шедулер. Передаётся в тул через `ToolContext.extra.automation`.
export type { AutomationRuntime } from './engine/tools/automation-runtime.js';
// ADR-077 (шаг 1): порт исполнения команд — интерфейс домена + реализации.
// Домен (тулы shell/rg/git, inline-shell, детект зависимостей) ходит в порт,
// а не в `execFile` напрямую: физический исполнитель взаимозаменяем
// (inline — в процессе; remote — отдельный сервис, шаг 7 плана).
export {
  ExecutionError,
  isExecutionError,
  isExecutionPort,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_BINARY,
  EXECUTION_BASE_CAPABILITIES,
  EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
  EXECUTION_SECRETS_UNSUPPORTED_CODE,
} from './execution/ports/index.js';
export type {
  ExecutionPort,
  ExecRequest,
  ExecResult,
  ExecCommand,
  ExecSecret,
  ExecFailureReason,
  ExecutionErrorInit,
  ExecutionCapabilitySummary,
  ExecutionBaseCapability,
  // ADR-094: приёмник метрик исполнения (узкий интерфейс — без реестра).
  ExecutionMetricsOutcome,
  ExecutionMetricsSink,
  ExecBackgroundChunk,
  ExecBackgroundExit,
  ExecBackgroundProcess,
} from './execution/ports/index.js';
export { InlineExecutionPort } from './execution/inline-execution-port.js';
export { resolveExecutionPort, EXECUTION_PORT_KEY } from './execution/tool-port.js';
// ADR-077 (шаг 7b): выбор порта по режиму `execution.mode` — фабрика
// (`inline` → InlineExecutionPort, `remote` → удалённый порт из пакета
// `@itphx/synth-executor`, динамический `import()`, fail-closed).
export { createExecutionPortForConfig } from './execution/factory.js';
export {
  createRemoteExecutionPortFromConfig,
  isExecutorPackageAvailable,
  readExecutorToken,
  RemoteExecutionUnavailableError,
} from './execution/remote.js';
// ADR-077 (шаг 3): проверка режима исполнения при старте процесса.
export { checkExecutionMode, assertExecutionModeSupported } from './execution/startup.js';
export type {
  ExecutionStartupCheck,
  ExecutionStartupIssue,
  ExecutionEnvironmentProbe,
} from './execution/startup.js';
export {
  detectRuntimeDeps,
  refreshRuntimeDeps,
  resetRuntimeDepsCache,
  isRuntimeDepAvailable,
  runtimeDepUnavailableDetail,
  runtimeRequires,
  toolRuntimeRequires,
  probeBinary,
  ALL_RUNTIME_DEPS_AVAILABLE,
  RUNTIME_DEP_BINARY,
  RUNTIME_DEPENDENCIES,
  TOOL_RUNTIME_DEP,
} from './engine/tools/runtime-deps.js';
export type { RuntimeDeps, RuntimeDependency } from './engine/tools/runtime-deps.js';
export { createAgentRegistry, AgentRegistry, loadSystemAgentDefinitions, normalizeAgentModes, isModeApplicable, DEFAULT_AGENT_ID, registerStoredAgents } from './engine/agents/index.js';
export { McpClient, McpManager } from './engine/mcp/index.js';
export type { McpToolDef, McpToolResult, McpClientOptions } from './engine/mcp/index.js';
export { syncMcpManagerFromRegistry } from './engine/mcp/index.js';
export {
  McpCredentialError,
  createCredentialFetch,
  createRepositoryCredentialSource,
} from './engine/mcp/index.js';
export type {
  McpCredentialErrorCode,
  McpCredentialSource,
  RepositoryCredentialSourceDeps,
  CredentialFetchOptions,
} from './engine/mcp/index.js';
export { resolveMcpScope, resolveMcpProjectScope } from './engine/mcp/index.js';
export type { McpScopeServer, McpScopeSession, McpScopeDecision } from './engine/mcp/index.js';
export {
  evaluateMcpNetworkAccess,
  isIpInCidr,
  isHttpMcpConfig,
  isLocalHostname,
  isAddressRule,
  hostMatchesRule,
  findHostException,
  findAddressException,
  normalizeIp,
  mappedIpv4,
} from './engine/mcp/index.js';
export type { McpNetworkCheckResult, HostResolver } from './engine/mcp/index.js';

// ADR-105 (Ф2/Ф3): OAuth-клиент, сервис слоя доступов, реестр провайдеров.
export {
  OAuthError,
  OAuthClient,
  OAuthCredentialService,
  OAuthProviderRegistry,
  PendingAuthorizationStore,
  DEFAULT_PENDING_AUTHORIZATION_TTL_MS,
  DEFAULT_PENDING_AUTHORIZATION_MAX_ENTRIES,
  registerOAuthProvidersFromConfig,
  resolveOAuthClientSecret,
  oauthClientSecretEnv,
  oauthClientSecretPath,
  evaluateCredentialBind,
  bindCredentialToConnector,
  CredentialConnectorBindError,
} from './engine/oauth/index.js';
export type {
  OAuthClientAuthMethod,
  OAuthProviderDescription,
  OAuthRevokeResult,
  OAuthTokenSet,
  OAuthErrorCode,
  DeviceAuthorization,
  ExchangeAndStoreInput,
  OAuthCredentialServiceDeps,
  RevokeResult,
  StoreTokensInput,
  OAuthProviderCatalogEntry,
  OAuthProviderRegistration,
  RegisterOAuthProvidersOptions,
  ResolveClientSecretOptions,
  CredentialBindActor,
  CredentialBindDecision,
  CredentialBindInput,
  BindCredentialToConnectorOptions,
  PendingAuthorization,
  PendingAuthorizationInput,
  PendingAuthorizationKind,
  PendingAuthorizationStoreOptions,
} from './engine/oauth/index.js';

// PROP-100 / ADR-071 §2.3.1: единый SSRF/egress-guard исходящих запросов
// (схема + DNS-резолв всех A/AAAA + приватные CIDR + проверка каждого хопа редиректа).
export {
  PRIVATE_EGRESS_POLICY,
  DEFAULT_EGRESS_MAX_HOPS,
  checkEgressUrl,
  fetchWithEgressGuard,
  sanitizeEgressTarget,
  EgressBlockedError,
  isBlockedHost,
  isBlockedIp,
} from './engine/net/egress-guard.js';
export type {
  EgressCheckResult,
  EgressCheckOptions,
  EgressFetchOptions,
  EgressLogEvent,
  EgressLogSink,
} from './engine/net/egress-guard.js';
export {
  isValidEgressRule,
  validateEgressPolicy,
  createEgressPolicyResolver,
  resolveEgressScope,
} from './engine/net/egress-policy.js';
export type {
  EgressPolicyResolver,
  EgressPolicyFallbacks,
  EgressPolicyValidation,
} from './engine/net/egress-policy.js';
export {
  configureEgressRuntime,
  getEgressRuntime,
  resetEgressRuntime,
  resolveToolsEgressPolicy,
  resolveWebhooksEgressPolicy,
  resolveMcpEgressPolicy,
  currentEgressLog,
} from './engine/net/egress-runtime.js';
export type { EgressRuntime } from './engine/net/egress-runtime.js';
export {
  createEgressLogSink,
  startEgressLogPruner,
  isEgressLogEnabled,
} from './engine/net/egress-log.js';
export type { EgressLogSinkOptions, EgressLogPrunerOptions } from './engine/net/egress-log.js';

export {
  PermissionEvaluator,
  PermissionApprovalManager,
  computePermissionDigest,
  parsePermissionPrincipal,
  deriveSubagentPermission,
  emptyPermissionConfig,
  getToolGroups,
} from './engine/permission/index.js';
export type { PermissionCheckInput, ApprovalRequest, ApprovalDecision } from './engine/permission/index.js';

// ADR-106 Ф3: реестр подтверждений (привязка к ходу + носитель покрывающего гранта).
export { ApprovalRegistry } from './engine/permission/approval.js';
export type {
  ApprovalBinding,
  ApprovalClaimReason,
  ApprovalClaimResult,
  ApprovalCoverageResolver,
  ApprovalRegistryOptions,
} from './engine/permission/approval.js';

// ADR-106 Ф3: покрытие подтверждения (роли инстанса, роль в проекте, политика).
export {
  approvalGrantsForProfile,
  buildApprovalResponderProfile,
  coversApproval,
  createApprovalCoverageResolver,
} from './engine/authority/approval.js';
export type {
  ApprovalProfileResolver,
  ApprovalProjectRole,
  ApprovalResponderProfile,
} from './engine/authority/approval.js';

// ADR-106 Ф1: движок Authority-слоя — резолвер решений «действие × цель».
export {
  AuthorityResolver,
  computeAuthorityApprovalDigest,
  deriveAuthorityTarget,
  authorityActionForTool,
  authorityTargetKindForTool,
  isCoreAuthorityAction,
  AUTHORITY_CORE_ACTIONS,
  compileAuthorityGrantsForTool,
  AuthorityShadowRecorder,
  AuthorityGuard,
} from './engine/authority/index.js';
export type {
  AuthorityAxis,
  AuthorityAxisSource,
  AuthorityApprovalOutcome,
  AuthorityApprovalReason,
  AuthorityDecideOptions,
  AuthorityDecision,
  AuthorityDecisionEffect,
  AuthorityDecisionReason,
  AuthorityEffective,
  AuthorityResolverOptions,
  AuthorityTargetInput,
  DerivedAuthorityTarget,
  AuthorityRuleCompilationInput,
  AuthorityShadowContext,
  AuthorityShadowHook,
  AuthorityShadowInput,
  AuthorityShadowRecorderOptions,
  AuthorityGateHook,
  AuthorityGateResult,
  AuthorityGuardOptions,
} from './engine/authority/index.js';

// ADR-106 Ф4: контекст хода и потолок хода (считаются один раз на ход).
export {
  createAuthorityTurnContext,
  deriveSessionParticipants,
  resolveParticipantRole,
} from './engine/authority/index.js';
export type { AuthorityTurnContext } from './engine/authority/index.js';

// ADR-106 Ф4 (шаг C): режим сессии как потолок — режим по принципалу.
export {
  resolveTurnMode,
  decideSessionModeScope,
  applySessionMode,
  DEFAULT_SESSION_MODE,
} from './engine/authority/mode.js';
export type {
  SessionModeScope,
  SessionModeScopeDecision,
  SessionModeScopeReason,
} from './engine/authority/mode.js';

// ADR-106 Ф4: принципал хода (фиксируется при приёме ввода).
export {
  principalRef,
  parsePrincipalRef,
  samePrincipal,
  sessionOwnerPrincipal,
  resolveTurnPrincipal,
  resolveUserPrincipal,
  userPrincipal,
  agentPrincipal,
  eventPrincipal,
  schedulerPrincipal,
} from './engine/authority/principal.js';

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
// ADR-096 (W2.1): доменные порты слоя хранения + файловая реализация BlobStore.
export { FileBlobStore } from './storage/file-blob-store.js';
export type { FileBlobStoreConfig } from './storage/file-blob-store.js';
// ADR-051/ADR-100: файловая реализация порта пайплайнов.
export { FilePipelineStore } from './storage/file-pipeline-store.js';
export type { FilePipelineStoreConfig } from './storage/file-pipeline-store.js';
// ADR-086 §5: файловая реализация порта реестра установок пакетов.
export { FilePackStore } from './storage/file-pack-store.js';
export type { FilePackStoreConfig } from './storage/file-pack-store.js';
// PROP-047 §2.1 (предпосылка A): файловые реализации портов памяти.
export { FileMemoryFactStore } from './storage/file-memory-fact-store.js';
export type { FileMemoryFactStoreConfig } from './storage/file-memory-fact-store.js';
export { FileMemoryIndexStore } from './storage/file-memory-index-store.js';
export type { FileMemoryIndexStoreConfig } from './storage/file-memory-index-store.js';
// Этап 1 roadmap 0.13: вопросы пользователю и реестр фоновых прогонов.
export { FileQuestionStore } from './storage/file-question-store.js';
export type { FileQuestionStoreConfig } from './storage/file-question-store.js';
export { FileBackgroundRunStore } from './storage/file-background-run-store.js';
export type { FileBackgroundRunStoreConfig } from './storage/file-background-run-store.js';
// Этап 1 roadmap 0.13 (блок 1.4): инвентарь git-worktree'ов (ADR-114).
export { FileWorktreeStore } from './storage/file-worktree-store.js';
export type { FileWorktreeStoreConfig } from './storage/file-worktree-store.js';
// Этап 1 roadmap 0.13 (блок 1.4.1b): сервис worktree'ов (ADR-114) — git-операции,
// lifecycle инвентаря, детект secondary worktree.
export {
  WorktreeService,
  resolveWorktreeName,
  WORKTREE_ERROR_CODES,
  worktreeErrorHttpStatus,
  isWorktreeError,
  WorktreeError,
  WorktreeNotFoundError,
  WorktreeBusyError,
  WorktreeDirtyError,
  WorktreeBranchInvalidError,
  WorktreeNameInvalidError,
  WorktreeNotARepoError,
  WorktreePathExistsError,
  WorktreeGitFailedError,
} from './engine/worktree/index.js';
export type {
  WorktreeServiceOptions,
  WorktreeCreateResult,
  WorktreeSetupResult,
  WorktreeRemoveOptions,
  WorktreePruneResult,
  WorktreeSweepResult,
  WorktreeSecondaryInfo,
  WorktreeErrorCode,
} from './engine/worktree/index.js';
// ADR-114 §6: публикация `worktree.updated` в каналы сессий проекта.
export {
  publishWorktreeUpdated,
  WORKTREE_EVENT_MAX_SESSIONS,
} from './engine/worktree/index.js';
export type {
  WorktreeEventDeps,
  WorktreeEventSessionSource,
} from './engine/worktree/index.js';
// ADR-114 §7.4: стартовый sweep осиротевших записей worktree'ов (фоново,
// без падения старта) — общий хук для core и backend.
export { startWorktreeSweeper } from './engine/worktree/index.js';
export type { WorktreeSweeperTarget } from './engine/worktree/index.js';
export type {
  SessionRepository,
  SessionFilter,
  ProjectRepository,
  CreateProjectData,
  ProfileRepository,
  SettingsRepository,
  McpRegistryRepository,
  McpRegistryManagerMaps,
  ServiceKeyRepository,
  ServiceKeyResolution,
  EventApiKeyRepository,
  EventApiKeyResolution,
  EventBindingRepository,
  EventRouteRepository,
  EventJournalRepository,
  IdentityClaimRepository,
  WebhookRepository,
  WebhookDeliveryRepository,
  ScheduleRepository,
  JobRepository,
  MaintenanceAuditRepository,
  MaintenanceAuditListOptions,
  // ADR-090: журнал аудита плагинов (отдельный порт, не security-аудит).
  PluginAuditRepository,
  PluginAuditListOptions,
  // PROP-068 §4.4 / ADR-090: lock-файл плагинов (`plugins.lock.json`).
  PluginLockRepository,
  SecurityAuditRepository,
  SecurityAuditListOptions,
  EgressRequestLogRepository,
  EgressRequestLogListOptions,
  AnalyticsRollupRepository,
  DedupRepository,
  SecretPatternRepository,
  ProtectedPathsRepository,
  SkillRepository,
  SkillBundleRepository,
  DictionaryRepository,
  ContextFileRepository,
  SSHKeyRepository,
  // ADR-105 (Ф0/Ф1): внешние доступы (OAuth-креды к коннекторам).
  ExternalCredentialRepository,
  ExternalCredentialErrorCode,
  // ADR-105 (Ф4): ротация мастер-ключа для внешних доступов.
  RotateExternalCredentialKeyOptions,
  RotateExternalCredentialKeyResult,
  // ADR-105 (Ф4): журнал операций со слоем доступов (append-only).
  CredentialAuditRepository,
  CredentialAuditListOptions,
  BlobStore,
  DefaultsRepository,
  AppearanceDefaults,
  DocumentRepository,
  // ADR-051/ADR-100: пайплайны; ADR-086 §5: реестр установок пакетов.
  PipelineRepository,
  PipelineDefinitionRecord,
  PipelineInstanceRecord,
  PipelineInstanceFilter,
  PackRepository,
  PackInstallation,
  PackInstallationProvides,
  PackInstallationStatus,
  // ADR-101 (Pipeline Engine): спецификации пайплайнов, прогоны, журнал.
  ProjectPipelineRepository,
  PipelineRecord,
  PipelineVersionRecord,
  PipelineScope,
  PipelineProvenance,
  PipelineFilter,
  PipelineRunRepository,
  PipelineRunRecord,
  PipelineRunEventRecord,
  PipelineRunFilter,
  PipelineRunEventListOptions,
  // ADR-106 (Ф0/Ф1): порты Authority-слоя — политика инстанса и журнал решений.
  AuthorityPolicyRepository,
  AuthorityDecisionJournal,
  AuthorityDecisionListOptions,
  // PROP-047 §2.1 (предпосылка A): порты памяти — факты и индексы с чанками.
  MemoryFactRepository,
  MemoryFactRecord,
  MemoryFactQuery,
  MemoryFactStatus,
  MemoryFactProvenance,
  MemoryFactRevision,
  MemoryIndexRepository,
  MemoryIndexRecord,
  MemoryIndexQuery,
  MemoryIndexScope,
  MemoryIndexState,
  MemoryIndexFingerprint,
  MemoryIndexSource,
  MemoryIndexStats,
  MemoryChunkRecord,
  // Этап 1 roadmap 0.13: вопросы пользователю и реестр фоновых прогонов.
  QuestionRepository,
  BackgroundRunRepository,
  // Этап 1 roadmap 0.13 (блок 1.4): инвентарь git-worktree'ов (ADR-114).
  WorktreeRepository,
} from './storage/ports/index.js';
// ADR-105 (Ф0/Ф1): доменная ошибка хранилища внешних доступов — значение
// (не только тип): её бросают реализации порта, в т.ч. PostgreSQL-драйвер
// (`@itphx/synth-storage-postgres`) через ленивый `import()` core.
export { ExternalCredentialStoreError } from './storage/ports/external-credential-repository.js';
// ADR-096 (W2.2): in-memory реализации портов хранения (второй backend за единым слоем).
export {
  MemorySessionRepository,
  MemoryProjectRepository,
  MemoryProfileRepository,
  MemorySettingsRepository,
  MemoryDefaultsRepository,
  MemorySecretPatternRepository,
  MemoryProtectedPathsRepository,
  MemoryDictionaryRepository,
  MemoryEventBindingRepository,
  MemoryEventRouteRepository,
  MemoryEventJournalRepository,
  MemoryEventApiKeyRepository,
  MemoryIdentityClaimRepository,
  MemoryDedupRepository,
  MemoryMcpRegistryRepository,
  MemoryServiceKeyRepository,
  MemoryWebhookRepository,
  MemoryWebhookDeliveryRepository,
  MemoryScheduleRepository,
  MemoryJobRepository,
  MemoryMaintenanceAuditRepository,
  MemoryPluginAuditRepository,
  MemoryPluginLockRepository,
  MemorySecurityAuditRepository,
  MemoryEgressRequestLogRepository,
  MemoryAnalyticsRollupRepository,
  MemorySkillRepository,
  MemorySkillBundleRepository,
  MemoryContextFileRepository,
  MemoryBlobStore,
  MemorySSHKeyRepository,
  // ADR-051/ADR-100: пайплайны; ADR-086 §5: реестр установок пакетов.
  MemoryPipelineRepository,
  MemoryPackRepository,
  // ADR-101: спецификации пайплайнов, прогоны и журнал выполнения.
  MemoryProjectPipelineRepository,
  MemoryPipelineRunRepository,
  // ADR-105 (Ф1): внешние доступы (OAuth-креды к коннекторам).
  MemoryExternalCredentialRepository,
  MemoryCredentialAuditRepository,
  // Этап 1 roadmap 0.13: вопросы пользователю и реестр фоновых прогонов.
  MemoryQuestionRepository,
  MemoryBackgroundRunRepository,
  // Этап 1 roadmap 0.13 (блок 1.4): инвентарь git-worktree'ов (ADR-114).
  MemoryWorktreeRepository,
} from './storage/memory/index.js';
// PROP-047 §2.1: in-memory реализации портов памяти. Имена классов совпадают с
// именами портов (`MemoryFactRepository`), поэтому в публичном API они
// экспортируются с суффиксом `Impl` (иначе — конфликт имён с типом порта).
export {
  MemoryFactRepository as MemoryFactRepositoryImpl,
  MemoryIndexRepository as MemoryIndexRepositoryImpl,
} from './storage/memory/index.js';
// ADR-096 (W2.4): generic-реализация конфигурационных словарей (провайдеры/модели/агенты).
export { MemoryDocumentRepository } from './storage/memory/document-repository.js';
// ADR-096 (W2.3): умолчания оформления (перенесено из backend) — файловая реализация.
export { DefaultsStore, UI_SCALE_MIN, UI_SCALE_MAX } from './storage/defaults-store.js';
// ADR-096 (W2.3): единый контекст слоя хранения + фабрики `file`/`memory`.
export {
  createFileStorage,
  createMemoryStorage,
  createStorageContext,
  createStorageContextAsync,
  createPostgresStorage,
  buildStorageContext,
  StorageBackendUnavailableError,
} from './storage/storage-context.js';
export type {
  StorageContext,
  StorageContextConfig,
  StorageBackendKind,
  StorageLocks,
  StorageHealth,
  StorageSchemaMigrationResult,
  PostgresSchemaMode,
  PostgresStorageDriverConfig,
  BuildStorageContextOptions,
} from './storage/storage-context.js';
// ADR-099: единый механизм доверия TLS/CA исходящих соединений.
export {
  buildTlsTrust,
  buildTlsTrustProfiles,
  getTlsStatus,
  applyGlobalTlsTrust,
  initTlsTrust,
  configureEgressProxy,
  applyEgressProxyConfig,
  egressFetch,
  isTlsTrustConfigured,
  getTlsCaPath,
  getTlsTrustConfig,
  gitCaConfig,
  gitProxyConfig,
  getEgressProxyStatus,
  TlsDependencyUnavailableError,
  _resetTlsTrustForTests,
} from './security/tls.js';
export type {
  TlsTrust,
  TlsProfileTrust,
  TlsStatus,
  TlsStatusCa,
  TlsStatusClient,
  TlsStatusMapping,
  TlsStatusOptions,
  FetchLike as EgressFetchLike,
  LoadUndici,
  EgressFetchDeps,
  ApplyTlsTrustDeps,
  ApplyEgressProxyDeps,
} from './security/tls.js';
// ADR-099 (D1): HTTP/HTTPS-прокси egress-слоя (dispatcher грузится динамически
// из `security/tls.ts`, чтобы без прокси/доверия `undici` не тянулся).
export { checkProxyConnectivity, checkProxyTarget } from './security/proxy-check.js';
export type {
  ProxyTargetCheckOptions,
  ProxyTargetCheckResult,
  ProxyTargetRouteInfo,
} from './security/proxy-check.js';
export { applyStartupProxyConfig } from './security/proxy-startup.js';
export type { ProxySettingsSource } from './security/proxy-startup.js';
export {
  getProxyPasswordStatus,
  getProxyProfilePasswordStatus,
  proxyPasswordPath,
  proxySecretsDir,
  writeProxyPasswordFile,
  writeProxyProfilePasswordFile,
  removeProxyPasswordFile,
  removeProxyProfilePasswordFile,
  ProxyPasswordFileError,
} from './security/proxy-password.js';
export {
  PROXY_PROFILE_TLS_MATERIALS,
  ProxyTlsSecretFileError,
  proxyProfileSecretsDir,
  proxyProfileTlsFilePath,
  writeProxyProfileTlsFile,
  removeProxyProfileTlsFile,
} from './security/proxy-tls-secrets.js';
export type { ProxyProfileTlsMaterial } from './security/proxy-tls-secrets.js';
export { getEgressProxyConfig, shouldProxyUrl, proxyConfigFingerprint } from './security/proxy-state.js';
export type { EgressProxyStatus, ResolvedProxyConfig, ProxyCheckResult, ProxyPasswordStatus } from '@itphx/synth-shared';
// ADR-076 §T2: шифрование секретов at-rest и хранилище SSH-ключей.
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
// ADR-105 (Ф1): хранилище внешних доступов (OAuth-креды к коннекторам).
export {
  ExternalCredentialStore,
  EXTERNAL_CREDENTIALS_SCHEMA_VERSION,
  EXTERNAL_CREDENTIALS_SUBDIR,
  EXTERNAL_CREDENTIALS_FILENAME,
  EXTERNAL_CREDENTIAL_ID_PREFIX,
} from './storage/external-credential-store.js';
export type { ExternalCredentialStoreConfig } from './storage/external-credential-store.js';
// ADR-076: one-shot ротация мастер-ключа секретов (SSH-ключи).
export { rotateSecretsMasterKey, MasterKeyRotationError } from './security/rotate.js';
export type {
  RotateSecretsMasterKeyOptions,
  RotateSecretsMasterKeyResult,
  MasterKeyRotationErrorCode,
  MasterKeySource,
} from './security/rotate.js';
// ADR-076 §T3: git-сервис ядра, SSH-окружение и фабрика git-роутов.
export { GitService, resolveRepoPath, deriveRepoName } from './git/git-service.js';
export type { GitEnvOptions, GitFetchOptions } from './git/git-service.js';
export { isSshUrl, createSshEnv, SshEnvError } from './git/ssh-env.js';
export type { CreateSshEnvOptions, SshEnv, SshEnvErrorCode } from './git/ssh-env.js';
export { createGitRoutes } from './server/routes/git.js';
export type { GitRoutesAuth, GitProjectStore, GitRoutesOptions } from './server/routes/git.js';
// ADR-014/ADR-017/ADR-075: единая фабрика проектов (standalone и managed через opts).
export { createProjectRoutes } from './server/routes/projects.js';
export type {
  ProjectRoutesAuth,
  ProjectRoutesOptions,
  ProjectRouteMessages,
  ProjectStatsSource,
} from './server/routes/projects.js';
// ADR-089: единый хелпер видимости сессии (списки/доступ по id).
export { isSessionVisible } from './server/session-visibility.js';
export type { SessionOwnerCtx } from './server/session-visibility.js';
// ADR-089 (standalone): единая точка нормализации владельца локального пользователя
// при чтении (legacy-UUID профиля `local` → `local`; списки/доступ/WS-подписка).
export {
  createLocalOwnerResolver,
  LOCAL_USER_ID,
} from './server/local-owner.js';
export type { LocalOwnerResolver, CreateLocalOwnerResolverOptions } from './server/local-owner.js';
// ADR-075: единая project-aware фабрика FS-роутов (standalone + managed через opts).
export { createFsRoutes, DEFAULT_MAX_UPLOAD_BYTES } from './server/routes/fs.js';
export type { FsRoutesOptions, FsRoutesAuth } from './server/routes/fs.js';
export { resolveProjectWorkspace, isTextFile } from './server/fs-workspace.js';
export type { ResolveProjectWorkspaceOptions } from './server/fs-workspace.js';
// ADR-076 §T5: SSH-ключи агентов (flat + nested-роуты).
export { createSshKeyRoutes, createAgentSshKeyRoutes } from './server/routes/ssh-keys.js';
export type { SshKeyRoutesAuth, SshKeyRoutesOptions } from './server/routes/ssh-keys.js';
export { ProjectStore } from './storage/project-store.js';
export type { ProjectStoreConfig, ProjectStoreLike } from './storage/project-store.js';
export { McpRegistryStore } from './storage/mcp-registry-store.js';
export {
  McpRegistryValidationError,
  assertNoMcpSecretHeaders,
  stripMcpSecretHeaders,
} from './storage/mcp-registry-store.js';
export type {
  McpRegistryStoreConfig,
  AddMcpRegistryEntryInput,
  UpdateMcpRegistryEntryInput,
} from './storage/mcp-registry-store.js';
// ADR-105 (Ф3): миграция plaintext-секретов из заголовков реестра в слой доступов.
export { migrateMcpRegistrySecrets } from './storage/mcp-registry-migration.js';
export type {
  MigrateMcpRegistrySecretsDeps,
  MigrateMcpRegistrySecretsResult,
} from './storage/mcp-registry-migration.js';
// ADR-089: реестр биндингов внешних событий и журнал обработки/решений Router.
export { EventBindingStore, EVENT_BINDINGS_SCHEMA_VERSION } from './storage/event-binding-store.js';
export type { EventBindingStoreConfig, UpsertEventBindingInput } from './storage/event-binding-store.js';
// ADR-089/ADR-052: реестр API-ключей привязок (приём событий по ключу).
export {
  EventApiKeyStore,
  EventApiKeyConflictError,
  EVENT_API_KEYS_SCHEMA_VERSION,
  EVENT_API_KEY_SECRET_PREFIX,
} from './storage/event-api-key-store.js';
export type {
  EventApiKeyStoreConfig,
  EventApiKeyRecord,
  CreateEventApiKeyInput,
  UpdateEventApiKeyPatch,
} from './storage/event-api-key-store.js';
// ADR-052 (этап I): service-key — реестр, scopes, проектная проекция, роуты.
export {
  ServiceApiKeyStore,
  ServiceApiKeyConflictError,
  SERVICE_API_KEYS_SCHEMA_VERSION,
  SERVICE_KEY_SECRET_PREFIX,
  isServiceKeySecret,
  applyBootstrapServiceKeys,
  BOOTSTRAP_CREATED_BY,
} from './storage/service-api-key-store.js';
export type {
  ServiceApiKeyStoreConfig,
  ServiceApiKeyRecord,
  ServiceKeyCredential,
  EnsureServiceKeyInput,
  ServiceKeyEnsureStatus,
  BootstrapServiceKeyEntry,
  // Ф7 (ADR-090): вход создания ключа с привязкой к плагину (Уровень 2).
  CreatePluginServiceKeyInput,
} from './storage/service-api-key-store.js';
export {
  requireScope,
  requireScopeOrAdminRole,
  checkServiceProjectProjection,
  checkProjectAccess,
  getServiceCredential,
  isProjectAllowed,
  // Ф7 (ADR-090): server-scoped токен плагина (Уровень 2) — проверка привязки.
  checkPluginTokenBinding,
  requirePluginTokenBinding,
  PLUGIN_TOKEN_ERROR_CODES,
} from './server/service-scope.js';
export type {
  ScopeGuardFactory,
  ServiceProjectProjectionGuard,
  ProjectGuard,
} from './server/service-scope.js';
// Доступ к сессии как инвариант на префиксе роутера (IDOR-класс).
export { createSessionAccessGuard, createSessionAccessPredicate } from './server/session-access-guard.js';
export type {
  SessionAccessGuardOptions,
  SessionAccessPredicate,
  SessionAccessPredicateOptions,
  SessionAccessMessages,
  SessionAccessKind,
} from './server/session-access-guard.js';
// ADR-105 (Ф3): право привязки внешнего доступа к коннектору — на границе.
export { createCredentialBindGuard } from './server/credential-bind-guard.js';
export type {
  CredentialBindGuardMessages,
  CredentialBindGuardOptions,
  CredentialBindViolation,
} from './server/credential-bind-guard.js';
// ADR-036: привилегия карты обфускации при экспорте сессии — route-level guard
// (решение — в контексте Hono, в обработчике проверок доступа нет).
export {
  createSessionExportGuard,
  getSessionExportDecision,
  isSessionExportPath,
  SESSION_EXPORT_CONTEXT_KEY,
} from './server/session-export-guard.js';
export type {
  SessionExportGuardOptions,
  SessionExportDecision,
  SessionExportMessages,
} from './server/session-export-guard.js';
// ADR-106 Ф4 (шаг C): смена режима сессии — привилегия на границе (guard).
export {
  createSessionModeGuard,
  getSessionModeDecision,
  SESSION_MODE_CONTEXT_KEY,
} from './server/session-mode-guard.js';
export type {
  SessionModeGuardOptions,
  SessionModeDecision,
  SessionModeMessages,
} from './server/session-mode-guard.js';
export { createServiceKeyRoutes } from './server/routes/service-keys.js';
export type {
  ServiceKeyRoutesAuth,
  ServiceKeyRoutesDeps,
  ServiceKeyRoutesOptions,
  ServiceKeyRouteMessages,
} from './server/routes/service-keys.js';
// ADR-052 (этап II): исходящие webhooks — реестр подписок и журнал доставок.
export {
  WebhookStore,
  WebhookConflictError,
  WebhookStoreError,
  WEBHOOKS_SCHEMA_VERSION,
} from './storage/webhook-store.js';
export type {
  WebhookStoreConfig,
  WebhookRecord,
  WebhookStoreErrorCode,
  RotateWebhookKeyOptions,
  RotateWebhookKeyResult,
} from './storage/webhook-store.js';
export { WebhookDeliveryStore } from './storage/webhook-delivery-store.js';
export type { WebhookDeliveryStoreConfig } from './storage/webhook-delivery-store.js';
export {
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_SIGNATURE_TOLERANCE_SEC,
  computeWebhookSignature,
  buildSignatureHeader,
  parseSignatureHeader,
  verifyWebhookSignature,
  evaluateWebhookTarget,
  WebhookService,
  computeBackoffMs,
  startWebhookDeliveryPruner,
} from './engine/webhooks/index.js';
export type {
  ParsedSignature,
  WebhookTargetCheckResult,
  WebhookTargetCheckOptions,
  WebhookServiceConfig,
  WebhookServiceDeps,
  WebhookDeliveryPrunerOptions,
} from './engine/webhooks/index.js';
export { createWebhookRoutes } from './server/routes/webhooks.js';
export type {
  WebhookRoutesAuth,
  WebhookRoutesDeps,
  WebhookRoutesOptions,
  WebhookRouteMessages,
} from './server/routes/webhooks.js';
// ADR-091/ADR-092: admin-API обслуживания инстанса (backup/restore/doctor/migrate).
export { createMaintenanceRoutes } from './server/routes/maintenance.js';
export type {
  MaintenanceRoutesAuth,
  MaintenanceRoutesDeps,
  MaintenanceRoutesOptions,
  MaintenanceRouteMessages,
} from './server/routes/maintenance.js';
// Restart из UI: graceful shutdown с кодом 75 + статус режима.
export {
  configureRestart,
  getProcessStartedAt,
  getRestartStatus,
  requestRestart,
  resetRestartForTests,
  resolveRestartMode,
  RESTART_EXIT_CODE,
} from './server/restart.js';
export type {
  ConfigureRestartOptions,
  RestartMode,
  RestartRequestOutcome,
  RestartStatus,
} from './server/restart.js';
// ADR-091 (этап 2): HTTP-перенос проекта — скачать экспорт / импортировать архив.
export { createProjectPortableRoutes } from './server/routes/project-portable.js';
export type {
  ProjectPortableRoutesAuth,
  ProjectPortableRoutesDeps,
  ProjectPortableRoutesOptions,
  ProjectPortableRouteMessages,
} from './server/routes/project-portable.js';
export { EventJournalStore } from './storage/event-journal-store.js';
export type { EventJournalStoreConfig, EventJournalEntry } from './storage/event-journal-store.js';
// ADR-089: retention-очистка журнала событий (периодический pruner).
export { startEventJournalPruner } from './engine/events/journal-prune.js';
export type { EventJournalPrunerOptions } from './engine/events/journal-prune.js';
// ADR-089: реестр правил маршрутизации внешних событий.
export { RouteRuleStore, ROUTE_RULES_SCHEMA_VERSION } from './storage/route-rule-store.js';
export type { RouteRuleStoreConfig, UpsertRouteRuleInput } from './storage/route-rule-store.js';
// ADR-051 (срез) / ADR-089: реестр расписаний планировщика.
export { ScheduleStore, SCHEDULES_SCHEMA_VERSION } from './storage/schedule-store.js';
export type { ScheduleStoreConfig, ScheduleRunUpdate } from './storage/schedule-store.js';
// ADR-051: append-only история срабатываний расписаний.
export { JobStore } from './storage/job-store.js';
export type { JobStoreConfig, JobListOptions } from './storage/job-store.js';
// ADR-092 (остаток): аудит-журнал обслуживания инстанса — файловая реализация порта.
export { MaintenanceAuditStore } from './storage/maintenance-audit-store.js';
export type { MaintenanceAuditStoreConfig } from './storage/maintenance-audit-store.js';
// ADR-105 (Ф4): журнал операций со слоем доступов (append-only JSONL
// `audit/credentials.jsonl`).
export { FileCredentialAuditStore } from './storage/file-credential-audit-store.js';
export type { FileCredentialAuditStoreConfig } from './storage/file-credential-audit-store.js';
// ADR-090: журнал аудита плагинов (append-only JSONL `audit/plugins.jsonl`).
export { FilePluginAuditStore } from './storage/file-plugin-audit-store.js';
export type { FilePluginAuditStoreConfig } from './storage/file-plugin-audit-store.js';
// PROP-068 §4.4 / ADR-090: lock-файл плагинов (`plugins.lock.json`).
export { FilePluginLockStore, defaultPluginLockPath } from './storage/file-plugin-lock-store.js';
export type { FilePluginLockStoreConfig } from './storage/file-plugin-lock-store.js';
// Egress: аудит изменений security-политик и журнал внешних запросов.
export { SecurityAuditStore } from './storage/security-audit-store.js';
export type { SecurityAuditStoreConfig } from './storage/security-audit-store.js';
export { EgressRequestLogStore } from './storage/egress-request-log-store.js';
export type { EgressRequestLogStoreConfig } from './storage/egress-request-log-store.js';
// ADR-102: файловая реализация порта пред-агрегированных роллапов аналитики.
export { AnalyticsRollupStore, ANALYTICS_ROLLUPS_SCHEMA_VERSION } from './storage/analytics-rollup-store.js';
export type { AnalyticsRollupStoreConfig } from './storage/analytics-rollup-store.js';
// ADR-102 (волна 1): сервис чтения отчётов/сводки + дериваты на чтении.
export { AnalyticsService, AnalyticsValidationError, utcDay } from './analytics/service.js';
export type {
  AnalyticsPeriod,
  AnalyticsReportQuery,
  AnalyticsSummaryQuery,
  AnalyticsServiceOptions,
  AnalyticsValidationReason,
} from './analytics/service.js';
// ADR-102 §6: серверная выгрузка отчёта CSV/JSON (только данные).
export { toCsv, toJson } from './analytics/export.js';
// ADR-102 (волна 1): сборщики роллапов (write-path), hook-шов `activity` и retention.
export { AnalyticsRecorder, activityMeasureForMessage, sessionAxes } from './analytics/recorder.js';
export type {
  ActivityMeasure,
  ActivityRollupInput,
  AnalyticsAxes,
  AnalyticsRecorderOptions,
  DecisionMeasure,
  DecisionRollupAttempt,
  DecisionRollupInput,
  UsageMeasure,
  UsageRollupInput,
} from './analytics/recorder.js';
export { attachAnalyticsActivityHooks } from './analytics/hooks.js';
export type { AnalyticsActivityAxes, AttachAnalyticsHooksDeps } from './analytics/hooks.js';
export { analyticsRetentionCutoff, startAnalyticsRollupPruner } from './analytics/prune.js';
export type { AnalyticsRollupPrunerOptions } from './analytics/prune.js';
// ADR-102 §10: идемпотентный бэкфилл роллапов из истории (`synth analytics rebuild`).
export { rebuildAnalyticsRollups } from './analytics/rebuild.js';
export type {
  AnalyticsRebuildOptions,
  AnalyticsRebuildResult,
  RebuildableFamily,
} from './analytics/rebuild.js';
export { runAnalyticsRebuildCommand } from './analytics/rebuild-command.js';
export type { AnalyticsRebuildCommandOptions } from './analytics/rebuild-command.js';
// ADR-092: best-effort запись аудит-событий обслуживания из операций.
export { recordMaintenanceAudit } from './maintenance/audit.js';
export type { MaintenanceAuditRecord } from './maintenance/audit.js';
// ADR-089: ядро маршрутизации событий и единый funnel создания сессии.
export { EventRouter } from './engine/events/event-router.js';
export type { EventRouterDeps } from './engine/events/event-router.js';
// ADR-089 (claim-flow): одноразовые коды подтверждения владения идентичностью.
export { IdentityClaimStore, IDENTITY_CLAIMS_SCHEMA_VERSION, IDENTITY_CLAIM_TTL_SEC, IDENTITY_CLAIM_ALPHABET, IDENTITY_CLAIM_LENGTH } from './storage/identity-claim-store.js';
export type { IdentityClaimRecord, IdentityClaimStoreConfig } from './storage/identity-claim-store.js';
// ADR-051/ADR-089: источник дедупа (in-process / файловый межпроцессный).
export { MemoryDedupStore, FileDedupStore } from './engine/events/dedup-store.js';
export type { DedupStore, FileDedupStoreConfig } from './engine/events/dedup-store.js';
export { EventIngress } from './engine/events/ingest.js';
export type { EventIngestInput, EventIngressDeps } from './engine/events/ingest.js';
// ADR-089/ADR-052: контекст машинной аутентификации по API-ключу привязки.
export type { EventKeyCredential } from './engine/events/credential.js';
// ADR-089/ADR-052: in-memory per-key rate limiter приёма событий.
export { KeyRateLimiter } from './engine/events/key-rate-limiter.js';
export {
  RequestSessionService,
  eventToMessage,
  eventToMessageText,
} from './engine/events/request-session.js';
export type {
  RequestSessionOptions,
  RequestSessionServiceDeps,
  LlmDefaults,
} from './engine/events/request-session.js';
// ADR-089/ADR-051: учёт экземпляров пайплайна (ADR-100) — состояние
// автомата публикации в ядре, артефакт шага — по id.
export { PipelineTracker } from './engine/events/pipeline-tracker.js';
export { pipelineTriggerPayload, pipelineStepArtifact } from './engine/events/pipeline-tracker.js';
export type {
  PipelineTrackerDeps,
  PipelineTrackInput,
  PipelineTrackedInstance,
  PipelineEventArtifact,
  PipelineEventTrigger,
  PipelineEventStepState,
} from './engine/events/pipeline-tracker.js';
export type {
  EventDelivery,
  EventDeliveryContext,
  EventRouterConfig,
  RouteRuleInput,
  RouteRuleProvider,
  SessionResolution,
} from './engine/events/types.js';
// ADR-089: правило маршрутизации по матчу события и маппинг target→decision.
export { ProjectRuleProvider } from './engine/events/project-rule-provider.js';
// ADR-084 × ADR-089: decision-маршрутизация внешних событий (шаблон агента).
export {
  DecisionRuleProvider,
  DECISION_ROUTING_QUESTION_ID,
} from './engine/events/decision-rule-provider.js';
export type {
  DecisionAgentCandidate,
  DecisionRuleProviderDeps,
} from './engine/events/decision-rule-provider.js';
export { decisionFromTarget } from './engine/events/target-decision.js';
// ADR-051 (срез) / ADR-089: планировщик расписаний (cron/interval).
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
  AlwaysLeader,
  FileLeader,
} from './engine/scheduler/index.js';
export type {
  ScheduleTrigger,
  SchedulerServiceDeps,
  SchedulerLeader,
  FileLeaderOptions,
} from './engine/scheduler/index.js';
// ADR-051/ADR-089: файловый мьютекс (общий dataDir на одном хосте/FS).
export { FileMutex } from './storage/file-mutex.js';
export type { FileMutexOptions } from './storage/file-mutex.js';
// ADR-096: контракт межпроцессного мьютекса (file/PG) — общий шов координации.
export type { Mutex, LockOptions, MutexFactoryOptions, LeaderFactoryOptions } from './storage/mutex.js';
// ADR-046: скиллы (реестр/discovery/каталог/instance-запись/роуты).
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
// ADR-092: версионирование схемы данных инстанса, реестр миграций, guard совместимости.
export {
  SCHEMA_VERSION,
  MIGRATIONS,
  SESSION_SCOPE_SNAPSHOTS_MIGRATION_V1,
  InstanceDataTooNewError,
  readInstanceMeta,
  writeInstanceMeta,
  checkInstanceCompatibility,
  assertInstanceDataNotTooNew,
  runMigrations,
} from './storage/instance-meta.js';
export type { InstanceMeta, Migration, MigrationDeps, InstanceCompatibility } from './storage/instance-meta.js';
export { runMigrateCommand } from './maintenance/migrate.js';
export type { MigrateCommandOptions } from './maintenance/migrate.js';
// ADR-097 (волна 5): `synth storage migrate` — идемпотентный перенос данных инстанса между backend'ами (file ↔ postgres).
export { runStorageMigrateCommand, migrateStorageData, STORAGE_MIGRATION_ENTITIES } from './maintenance/storage-migrate.js';
export type {
  StorageMigrateCommandOptions,
  StorageMigrateTarget,
  StorageMigrationReport,
  StorageMigrationEntity,
  MigrateStorageDataOptions,
} from './maintenance/storage-migrate.js';
// ADR-092: `synth update` — проверка/обновление/откат пакета (`--to <version>`), паритет dev-CLI и публичного CLI (PROP-053).
export { runUpdateCommand, operationOf } from './maintenance/update.js';
export type { UpdateCommandOptions, UpdateCommandDeps, UpdateOperation } from './maintenance/update.js';
// ADR-092: авто-миграции при старте (обязательная страховочная копия, лок).
export { applyStartupMigrations, applyPendingRestore } from './maintenance/startup.js';
export type {
  ApplyStartupMigrationsOptions,
  ApplyPendingRestoreOptions,
} from './maintenance/startup.js';
// ADR-091/ADR-092: сервисный слой обслуживания инстанса для admin-API/UI —
// статус (схема/бэкапы/doctor), список/удаление бэкапов, проверка архива и
// отложенное восстановление (применяется при старте).
export {
  getMaintenanceStatus,
  listBackups,
  deleteBackup,
  validateRestoreArchive,
  scheduleRestore,
  getPendingRestore,
  cancelPendingRestore,
  stageUploadedArchive,
  sanitizeBackupName,
  isSafeBackupName,
} from './maintenance/service.js';
export type {
  MaintenanceStatus,
  MaintenanceBackupInfo,
  PendingRestoreRequest,
  RestoreArchiveManifest,
} from './maintenance/service.js';
// ADR-092: `synth uninstall` — сохранение/удаление данных инстанса.
export { runUninstallCommand, collectUninstallSummary } from './maintenance/uninstall.js';
export type { UninstallCommandOptions, UninstallSummary } from './maintenance/uninstall.js';
// ADR-091: `synth doctor` — health инстанса, целостность данных, ключи/мастер, провайдеры, dataDir, миграции.
export { runDoctor, renderDoctorResult, runDoctorCommand } from './maintenance/doctor.js';
export type {
  DoctorStatus,
  DoctorCheck,
  DoctorResult,
  DoctorOptions,
  DoctorCommandOptions,
} from './maintenance/doctor.js';
// ADR-091: `synth backup`/`restore` — архив каталога данных с манифестом,
// контрольными суммами, опциональными секретами и страховочной копией.
export {
  listFilesForArchive,
  writeTarGz,
  readTarGz,
  listTarGz,
  readFileFromTarGz,
  ArchivePathError,
  ArchiveLimitError,
} from './maintenance/archive.js';
export type { ArchiveEntryMeta, ArchiveSource, ReadTarGzEntry, ReadTarGzOptions } from './maintenance/archive.js';
export { createBackup, runBackupCommand, computeContentChecksum, safetyCopyPath } from './maintenance/backup.js';
export type { BackupManifest, CreateBackupOptions, BackupCommandOptions, SafetyCopyKind } from './maintenance/backup.js';
export { restoreBackup, runRestoreCommand, BackupChecksumError } from './maintenance/restore.js';
export type { RestoreOptions, RestoreCommandOptions } from './maintenance/restore.js';
// ADR-091 (этап 2): портативный экспорт/импорт проекта (`synth project export|import`).
export { exportProject, importProject, ProjectPortableError, DEFAULT_PROJECT_IMPORT_LIMITS } from './projects/portable.js';
export type {
  ExportProjectOptions,
  ExportProjectResult,
  ImportProjectOptions,
  ImportProjectResult,
  ProjectExportEntry,
  ProjectExportManifest,
  ProjectPortableErrorCode,
  ProjectImportLimits,
} from './projects/portable.js';
export { SkillStore } from './storage/skill-store.js';
export type { SkillStoreConfig, CreateSkillInput, UpdateSkillMarkdownInput } from './storage/skill-store.js';
export { createSkillRoutes } from './server/routes/skills.js';
export type { SkillRoutesDeps, SkillRoutesOptions, SkillRoutesMessages } from './server/routes/skills.js';
// ADR-069 §9.3: прозрачность проектных инструкций (резолвер снимка + API-роут).
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
// ADR-046 §7: slash-команды и bundles.
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
export { RuntimeSettingsStore, mergeLlmGatewayConfig, mergeSecurityConfig, mergeMcpNetworkPolicy, mergeEgressPolicy, mergeEventsConfig, mergeDecisionConfig, mergePluginsConfig } from './storage/runtime-settings.js';
export type { RuntimeSettings, LlmGatewayRuntimeSettings, EventsRuntimeSettings, DecisionRuntimeSettings, MetricsRuntimeSettings, DefaultModelPair } from './storage/runtime-settings.js';
export { estimateTokens, calibrateCharsPerToken, RATIO_EWMA_ALPHA } from './engine/context/token-ratio.js';
export { createLocalAuth } from './auth/local.js';
export type { AuthKit, LocalAuthConfig } from './auth/local.js';
// Standalone: устойчивый локальный API-ключ ({dataDir}/secrets/api-key).
export { localApiKeyFilePath, resolveOrCreateLocalApiKey } from './auth/local-key.js';
export { createSettingsRoutes } from './server/routes/settings.js';
export type { SettingsRoutesDeps } from './server/routes/settings.js';
export { createAuditRoutes } from './server/routes/audit.js';
export type { AuditRoutesDeps, AuditRoutesOptions } from './server/routes/audit.js';
// ADR-102: HTTP-фабрика отчётов аналитики (только чтение) — общая для core и backend.
export { createAnalyticsRoutes } from './server/routes/analytics.js';
export type {
  AnalyticsRoutesAuth,
  AnalyticsRoutesDeps,
  AnalyticsRoutesOptions,
  AnalyticsRouteMessages,
} from './server/routes/analytics.js';
export { createDictionaryRoutes } from './server/routes/dictionaries.js';
export type { DictionaryRoutesAuth, DictionaryRoutesOptions } from './server/routes/dictionaries.js';
export { createProviderRoutes } from './server/routes/providers.js';
export type { ProviderRoutesAuth, ProviderRoutesOptions, ProviderRouteMessages } from './server/routes/providers.js';
export { createModelRoutes } from './server/routes/models.js';
export type { ModelRoutesAuth, ModelRoutesOptions, ModelRouteMessages } from './server/routes/models.js';
export { createAgentRoutes } from './server/routes/agents.js';
export type {
  AgentRoutesAuth,
  AgentRoutesOptions,
  AgentRouteMessages,
  AgentRoleFiles,
  AgentRoleResult,
} from './server/routes/agents.js';
export { createMcpRoutes } from './server/routes/mcp.js';
export type { McpRoutesAuth, McpRoutesDeps, McpRouteMessages } from './server/routes/mcp.js';

// ADR-105 (Ф4): HTTP-контур слоя внешних доступов.
export { createOAuthRoutes, OAuthBindError } from './server/routes/oauth.js';
export type {
  OAuthRoutesAuth,
  OAuthRoutesDeps,
  OAuthRoutesOptions,
  OAuthRouteMessages,
} from './server/routes/oauth.js';
export { createEventRoutes } from './server/routes/events.js';
export type {
  EventRoutesAuth,
  EventRoutesDeps,
  EventRoutesOptions,
  EventRouteMessages,
} from './server/routes/events.js';
export {
  createPublicOpenApiApp,
  getPublicOpenApiDocument,
  publicErrorSchema,
} from './server/openapi/public-openapi.js';
export type { PublicError } from './server/openapi/public-openapi.js';
// ADR-101 (Pipeline Engine): движок пайплайнов (второй движок рядом с оркестратором).
export {
  PipelineEngine,
  PipelineEngineError,
  NoopPipelineExitHandler,
  PIPELINE_ERROR_CODES,
  buildPipelineStepContext,
  buildShellCommand,
  buildStepUserMessage,
  buildToolContext,
  checkPipelineToolPermission,
  createAgentStepExecutor,
  createHumanStepExecutor,
  createPipelineExitHandler,
  createScriptStepExecutor,
  createToolStepExecutor,
  evaluateCondition,
  executeAgentStep,
  executeScriptStep,
  executeToolStep,
  findTool,
  gateDecisionResult,
  gateRejectedResult,
  gateTimeoutResult,
  humanGate,
  humanStepExecutor,
  isStepGateOutcome,
  nextNodeId,
  MAX_PIPELINE_TRANSITIONS,
  resolveSpecVars,
  resolveStepInput,
  resolvePathValue,
  resolvePipelinePath,
  sanitizeRecord,
  sanitizeTrigger,
  sanitizeValue,
  SHELL_TOOL_NAME,
  startGateTimeout,
  stepWorkingDir,
  // ADR-101: управление активными прогонами (soft-lock + отмена) —
  // общий экземпляр для HTTP-роута и встроенных тулов агента.
  PipelineRunControl,
  // ADR-101: авторские операции над пайплайном проекта (черновик/публикация/
  // удаление) — общие для HTTP-роута и встроенных тулов агента.
  createPipelineDraft,
  updatePipelineDraft,
  publishPipeline,
  deletePipeline,
  PipelineAuthoringError,
  // ADR-101: шаблоны инстанса — список и инстанцирование (общие для
  // HTTP-роута и встроенных тулов агента).
  listPipelineTemplates,
  instantiatePipelineFromTemplate,
} from './engine/pipelines/index.js';
export type {
  AgentStepExecutorOptions,
  AgentStepState,
  ConditionContext,
  PipelineAgentRegistryLike,
  PipelineEngineDeps,
  PipelineEngineLogger,
  PipelineErrorCode,
  PipelineEventPublisher,
  PipelineExitContext,
  PipelineExitDeps,
  PipelineExitEventBusLike,
  PipelineExitHandler,
  PipelineExitIngressLike,
  PipelineExitSessionManagerLike,
  PipelineGate,
  PipelineGateDecision,
  PipelineGateKind,
  PipelineInstructionsResolverLike,
  PipelineLlmDefaults,
  PipelineMcpManagerLike,
  PipelinePermissionDecision,
  PipelinePermissionDeps,
  PipelinePathContext,
  PipelineProjectStoreLike,
  PipelineRunOptions,
  PipelineRunStartOptions,
  PipelineRunStartResult,
  PipelineSkillsCatalogLike,
  PipelineStepContext,
  PipelineStepContextDeps,
  PipelineStepLlmRuntime,
  PipelineToolLookup,
  PipelineToolPermissionCheck,
  PipelineToolRegistryLike,
  PlannerContext,
  ScriptStepExecutorOptions,
  StepExecutionContext,
  StepExecutor,
  StepGateOutcome,
  StepOutcome,
  ToolStepExecutorOptions,
} from './engine/pipelines/index.js';
export type {
  PipelineDraftSpecInput,
  PipelineTemplateInstantiation,
  PipelineTemplateSummary,
} from './engine/pipelines/index.js';
// ADR-101: встроенные шаблоны пайплайнов инстанса (сид при старте процесса).
export {
  BUILTIN_PIPELINE_PROVENANCE,
  buildMemoryConsolidateFactsPipelineSpec,
  buildMemoryConsolidationPipelineSpec,
  buildMemoryReindexPipelineSpec,
  ensureBuiltinPipelines,
  MEMORY_BUILTIN_PIPELINE_VERSION,
  MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
  MEMORY_CONSOLIDATION_PIPELINE_ID,
  MEMORY_CONSOLIDATION_PIPELINE_VERSION,
  MEMORY_REINDEX_PIPELINE_ID,
} from './engine/pipelines/builtin.js';
export type {
  EnsureBuiltinPipelinesDeps,
  EnsureBuiltinPipelinesResult,
} from './engine/pipelines/builtin.js';
export { createSchedulerRoutes } from './server/routes/schedules.js';
export type {
  SchedulerRoutesAuth,
  SchedulerRoutesDeps,
  SchedulerRoutesOptions,
  SchedulerRouteMessages,
} from './server/routes/schedules.js';
// ADR-051/ADR-100: API пайплайнов (определения/экземпляры/ручной запуск).
export { createPipelinesRoutes } from './server/routes/pipelines.js';
export type {
  PipelinesRoutesAuth,
  PipelinesRoutesDeps,
  PipelinesRoutesOptions,
  PipelinesRouteMessages,
} from './server/routes/pipelines.js';
// ADR-101 (Э6): API пайплайнов проекта, прогонов, HITL и шаблонов инстанса.
export {
  createPipelineProjectRoutes,
  legacyDefinitionToPipelineSpec,
} from './server/routes/pipeline-project-routes.js';
export type {
  PipelineProjectRoutesAuth,
  PipelineProjectRoutesDeps,
  PipelineProjectRoutesOptions,
  PipelineProjectRouteMessages,
} from './server/routes/pipeline-project-routes.js';
// PROP-096/097: HTTP-контур единого реестра фоновых прогонов (список,
// деталь, лог, остановка, удаление).
export { createProcessRoutes } from './server/routes/processes.js';
export type {
  ProcessRoutesAuth,
  ProcessRoutesDeps,
  ProcessRoutesOptions,
  ProcessRouteMessages,
} from './server/routes/processes.js';
// ADR-086 §5: установка пакетов расширений и реестр установок.
export { createPacksRoutes } from './server/routes/packs.js';
export type {
  PacksRoutesAuth,
  PacksRoutesDeps,
  PacksRoutesOptions,
  PacksRouteMessages,
  PackSkillsPort,
  PackRoleFiles,
  PackAgentsPort,
  PackInstallResult,
} from './server/routes/packs.js';
// ADR-090 (Ф5б-2): управление плагинами и runtime-настройки слоя.
export {
  createPluginsRoutes,
  createPluginSettingsRoutes,
  pluginsSettingsPatchSchema,
  httpStatusForRejection,
  PLUGIN_REASON_HTTP,
} from './server/routes/plugins.js';
export type {
  PluginsRoutesAuth,
  PluginsRoutesDeps,
  PluginsRoutesOptions,
  PluginsRouteMessages,
  PluginSettingsRoutesDeps,
  PluginSettingsRoutesOptions,
  PluginSettingsStoreLike,
} from './server/routes/plugins.js';
// ADR-107 / PROP-047 §2.1: портал памяти в ядре (чтение фактов/индексов +
// мутации индексов через админ-тул плагина, М2).
export {
  createMemoryRoutes,
  MEMORY_PLUGIN_NAME,
  MEMORY_NAMESPACE,
  MEMORY_FACT_STATUSES,
  MEMORY_INDEX_STATES,
  MEMORY_INDEX_SCOPES,
  MEMORY_INDEX_TOOL_NAME,
  MEMORY_CONSOLIDATE_TOOL_NAME,
  MEMORY_GRAPH_TOOL_NAME,
  MemoryProviderUnavailableError,
} from './server/routes/memory.js';
export type {
  MemoryRoutesAuth,
  MemoryRoutesOptions,
  MemoryRoutesPorts,
  MemoryRouteMessages,
  MemoryFactStatusFilter,
  MemoryIndexStateFilter,
  MemoryPortalReadiness,
  MemoryStatusView,
  MemoryFactsSummary,
  MemoryIndexesSummary,
  MemoryFactsPage,
  MemoryIndexesPage,
  MemoryConsolidationItem,
  MemoryConsolidationReport,
  MemoryGraphNode,
  MemoryGraphNodeKind,
  MemoryGraphEdge,
  MemoryGraph,
  MemoryIndexSourceKind,
  MemoryPortalProject,
  MemoryToolInvokeInput,
  MemoryToolInvoker,
} from './server/routes/memory.js';
export { createIdentityRoutes } from './server/routes/identities.js';
export type {
  IdentityRoutesAuth,
  IdentityRoutesOptions,
  IdentityRouteMessages,
} from './server/routes/identities.js';
export { createExternalIdentityResolver } from './engine/events/external-identity.js';
// ADR-089 (этап 5): эффективные роли внешнего отправителя (профиль ∩ identity.roles).
export { resolveEffectiveRoles, normalizeRole } from './engine/events/identity-roles.js';
export type { EffectiveRoles } from './engine/events/identity-roles.js';
export { createMessageRoutes } from './server/routes/messages.js';
export type { MessageRoutesAuth, MessageRoutesOptions, MessageRouteMessages } from './server/routes/messages.js';
export { createQueueRoutes } from './server/routes/queue.js';
export type { QueueRoutesAuth, QueueRoutesOptions, QueueRouteMessages } from './server/routes/queue.js';
export { createSessionRoutes } from './server/routes/sessions.js';
export type { SessionRoutesAuth, SessionRoutesDeps, SessionRoutesOptions, SessionRouteMessages } from './server/routes/sessions.js';
// ADR-094: наблюдаемость — мини-реестр метрик Prometheus, `/metrics`, `/ready`,
// HTTP/процессные коллекторы. Доменные коллекторы подключаются отдельной задачей.
export {
  MetricsRegistry,
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  DEFAULT_HISTOGRAM_BUCKETS,
  DEFAULT_MAX_SERIES_PER_METRIC,
  SERIES_DROPPED_METRIC,
  renderMetrics,
  escapeHelp,
  escapeLabelValue,
  formatNumber,
  createHttpMetricsMiddleware,
  normalizeRouteTemplate,
  registerProcessMetrics,
  resolveMetricsToken,
  metricsTokenPath,
  getMetricsTokenStatus,
  writeMetricsToken,
  removeMetricsToken,
  MIN_METRICS_TOKEN_LENGTH,
} from './metrics/index.js';
export type {
  MetricLabels,
  MetricSnapshot,
  MetricSnapshotSeries,
  MetricType,
  MetricsRegistryOptions,
  HttpMetricsOptions,
  ProcessMetricsHandle,
  MetricsTokenSource,
  MetricsTokenStatus,
} from './metrics/index.js';
export { createMetricsRoutes } from './server/routes/metrics.js';
export type { MetricsRoutesOptions } from './server/routes/metrics.js';
export { createMetricsSettingsRoutes, resolveMetricsEnabled, parseMetricsEnvEnabled } from './server/routes/metrics-settings.js';
export type {
  MetricsSettingsDeps,
  MetricsSettingsOptions,
  MetricsSettingsMessages,
  MetricsSource,
  MetricsReadiness,
} from './server/routes/metrics-settings.js';
// ADR-094: доменные коллекторы — проводка в `createStandaloneDeps`/`app.ts`
// (шина сессий, сессии/очередь, хранилище, decision-слой, гибрид, readiness).
export {
  attachBusMetrics,
  startSessionMetrics,
  startStorageMetrics,
  // ADR-094/PROP-047: метрики памяти (`synth_memory_*`).
  startMemoryMetrics,
  // ADR-107: телеметрия контекста памяти и recall.
  createMemoryTelemetry,
  normalizeMemoryContextBlock,
  normalizeMemoryContextStatus,
  normalizeMemoryRecallKind,
  normalizeMemoryRecallOutcome,
  registerDecisionMetrics,
  createSchedulerMetrics,
  createWebhookMetrics,
  createEventMetrics,
  createPipelineMetrics,
  // ADR-106 Ф1: решения Authority-слоя (`synth_authority_decisions_total`).
  createAuthorityMetrics,
  normalizeAuthorityAction,
  normalizeAuthorityEffect,
  normalizeAuthoritySource,
  normalizePipelineRunStatus,
  normalizePipelineStepOutcome,
  normalizePipelineNodeKind,
  normalizePipelineGateKind,
  normalizePipelineTriggerSource,
  startEventJournalMetrics,
  attachHybridMetrics,
  setSynthReady,
  createLlmCallRecorder,
  normalizeRemoteOp,
  // ADR-094/ADR-077: метрики пула исполнителей (`synth_executor_*`).
  createExecutorMetricsCollector,
  normalizeExecutorOutcome,
  EXECUTOR_WAIT_BUCKETS,
  DATADIR_KINDS,
  SESSIONS_METRICS_INTERVAL_MS,
  STORAGE_RECORDS_INTERVAL_MS,
  STORAGE_BYTES_INTERVAL_MS,
  EVENT_JOURNAL_INTERVAL_MS,
  PIPELINE_RUN_DURATION_BUCKETS,
  PIPELINE_STEP_DURATION_BUCKETS,
  PIPELINE_WAIT_DURATION_BUCKETS,
} from './metrics/index.js';
export type {
  TurnOutcome,
  StorageMetricsSources,
  MemoryMetricsSources,
  // ADR-107: телеметрия памяти.
  MemoryTelemetryRecorder,
  MemoryContextBlockLabel,
  MemoryContextStatusLabel,
  MemoryRecallKindLabel,
  MemoryRecallOutcomeLabel,
  HybridMetricsHooks,
  RemoteRequestInfo,
  SchedulerJobInfo,
  SchedulerJobMetrics,
  WebhookDeliveryInfo,
  WebhookDeliveryMetrics,
  WebhookDeliveryOutcome,
  EventMetricsHooks,
  // ADR-106 Ф1: хуки метрик Authority-слоя.
  AuthorityMetricAction,
  AuthorityMetricEffect,
  AuthorityMetricSource,
  AuthorityMetricsHooks,
  PipelineGateMetricKind,
  PipelineMetricsHooks,
  PipelineNodeMetricKind,
  PipelineRunMetricStatus,
  PipelineStepMetricOutcome,
  PipelineTriggerMetricSource,
  LlmCallInfo,
  LlmCallOutcome,
} from './metrics/index.js';
export { createHealthRoutes } from './server/routes/health.js';
export type { HealthRoutesOptions, ReadinessState } from './server/routes/health.js';
export { createStandaloneApp } from './server/app.js';
export type { StandaloneConfig } from './server/app.js';
export { serializeSession, serializeMessage, serializeProject } from './server/serialize.js';

export {
  GatewayProvider,
  ObfuscationMapStore,
  stripSessionSecrets,
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
  LlmFilterRegistry,
  LlmFilterRegistrationError,
  canVetoLlmFilter,
  defaultLlmFilterFailMode,
  LLM_FILTER_VETO_TRUST_LEVEL,
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
  LlmFilterAuditEvent,
  LlmFilterRegistrationOptions,
  LlmFilterRegistryOptions,
  RegisteredLlmFilter,
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
