// `synthApi` — фасад/barrel API v2 (ADR-095).
// Методы разбиты по доменным модулям `lib/api/<домен>.ts`; публичный контракт
// (`synthApi.<method>` и экспортируемые типы) не изменился. Новый метод добавляется
// в доменный модуль, базовые `BASE_URL`/`fetchJSON` — в `lib/api/base.ts`.
import { fetchJSON } from './base'
import { healthApi } from './health'
import { projectsApi } from './projects'
import { sessionsApi } from './sessions'
import { messagesApi } from './messages'
import { queueApi } from './queue'
import { filesApi } from './files'
import { workspaceApi } from './workspace'
import { gitApi } from './git'
import { sshKeysApi } from './ssh-keys'
import { agentsApi } from './agents'
import { providersApi } from './providers'
import { modelsApi } from './models'
import { contextApi } from './context'
import { debugApi } from './debug'
import { usersApi } from './users'
import { mcpApi } from './mcp'
import { securityApi } from './security'
import { settingsApi } from './settings'
import { skillsApi } from './skills'
import { commandsApi } from './commands'
import { skillBundlesApi } from './skill-bundles'
import { dictionariesApi } from './dictionaries'
import { eventsApi } from './events'
import { identitiesApi } from './identities'
import { decisionApi } from './decision'
import { schedulesApi } from './schedules'
import { serviceKeysApi } from './service-keys'
import { webhooksApi } from './webhooks'
import { oauthApi } from './oauth'
import { maintenanceApi } from './maintenance'
import { analyticsApi } from './analytics'
import { logsApi } from './logs'
import { egressApi } from './egress'
import { proxyApi } from './proxy'
import { tlsApi } from './tls'
import { observabilityApi } from './observability'
import { hybridApi } from './hybrid'
import { instructionsApi } from './instructions'
import { packsApi } from './packs'
import { pipelinesApi } from './pipelines'
import { pipelineProjectApi } from './pipeline-project'
import { pluginsApi } from './plugins'
import { memoryApi } from './memory'

