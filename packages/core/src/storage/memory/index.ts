/**
 * Barrel in-memory реализаций портов хранения (ADR-096, шаг W2.2).
 *
 * Второй backend за единым слоем хранения (после файлового): чистая реализация
 * без модулей ФС (`fs`/`path`), состояние — в памяти процесса. Используется в
 * тестах (контрактный suite) и будущим режимом `storage.backend: 'memory'`.
 */

export { MemorySessionRepository, MemoryProjectRepository, MemoryProfileRepository } from './sessions.js';

export {
  MemorySettingsRepository,
  MemoryDefaultsRepository,
  MemorySecretPatternRepository,
  MemoryProtectedPathsRepository,
  MemoryDictionaryRepository,
} from './settings.js';

export {
  MemoryEventBindingRepository,
  MemoryEventRouteRepository,
  MemoryEventJournalRepository,
  MemoryEventApiKeyRepository,
  MemoryIdentityClaimRepository,
  MemoryDedupRepository,
  MemoryMcpRegistryRepository,
  MemoryServiceKeyRepository,
} from './events.js';

export { MemoryWebhookRepository, MemoryWebhookDeliveryRepository } from './webhooks.js';
// ADR-105 (Ф1): внешние доступы (OAuth-креды к коннекторам).
export { MemoryExternalCredentialRepository } from './external-credentials.js';

export { MemoryScheduleRepository, MemoryJobRepository } from './scheduler.js';

export { MemoryMaintenanceAuditRepository } from './audit.js';
// PROP-090 §9: журнал аудита плагинов (отдельный порт, не security-аудит).
export { MemoryPluginAuditRepository } from './plugin-audit.js';
// PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов.
export { MemoryPluginLockRepository } from './plugin-lock.js';
export { MemorySecurityAuditRepository, MemoryEgressRequestLogRepository } from './security-audit.js';
// ADR-106: порты Authority-слоя (политика инстанса + журнал решений).
export { MemoryAuthorityPolicyRepository } from './authority-policy.js';
export { MemoryAuthorityDecisionJournal } from './authority-decision-journal.js';
export { MemoryAnalyticsRollupRepository } from './analytics-rollup.js';

export {
  MemorySkillRepository,
  MemorySkillBundleRepository,
  MemoryContextFileRepository,
  MemoryBlobStore,
  MemorySSHKeyRepository,
  // ADR-051/ADR-100 + ADR-086 §5: пайплайны и реестр установок пакетов.
  MemoryPipelineRepository,
  MemoryPackRepository,
} from './content.js';

// ADR-101 (Pipeline Engine): спецификации пайплайнов, прогоны и журнал выполнения.
export { MemoryProjectPipelineRepository, MemoryPipelineRunRepository } from './pipelines.js';

// ADR-096 (W2.4): конфигурационные словари (провайдеры/модели/агенты) — общий generic-порт.
export { MemoryDocumentRepository } from './document-repository.js';
