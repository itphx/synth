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
import { maintenanceApi } from './maintenance'
import { logsApi } from './logs'
import { egressApi } from './egress'
import { hybridApi } from './hybrid'
import { instructionsApi } from './instructions'

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
export type { HybridStatus } from './hybrid'
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
  ...maintenanceApi,
  ...logsApi,
  ...egressApi,
  ...hybridApi,
  ...instructionsApi,
}
