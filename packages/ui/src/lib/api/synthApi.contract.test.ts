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
  'addMcpRegistryEntry', 'addSessionReference', 'addStickyNote', 'applyMigrations', 'auditRevealed',
  'backupDownloadUrl', 'batchMessages', 'browseWorkspaceRoot', 'cancelQueueRetry', 'cancelRestore',
  'cancelSummarization', 'checkEgress',
  'checkUpdate', 'claimIdentity', 'clearAudit', 'clearQueue', 'clearSession',
  'clearWorkspacePolicy', 'cloneGitRepo', 'createAgentSshKey', 'createBackup', 'createDirectory',
  'createEventBindingKey', 'createEventRoute', 'createProject', 'createProvider',
  'createSchedule', 'createServiceKey', 'createSession', 'createSkill',
  'createSkillBundle', 'createSshKey', 'createUser', 'createWebhookSubscription',
  'deleteAgent', 'deleteBackup', 'deleteContextFile', 'deleteEntry', 'deleteEventBinding',
  'deleteEventBindingKey', 'deleteEventRoute', 'deleteMcpRegistryEntry', 'deleteMessage',
  'deleteModel', 'deleteMyIdentity', 'deleteProject', 'deleteProvider',
  'deleteSchedule', 'deleteServiceKey', 'deleteSession', 'deleteSkill',
  'deleteSkillBundle', 'deleteSkillFile', 'deleteSshKey', 'deleteStickyNote',
  'deleteUser', 'deleteWebhookSubscription', 'downloadFile', 'enqueueMessage',
  'fetchGitRepo', 'fetchJSON', 'fetchModels', 'fetchProviderIcon',
  'forkRemoteProject', 'forkSession', 'getAgentDetail', 'getAgents',
  'getAllAgents', 'getAudit', 'getCommands', 'getCommitDetail',
  'getCommitLog', 'getContextFile', 'getContextFiles', 'getDebugConfig',
  'getDecisionMetrics', 'getDecisionSettings', 'getDefaultAgentInfo', 'getDictionaries',
  'getDictionary', 'getDoctor', 'getEgressLog', 'getEgressPolicy', 'getEventBindingKeys', 'getEventJournal', 'getEventRoutes',
  'getEventsSettings', 'getGatewayPatterns', 'getHealth', 'getHybridStatus',
  'getLlmGatewaySettingsInfo', 'getLlmPayloads', 'getLogs', 'getMcpNetworkPolicyInfo',
  'getMcpPolicyInfo', 'getMcpRegistry', 'getMcpToolSettings', 'getMigrations', 'getModels',
  'getMyIdentities', 'getOptimization', 'getPendingRestore', 'getProject', 'getProjectMcp',
  'getProjectSkills', 'getProjectStats', 'getProjects', 'getProtectedPaths',
  'getProviders', 'getScheduleJobs', 'getSchedules', 'getSecurityAudit', 'getSecuritySettings',
  'getServiceKey', 'getServiceKeyScopes', 'getServiceKeys', 'getSession',
  'getSessionInstructions', 'getSessionMcpEffective', 'getSessionMessages', 'getSessionPrompt',
  'getSessionReferences', 'getSessionSecrets', 'getSessionSkills', 'getSessionSkillsEffective',
  'getSessionStats', 'getSessions', 'getSkill', 'getSkillBundle',
  'getSkillBundles', 'getSkillFile', 'getSkillFiles', 'getSkills',
  'getSkillsSettings', 'getStatus', 'getStickyNotes', 'getToolsDisabledInfo', 'getToolsPolicyInfo',
  'getUser', 'getUsers', 'getWebhookDeliveries', 'getWebhookSubscription',
  'getWebhookSubscriptions', 'getWorkspacePolicy', 'getWorkspaceRoot', 'getWorkspaceSetting',
  'initGitRepo', 'listAgentSshKeys', 'listAudit', 'listBackups', 'listDirectory', 'listEventBindings',
  'listSshKeys', 'mergeMessages', 'mkdirWorkspaceRoot', 'moveEntry',
  'patchSessionMode', 'pinMessage', 'probeMcpServer', 'publishProject',
  'putSkillFile', 'readFile', 'regenerateWebhookSecret', 'registerGitRepo',
  'reloadSkills', 'removeGitRepo', 'removeSessionReference', 'resetContextFile',
  'resetDecisionMetrics', 'resetDecisionSettings', 'resetDefaultAgent', 'resetDictionary',
  'resetEgressPolicy', 'resetEventsSettings', 'resetGatewayPatterns', 'resetLlmGatewaySettings', 'resetMcpNetworkPolicy',
  'resetMcpPolicy', 'resetMcpSettings', 'resetProtectedPaths', 'resetSkillsSettings',
  'resetToolsDisabled', 'resetToolsPolicy', 'resumeQueue', 'resumeSubagent',
  'retryMessage', 'retryQueueNow', 'returnQueue', 'revokeEventBindingKey',
  'revokeServiceKey', 'runSchedule', 'saveAgent', 'saveContextFile',
  'saveDebugConfig', 'saveDictionary', 'saveEgressPolicy', 'saveGatewayPatterns', 'saveLlmGatewaySettings',
  'saveMcpNetworkPolicy', 'saveMcpPolicy', 'saveMcpToolSettings', 'saveModel',
  'saveProtectedPaths', 'saveSecuritySettings', 'saveToolsDisabled', 'saveToolsPolicy',
  'scanGitRepos', 'scheduleRestore', 'setDefaultAgent', 'setWorkspacePolicy', 'setWorkspaceSetting',
  'stopGeneration', 'summarizeSession', 'testProvider', 'testWebhookSubscription',
  'toggleAgent', 'toggleContextFile', 'toggleMessage', 'unlinkAgentSshKey',
  'updateDecisionSettings', 'updateEventBindingKey', 'updateEventsSettings', 'updateMcpRegistryEntry',
  'updateOptimization', 'updateProject', 'updateProjectMcp', 'updateProjectSkills',
  'updateProvider', 'updateSchedule', 'updateServiceKey', 'updateSession',
  'updateSessionMcp', 'updateSessionSkills', 'updateSkill', 'updateSkillBundle',
  'updateSkillsSettings', 'updateSshKey', 'updateStickyNote', 'updateUser',
  'updateWebhookSubscription', 'uploadFile', 'upsertEventBinding', 'validateRestoreByRef',
  'validateRestoreUpload', 'writeFile',
] as const

describe('synthApi contract (ADR-095)', () => {
  it('набор методов совпадает с зафиксированным (245)', () => {
    expect(Object.keys(synthApi).sort()).toEqual([...EXPECTED_API_METHODS])
  })

  it('каждый член — функция', () => {
    for (const name of Object.keys(synthApi)) {
      expect(typeof (synthApi as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
