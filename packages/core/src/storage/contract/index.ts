/**
 * Контрактный suite портов хранения (ADR-096, W2.1).
 *
 * Каждая функция `describeXxxRepository(name, make)` — компактный «паспорт»
 * порта: ключевые операции (создание/чтение/список/удаление/идемпотентность) и
 * инварианты, обязательные для ЛЮБОЙ реализации (`delete` отсутствующего — не
 * ошибка; `list` на пустом — `[]`; порядок сортировки; уникальность label).
 * Тот же набор позже прогоняется на memory/БД-реализациях.
 *
 * `make()` возвращает готовую реализацию и опциональный `dispose`.
 */

export { describeSessionRepository } from './principals.js';
export { describeProjectRepository } from './principals.js';
export { describeProfileRepository } from './principals.js';
export { describeSettingsRepository } from './principals.js';

export { describeEventBindingRepository } from './events.js';
export { describeEventRouteRepository } from './events.js';
export { describeEventJournalRepository } from './events.js';
export { describeEventApiKeyRepository } from './events.js';
export { describeIdentityClaimRepository } from './events.js';
export { describeDedupRepository } from './events.js';

export { describeScheduleRepository } from './scheduler.js';
export { describeJobRepository } from './scheduler.js';
export { describeMaintenanceAuditRepository } from './maintenance.js';
// PROP-090 §9: журнал аудита плагинов (отдельный порт).
export { describePluginAuditRepository } from './plugin-audit-repository.contract.js';
// PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов.
export { describePluginLockRepository } from './plugin-lock-repository.contract.js';
export {
  describeSecurityAuditRepository,
  describeEgressRequestLogRepository,
} from './audit.js';
export { describeAnalyticsRollupRepository } from './analytics.js';

export { describeServiceKeyRepository } from './secrets.js';
export { describeSSHKeyRepository } from './secrets.js';
export { describeWebhookRepository } from './secrets.js';
export { describeWebhookDeliveryRepository } from './secrets.js';

export { describeMcpRegistryRepository } from './content.js';
export { describeSkillRepository } from './content.js';
export { describeSkillBundleRepository } from './content.js';
export { describeDictionaryRepository } from './content.js';
export { describeDocumentRepository } from './content.js';
export { describeContextFileRepository } from './content.js';
export { describeSecretPatternRepository } from './content.js';
export { describeProtectedPathsRepository } from './content.js';

export { describeBlobStore } from './misc.js';
export { describeDefaultsRepository } from './misc.js';

// ADR-051/ADR-100 (пайплайны) и ADR-086 §5 (реестр установок пакетов).
export { describePipelineRepository } from './pipeline-repository.contract.js';
export { describePackRepository } from './pack-repository.contract.js';

// ADR-101 (Pipeline Engine): спецификации пайплайнов, прогоны и журнал выполнения.
export { describeProjectPipelineRepository } from './project-pipeline-repository.contract.js';
export { describePipelineRunRepository } from './pipeline-run-repository.contract.js';

export { createTmpDir, makeSession, makeMessage, makeProject, makeProfile } from './helpers.js';