export type { EntityOrigin } from './common'
export type {
  CreateProjectBody,
  UpdateProjectBody,
  ProjectData,
  ProjectStats,
  PublishProjectResult,
  ProjectMcpResponse,
} from './projects'
export type { SessionData, StickyNoteData, PromptInfoResponse } from './sessions'
export type { MessageListResponse } from './messages'
export type {
  WorkspaceRootResponse,
  WorkspaceBrowseResponse,
  WorkspaceMkdirResult,
  WorkspacePolicyInfo,
} from './workspace'
export type { GitRepoConfigData } from './git'
export type { SSHKeyMetaData, SSHKeyCreateBody, SSHKeyUpdateBody } from './ssh-keys'
export type { AgentMode, AgentInfo, AgentsListResponse } from './agents'
export type { ProviderInfo, ProviderFetchIconResult, ProviderGroupInfo } from './providers'
export type { ModelInfo, ModelGroup } from './models'
export type { ContextFileEntry } from './context'
export type { DebugConfigData } from './debug'
export type { UserInfo, UsersListResponse } from './users'
export type {
  SessionMcpEffectiveResponse,
  McpProbedTool,
  McpModeAvailability,
  McpServerToolsSettings,
  McpSettingsPayload,
  McpRegistryAddInput,
  McpRegistryUpdateInput,
} from './mcp'
export type {
  SkillsListResponse,
  SkillFilesResponse,
  SkillFileResponse,
  EffectiveSkillEntry,
  SessionSkillsResponse,
  ProjectSkillsResponse,
  SkillsSettingsResponse,
} from './skills'
export type { CommandsListResponse } from './commands'
export type { SkillBundlesResponse } from './skill-bundles'
export type {
  LlmGatewaySettings,
  SecretPattern,
  SecuritySettings,
  ProtectedPathsPolicy,
  ProtectedPathsRaw,
  SessionSecretsResponse,
} from './security'
export type { DefaultModelPair, DefaultModelInfo } from './settings'
export type { DictionaryEntry, DictionaryDetail } from './dictionaries'
export type {
  LogsResponse,
  AuditEntry,
  AuditListResponse,
  LlmPayloadEntry,
  LlmPayloadListResponse,
} from './logs'
export type {
  EgressCheckScope,
  EgressCheckResult,
  EgressPolicyInfo,
  AnyEgressPolicy,
  ConfiguredEgressPolicy,
  SecurityAuditListResponse,
  EgressLogListResponse,
} from './egress'
export type {
  ProxyAuthConfig,
  ProxyTlsConfig,
  ProxyProfileInput,
  ProxyRuleInput,
  ProxyConfigInput,
  ProxySettingsResponse,
  ProxySaveResponse,
  ProxyResetResponse,
  ProxyTlsMutationResponse,
  ProxyPasswordStatus,
  ProxyProfileStatus,
  ProxyStatusInfo,
  ProxyCheckResult,
  ProxyRouteInfo,
  ProxyRouteTestResult,
  ProxyMode,
  ProxyStatusRule,
  ProxySource,
} from './proxy'
export type {
  TlsSource,
  TlsStatus,
  TlsStatusCa,
  TlsStatusClient,
  TlsStatusMapping,
  TlsStatusParams,
  TlsGetResponse,
  TlsMutationResponse,
  TlsMappingMutationResponse,
  TlsUpdateInput,
  TlsMappingInput,
  TlsMappingUpdateInput,
  TlsValidateInput,
  TlsValidateResult,
} from './tls'
export type {
  MetricsSource,
  MetricsTokenSource,
  MetricsStorageState,
  MetricsStorageBackend,
  MetricsTokenStatus,
  MetricsEndpoints,
  MetricsTokenResponse,
  MetricsSettingsInfo,
  MetricsStatus,
} from './observability'
export type {
  CreateEventBindingKeyInput,
  UpdateEventBindingKeyPatch,
  EventsSettings,
  EventsSettingsResponse,
  EventJournalEntry,
} from './events'
export type {
  DecisionSettings,
  DecisionSettingsResponse,
  DecisionAttemptStatus,
  DecisionModelMetrics,
  DecisionMetrics,
} from './decision'
export type {
  AnalyticsQuery,
  AnalyticsExportQuery,
  AnalyticsExportFile,
  AnalyticsDimension,
  AnalyticsExportFormat,
  AnalyticsReport,
  AnalyticsReportKind,
  AnalyticsSummary,
} from './analytics'
export type { HybridStatus } from './hybrid'
export type {
  OAuthFlowKind,
  OAuthFlowResponse,
  OAuthAuthorizationStart,
  OAuthFlowCompleted,
  OAuthFlowPending,
  OAuthCredentialCreateInput,
  OAuthCredentialBindResult,
  OAuthCredentialRevokeResult,
} from './oauth'
export type {
  MaintenanceStatus,
  MaintenanceBackupInfo,
  MaintenanceMigration,
  MaintenanceAuditEntry,
  ListAuditOptions,
  MigrationPlan,
  DoctorStatus,
  DoctorCheck,
  DoctorResult,
  PendingRestoreRequest,
  RestoreArchiveManifest,
  RestoreValidation,
  CreateBackupOptions,
  RestartMode,
  RestartStatus,
  RestartResponse,
} from './maintenance'
export type {
  InstructionFileStatus,
  InstructionSourceKind,
  InstructionScanInfo,
  InstructionFileInfo,
  InstructionDiagnostic,
  InstructionsInfo,
} from './instructions'
export type { McpServerConfig } from '@itphx/synth-shared'
export type { ToolsPolicy } from '@itphx/synth-shared/types'
// ADR-071 §2.3: `ToolsPolicy` — общий контракт `@itphx/synth-shared/types`
// (импортирован и реэкспортирован выше).
export type { FileEntry, DirectoryListResult, FileReadResult } from '@itphx/synth-shared'
export type {
  PackInstallationStatus,
  PackProvides,
  PackAuthoritySummaryRole,
  PackAuthoritySummaryAction,
  PackAuthoritySummaryTarget,
  PackAuthoritySummaryAgent,
  PackAuthoritySummary,
  PackInstallation,
  PacksListResponse,
  PackApprovalResult,
} from './packs'
export type {
  PipelineInstanceStatus,
  PipelineStepStatus,
  PipelineStep,
  PipelineDefinition,
  PipelineStepState,
  PipelineTrigger,
  PipelineInstance,
  PipelineInstanceFilter,
  PipelinesListResponse,
  PipelineInstancesListResponse,
} from './pipelines'
// ADR-101 §5.35: пайплайны проекта, прогоны и шаблоны инстанса (Э7).
export type {
  PipelineProvenance,
  ProjectPipeline,
  PipelineVersion,
  ProjectPipelineDetail,
  PipelineRunRecord,
  PipelineRunEvent,
  PipelineRunDetail,
  PipelineTemplate,
  PipelineSpecBody,
  PipelineSpecInput,
  PipelineRunStartBody,
  PipelineRunResumeBody,
  PipelineTemplateInstantiateBody,
  PipelineRunsFilter,
} from './pipeline-project'
export type {
  PipelineSpec,
  PipelineNode,
  PipelineExit,
  PipelineMode,
  PipelineRunStatus,
} from '@itphx/synth-shared/types'
// ADR-090: слой плагинов (жизненный цикл и runtime-политика).
export type {
  PluginTrustLevel,
  PluginScanVerdict,
  PluginExecutionMode,
  PluginServerPolicyStatus,
  PluginInstallSourceKind,
  PluginRuntimeEntry,
  PluginsListResponse,
  PluginDetailResponse,
  PluginAuditAction,
  PluginAuditOutcome,
  PluginAuditEntry,
  PluginAuditListResponse,
  PluginAuditListOptions,
  PluginActivationSummary,
  PluginActivationResponse,
  PluginInstallInput,
  PluginInstallResult,
  PluginUpdateInput,
  PluginUpdateResult,
  PluginRollbackResult,
  PluginsPolicyValues,
  PluginsSettingsInfo,
  PluginsPolicyPatch,
} from './plugins'
// ADR-107 / PROP-047: портал памяти — состояние, факты, индексы + операции с индексами.
export {
  MEMORY_CONSOLIDATION_THRESHOLD_MIN,
  MEMORY_CONSOLIDATION_THRESHOLD_MAX,
  MEMORY_CONSOLIDATION_THRESHOLD_DEFAULT,
} from './memory'
export type {
  MemoryReadiness,
  MemoryProviderMode,
  MemoryFactStatus,
  MemoryFactStatusFilter,
  MemoryIndexState,
  MemoryIndexSourceKind,
  MemoryFactProvenance,
  MemoryFact,
  MemoryIndex,
  MemoryIndexFingerprint,
  MemoryIndexSource,
  MemoryStatus,
  MemoryFactList,
  MemoryIndexList,
  MemoryFactListParams,
  MemoryIndexListParams,
  CreateMemoryIndexInput,
  MemoryConsolidationCluster,
  MemoryConsolidationReport,
  ConsolidateMemoryInput,
} from './memory'

export const synthApi = {
  fetchJSON,
  ...healthApi,
  ...projectsApi,
  ...sessionsApi,
  ...messagesApi,
  ...queueApi,
  ...filesApi,
  ...workspaceApi,
  ...gitApi,
  ...sshKeysApi,
  ...agentsApi,
  ...providersApi,
  ...modelsApi,
  ...contextApi,
  ...debugApi,
  ...usersApi,
  ...mcpApi,
  ...securityApi,
  ...settingsApi,
  ...skillsApi,
  ...commandsApi,
  ...skillBundlesApi,
  ...dictionariesApi,
  ...eventsApi,
  ...identitiesApi,
  ...decisionApi,
  ...schedulesApi,
  ...serviceKeysApi,
  ...webhooksApi,
  ...oauthApi,
  ...maintenanceApi,
  ...analyticsApi,
  ...logsApi,
  ...egressApi,
  ...proxyApi,
  ...tlsApi,
  ...observabilityApi,
  ...hybridApi,
  ...instructionsApi,
  ...packsApi,
  ...pipelinesApi,
  ...pipelineProjectApi,
  ...pluginsApi,
  ...memoryApi,
}
