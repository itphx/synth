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
  'addMcpRegistryEntry', 'addSessionReference', 'addStickyNote', 'applyMigrations', 'approvePack', 'auditRevealed',
  'backupDownloadUrl', 'batchMessages', 'browseWorkspaceRoot', 'cancelQueueRetry', 'cancelRestore',
  'cancelSummarization', 'checkEgress', 'checkProxy',
  'checkUpdate', 'claimIdentity', 'clearAudit', 'clearProfilePassword', 'clearProxyPassword', 'clearQueue', 'clearSession',
  'clearWorkspacePolicy', 'cloneGitRepo', 'createAgentSshKey', 'createBackup', 'createDirectory',
  'createEventBindingKey', 'createEventRoute', 'createProject', 'createProvider',
  'createSchedule', 'createServiceKey', 'createSession', 'createSkill',
  'createSkillBundle', 'createSshKey', 'createTlsMapping', 'createUser', 'createWebhookSubscription',
  'deleteAgent', 'deleteBackup', 'deleteContextFile', 'deleteEntry', 'deleteEventBinding',
  'deleteEventBindingKey', 'deleteEventRoute', 'deleteMcpRegistryEntry', 'deleteMessage',
  'deleteModel', 'deleteMyIdentity', 'deleteProject', 'deleteProvider',
  'deleteSchedule', 'deleteServiceKey', 'deleteSession', 'deleteSkill',
  'deleteSkillBundle', 'deleteSkillFile', 'deleteSshKey', 'deleteStickyNote',
  'deleteTlsMapping', 'deleteToken', 'deleteUser', 'deleteWebhookSubscription', 'downloadFile', 'enqueueMessage',
  'fetchGitRepo', 'fetchJSON', 'fetchModels', 'fetchProviderIcon',
  'forkRemoteProject', 'forkSession', 'get', 'getAgentDetail', 'getAgents',
  'getAllAgents', 'getAnalyticsActivity', 'getAnalyticsDecision', 'getAnalyticsExport', 'getAnalyticsPrompt',
  'getAnalyticsSummary', 'getAnalyticsUsage', 'getAudit', 'getCommands', 'getCommitDetail',
  'getCommitLog', 'getContextFile', 'getContextFiles', 'getDebugConfig',
  'getDecisionMetrics', 'getDecisionSettings', 'getDefaultAgentInfo', 'getDefaultModel', 'getDictionaries',
  'getDictionary', 'getDoctor', 'getEgressLog', 'getEgressPolicy', 'getEventBindingKeys', 'getEventJournal', 'getEventRoutes',
  'getEventsSettings', 'getGatewayPatterns', 'getHealth', 'getHybridStatus',
  'getLlmGatewaySettingsInfo', 'getLlmPayloads', 'getLogs', 'getMcpNetworkPolicyInfo',
  'getMcpPolicyInfo', 'getMcpRegistry', 'getMcpToolSettings', 'getMigrations', 'getModels',
  'getMyIdentities', 'getOptimization', 'getPack', 'getPacks', 'getPendingRestore',
  'getPipelineInstances', 'getPipelines', 'getProject', 'getProjectMcp',
  'getProjectSkills', 'getProjectStats', 'getProjects', 'getProtectedPaths',
  'getProviders', 'getProxy', 'getRestartStatus', 'getScheduleJobs', 'getSchedules', 'getSecurityAudit', 'getSecuritySettings',
  'getServiceKey', 'getServiceKeyScopes', 'getServiceKeys', 'getSession',
  'getSessionInstructions', 'getSessionMcpEffective', 'getSessionMessages', 'getSessionPrompt',
  'getSessionReferences', 'getSessionSecrets', 'getSessionSkills', 'getSessionSkillsEffective',
  'getSessionStats', 'getSessions', 'getSkill', 'getSkillBundle',
  'getSkillBundles', 'getSkillFile', 'getSkillFiles', 'getSkills',
  'getSkillsSettings', 'getStatus', 'getStickyNotes', 'getTls', 'getToolsDisabledInfo', 'getToolsPolicyInfo',
  'getUser', 'getUsers', 'getWebhookDeliveries', 'getWebhookSubscription',
  'getWebhookSubscriptions', 'getWorkspacePolicy', 'getWorkspaceRoot', 'getWorkspaceSetting',
  'initGitRepo', 'listAgentSshKeys', 'listAudit', 'listBackups', 'listDirectory', 'listEventBindings',
  'listSshKeys', 'mergeMessages', 'mkdirWorkspaceRoot', 'moveEntry',
  'patchSessionMode', 'pinMessage', 'probeMcpServer', 'publishProject',
  'putSkillFile', 'readFile', 'regenerateWebhookSecret', 'registerGitRepo',
  'reloadSkills', 'removeCa', 'removeDefaultClient', 'removeGitRepo', 'removeProfileCa', 'removeProfileClient', 'removeSessionReference', 'reset', 'resetContextFile',
  'resetDecisionMetrics', 'resetDecisionSettings', 'resetDefaultAgent', 'resetDefaultModel', 'resetDictionary',
  'resetEgressPolicy', 'resetEventsSettings', 'resetGatewayPatterns', 'resetLlmGatewaySettings', 'resetMcpNetworkPolicy',
  'resetMcpPolicy', 'resetMcpSettings', 'resetProtectedPaths', 'resetProxy', 'resetSkillsSettings',
  'resetToolsDisabled', 'resetToolsPolicy', 'restartInstance', 'resumeQueue', 'resumeSubagent',
  'retryMessage', 'retryQueueNow', 'returnQueue', 'revokeEventBindingKey',
  'revokeServiceKey', 'runSchedule', 'saveAgent', 'saveContextFile',
  'saveDebugConfig', 'saveDictionary', 'saveEgressPolicy', 'saveGatewayPatterns', 'saveLlmGatewaySettings',
  'saveMcpNetworkPolicy', 'saveMcpPolicy', 'saveMcpToolSettings', 'saveModel',
  'saveProtectedPaths', 'saveProxy', 'saveSecuritySettings', 'saveToolsDisabled', 'saveToolsPolicy',
  'scanGitRepos', 'scheduleRestore', 'setDefaultAgent', 'setDefaultClient', 'setDefaultModel', 'setEnabled', 'setProfilePassword', 'setProxyPassword', 'setToken', 'setWorkspacePolicy', 'setWorkspaceSetting',
  'status', 'stopGeneration', 'summarizeSession', 'testProvider', 'testProxyRoute', 'testWebhookSubscription',
  'toggleAgent', 'toggleContextFile', 'toggleMessage', 'uninstallPack', 'unlinkAgentSshKey',
  'updateDecisionSettings', 'updateEventBindingKey', 'updateEventsSettings', 'updateMcpRegistryEntry',
  'updateOptimization', 'updateProject', 'updateProjectMcp', 'updateProjectSkills',
  'updateProvider', 'updateSchedule', 'updateServiceKey', 'updateSession',
  'updateSessionMcp', 'updateSessionSkills', 'updateSkill', 'updateSkillBundle',
  'updateSkillsSettings', 'updateSshKey', 'updateStickyNote', 'updateTls', 'updateTlsMapping', 'updateUser',
  'updateWebhookSubscription', 'uploadCa', 'uploadFile', 'uploadProfileCa', 'uploadProfileClient', 'upsertEventBinding', 'validateRestoreByRef',
  'validateRestoreUpload', 'validateTls', 'writeFile',
] as const

describe('synthApi contract (ADR-095)', () => {
  it('набор методов совпадает с зафиксированным (291)', () => {
    expect(Object.keys(synthApi).sort()).toEqual([...EXPECTED_API_METHODS])
  })

  it('каждый член — функция', () => {
    for (const name of Object.keys(synthApi)) {
      expect(typeof (synthApi as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
