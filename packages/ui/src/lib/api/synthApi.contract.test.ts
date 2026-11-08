import { describe, it, expect } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Контрактный тест (ADR-095, шаг 1): фиксирует полный состав публичного объекта
 * `synthApi` после декомпозиции на доменные модули (`lib/api/<домен>.ts`).
 *
 * Защита от «тихого» пересечения имён при спредах доменов и от случайной потери
 * метода: при осознанном добавлении/удалении методa тест обновляется руками.
 */
const EXPECTED_API_METHODS = [
  'addMcpRegistryEntry', 'addSessionReference', 'addStickyNote', 'answer', 'applyMigrations', 'approvePack',
  'approvePlugin', 'auditRevealed', 'backgroundSession', 'backupDownloadUrl', 'batchMessages',
  'bindOAuthCredential', 'bindWorktree', 'browseWorkspaceRoot', 'cancel', 'cancelPipelineRun', 'cancelQueueRetry',
  'cancelRestore', 'cancelSummarization', 'checkEgress', 'checkProxy', 'checkUpdate', 'claimIdentity',
  'clearAudit', 'clearProfilePassword', 'clearProxyPassword', 'clearQueue', 'clearSession', 'clearSessionTodos',
  'clearWorkspacePolicy', 'cloneGitRepo', 'consolidateMemory', 'createAgentSshKey', 'createBackup',
  'createDirectory', 'createEventBindingKey', 'createEventRoute', 'createMemoryIndex', 'createOAuthCredential',
  'createProject', 'createProjectLogEntry', 'createProjectPipeline', 'createProjectPlanColumn',
  'createProjectPlanItem', 'createProvider', 'createSchedule', 'createServiceKey', 'createSession',
  'createSessionTodo', 'createSkill', 'createSkillBundle', 'createSshKey', 'createTlsMapping', 'createUser',
  'createWebhookSubscription', 'createWorktree', 'deleteAgent', 'deleteBackup', 'deleteContextFile',
  'deleteEntry', 'deleteEventBinding', 'deleteEventBindingKey', 'deleteEventRoute', 'deleteMcpRegistryEntry',
  'deleteMemoryIndex', 'deleteMessage', 'deleteModel', 'deleteMyIdentity', 'deleteOAuthCredential',
  'deleteProject', 'deleteProjectLogEntry', 'deleteProjectPipeline', 'deleteProjectPlanColumn',
  'deleteProjectPlanItem', 'deleteProvider', 'deleteSchedule', 'deleteServiceKey', 'deleteSession',
  'deleteSessionTodo', 'deleteSkill', 'deleteSkillBundle', 'deleteSkillFile', 'deleteSshKey', 'deleteStickyNote',
  'deleteTlsMapping', 'deleteToken', 'deleteUser', 'deleteWebhookSubscription', 'disablePlugin', 'downloadFile',
  'enablePlugin', 'enqueueMessage', 'fetchGitRepo', 'fetchJSON', 'fetchModels', 'fetchProviderIcon',
  'forkRemoteProject', 'forkSession', 'get', 'getAgentDetail', 'getAgents', 'getAgentsLimits', 'getAllAgents',
  'getAnalyticsActivity', 'getAnalyticsDecision', 'getAnalyticsExport', 'getAnalyticsPrompt',
  'getAnalyticsSummary', 'getAnalyticsUsage', 'getAttachmentsSettings', 'getAudit', 'getCommands',
  'getCommitDetail', 'getCommitLog', 'getContextFile', 'getContextFiles', 'getDebugConfig', 'getDecisionMetrics',
  'getDecisionSettings', 'getDefaultAgentInfo', 'getDefaultModel', 'getDictionaries', 'getDictionary',
  'getDoctor', 'getEgressLog', 'getEgressPolicy', 'getEventBindingKeys', 'getEventJournal', 'getEventRoutes',
  'getEventsSettings', 'getGatewayPatterns', 'getHealth', 'getHybridStatus', 'getInstanceCapabilities',
  'getLlmGatewaySettingsInfo', 'getLlmPayloads', 'getLogs', 'getMcpNetworkPolicyInfo', 'getMcpPolicyInfo',
  'getMcpRegistry', 'getMcpToolSettings', 'getMemoryFact', 'getMemoryGraph', 'getMemoryStatus', 'getMessageDebug',
  'getMigrations', 'getModelGroups', 'getModels', 'getModelsPage', 'getMyIdentities', 'getOAuthCredential',
  'getOAuthCredentials', 'getOptimization', 'getPack', 'getPacks', 'getPendingRestore', 'getPipelineInstances',
  'getPipelineRun', 'getPipelineTemplates', 'getPipelines', 'getPlugin', 'getPluginsSettings', 'getProcess',
  'getProcessLogs', 'getProject', 'getProjectInvariants', 'getProjectLogPage', 'getProjectMcp',
  'getProjectPipeline', 'getProjectPipelines', 'getProjectPipelinesPage', 'getProjectPlan', 'getProjectSkills',
  'getProjectStats', 'getProjects', 'getProjectsPage', 'getProtectedPaths', 'getProviders', 'getProxy',
  'getPublishProgress', 'getRequestLimits', 'getRestartStatus', 'getScheduleJobs', 'getSchedules', 'getSecurityAudit', 'getSecuritySettings',
  'getServiceKey', 'getServiceKeyScopes', 'getServiceKeys', 'getSession', 'getSessionInstructions',
  'getSessionMcpEffective', 'getSessionMemory', 'getSessionMessage', 'getSessionMessages', 'getSessionPrompt',
  'getSessionReferences', 'getSessionSecrets', 'getSessionSkills', 'getSessionSkillsEffective', 'getSessionStats',
  'getSessionTodos', 'getSessions', 'getSessionsPage', 'getSkill', 'getSkillBundle', 'getSkillBundles',
  'getSkillFile', 'getSkillFiles', 'getSkills', 'getSkillsSettings', 'getSshSettings', 'getStatus',
  'getStickyNotes', 'getTls', 'getToolsDisabledInfo', 'getToolsPolicyInfo', 'getUser', 'getUsers',
  'getWebhookDeliveries', 'getWebhookSubscription', 'getWebhookSubscriptions', 'getWorkspacePolicy',
  'getWorkspaceRoot', 'getWorkspaceSetting', 'initGitRepo', 'installPlugin', 'instantiatePipelineTemplate',
  'list', 'listAgentSshKeys', 'listAudit', 'listBackups', 'listDirectory', 'listEventBindings', 'listMemoryFacts',
  'listMemoryIndexes', 'listPipelineRuns', 'listPipelineRunsPage', 'listPluginAudit', 'listPlugins',
  'listProcesses', 'listSshKeys', 'listWorktrees', 'mergeMessages', 'mkdirWorkspaceRoot', 'moveEntry',
  'moveProjectPlanItem', 'patchSessionMode', 'permissionReply', 'pinMessage', 'probeMcpServer', 'probeRawFile',
  'pruneWorktrees', 'publishProject', 'publishProjectPipeline', 'putProjectInvariants', 'putSkillFile',
  'rawFileUrl', 'readFile', 'rebuildMemoryIndex', 'refreshOAuthCredential', 'regenerateWebhookSecret',
  'registerGitRepo', 'reloadSkills', 'removeCa', 'removeDefaultClient', 'removeGitRepo', 'removePlugin',
  'removeProcess', 'removeProfileCa', 'removeProfileClient', 'removeSessionReference', 'removeWorktree',
  'reorderProjectPlanColumns', 'reorderQueue', 'reorderSessionTodos', 'reset', 'resetAgentsLimits',
  'resetAttachmentsSettings', 'resetContextFile', 'resetDecisionMetrics', 'resetDecisionSettings',
  'resetDefaultAgent', 'resetDefaultModel', 'resetDictionary', 'resetEgressPolicy', 'resetEventsSettings',
  'resetGatewayPatterns', 'resetLlmGatewaySettings', 'resetMcpNetworkPolicy', 'resetMcpPolicy',
  'resetMcpSettings', 'resetPluginsSettings', 'resetProtectedPaths', 'resetProxy', 'resetRequestLimits', 'resetSkillsSettings',
  'resetSshMode', 'resetToolsDisabled', 'resetToolsPolicy', 'restartInstance', 'resumePipelineRun', 'resumeQueue',
  'resumeSubagent', 'retryMessage', 'retryQueueNow', 'returnQueue', 'revokeEventBindingKey', 'revokeServiceKey',
  'rollbackPlugin', 'runSchedule', 'saveAgent', 'saveContextFile', 'saveDebugConfig', 'saveDictionary',
  'saveEgressPolicy', 'saveGatewayPatterns', 'saveLlmGatewaySettings', 'saveMcpNetworkPolicy', 'saveMcpPolicy',
  'saveMcpToolSettings', 'saveModel', 'saveProtectedPaths', 'saveProxy', 'saveSecuritySettings',
  'saveToolsDisabled', 'saveToolsPolicy', 'scanGitRepos', 'scheduleRestore', 'setAgentsLimits', 'setDefaultAgent',
  'setDefaultClient', 'setDefaultModel', 'setEnabled', 'setMemoryIndexEnabled', 'setProfilePassword',
  'setProxyPassword', 'setRequestLimits', 'setSshMode', 'setToken', 'setWorkspacePolicy', 'setWorkspaceSetting', 'startPipelineRun',
  'status', 'steerQueue', 'stopGeneration', 'stopProcess', 'summarizeSession', 'testProvider', 'testProxyRoute',
  'testWebhookSubscription', 'toggleAgent', 'toggleContextFile', 'toggleMessage', 'uninstallPack',
  'unlinkAgentSshKey', 'updateAttachmentsSettings', 'updateDecisionSettings', 'updateEventBindingKey',
  'updateEventsSettings', 'updateMcpRegistryEntry', 'updateOptimization', 'updatePlugin', 'updatePluginsSettings',
  'updateProject', 'updateProjectLogEntry', 'updateProjectMcp', 'updateProjectPipeline',
  'updateProjectPlanColumn', 'updateProjectPlanItem', 'updateProjectSkills', 'updateProvider', 'updateSchedule',
  'updateServiceKey', 'updateSession', 'updateSessionMcp', 'updateSessionSkills', 'updateSessionTodo',
  'updateSkill', 'updateSkillBundle', 'updateSkillsSettings', 'updateSshKey', 'updateStickyNote', 'updateTls',
  'updateTlsMapping', 'updateUser', 'updateWebhookSubscription', 'uploadCa', 'uploadFile', 'uploadProfileCa',
  'uploadProfileClient', 'upsertEventBinding', 'validateRestoreByRef', 'validateRestoreUpload', 'validateTls',
  'writeFile',
] as const

describe('synthApi contract (ADR-095)', () => {
  it('набор методов совпадает с зафиксированным (395)', () => {
    expect(Object.keys(synthApi).sort()).toEqual([...EXPECTED_API_METHODS])
  })

  it('каждый член — функция', () => {
    for (const name of Object.keys(synthApi)) {
      expect(typeof (synthApi as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
