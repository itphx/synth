/**
 * Доменные порты слоя хранения (ADR-096, шаг W2.1).
 *
 * ## Почему доменные порты, а не generic-KV
 *
 * Единый абстрактный слой хранения должен допускать «второй вариант хранения»
 * поверх того же контракта: сегодня — файловый backend (JSON + атомарная запись,
 * ADR-005), позже — БД (Postgres/SQLite, ADR-097), при этом standalone остаётся
 * на файлах без внешних зависимостей. Универсальный `get/put/list(key)`-KV такой
 * переход не тянет: он не выражает видимость сессий, «лёгкие метаданные без
 * messages», поиск, пагинацию и уникальность метки — а SQL может.
 *
 * Поэтому контракт — это то, что домен реально делает, а не форма хранения:
 *   - предметные методы (`listForUser`, `findByKey`, `resolveBySecret`, …);
 *   - явные методы под эффективные выборки SQL-бэкенда (помечены `@future-backend`;
 *     файловая реализация вправе сканировать);
 *   - `BlobStore` — для подсистем, которые не ложатся в таблицы (деревья файлов);
 *   - `DocumentRepository<T>` — для конфигурационных словарей (провайдеры/модели/
 *     агенты): здесь домен и есть «ключ → JSON-документ», generic-порт оправдан
 *     (см. `document-repository.ts`).
 *
 * Реализации первого контура (`FileStore`, `ProjectStore`, …) объявляют
 * `implements` соответствующих портов; поведение при этом не меняется — это
 * только типизация. Переключение DI и БД-реализации — последующие шаги.
 */

export type { SessionRepository, SessionFilter } from './session-repository.js';
export type { ProjectRepository, CreateProjectData } from './project-repository.js';
export type { ProfileRepository } from './profile-repository.js';
export type { SettingsRepository } from './settings-repository.js';
export type {
  McpRegistryRepository,
  McpRegistryManagerMaps,
} from './mcp-registry-repository.js';
export type {
  ServiceKeyRepository,
  ServiceKeyResolution,
} from './service-key-repository.js';
export type {
  EventApiKeyRepository,
  EventApiKeyResolution,
} from './event-api-key-repository.js';
export type { EventBindingRepository } from './event-binding-repository.js';
export type { EventRouteRepository } from './event-route-repository.js';
export type { EventJournalRepository } from './event-journal-repository.js';
export type { IdentityClaimRepository } from './identity-claim-repository.js';
export type { WebhookRepository } from './webhook-repository.js';
export type { WebhookDeliveryRepository } from './webhook-delivery-repository.js';
export type { ScheduleRepository } from './schedule-repository.js';
export type { JobRepository } from './job-repository.js';
export type {
  MaintenanceAuditRepository,
  MaintenanceAuditListOptions,
} from './maintenance-audit-repository.js';
// PROP-090 §9: журнал аудита плагинов (отдельный порт, не security-аудит).
export type {
  PluginAuditRepository,
  PluginAuditListOptions,
} from './plugin-audit-repository.js';
// PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов (источник истины для
// update/uninstall).
export type { PluginLockRepository } from './plugin-lock-repository.js';
export type {
  SecurityAuditRepository,
  SecurityAuditListOptions,
} from './security-audit-repository.js';
export type {
  EgressRequestLogRepository,
  EgressRequestLogListOptions,
} from './egress-request-log-repository.js';
export type { AnalyticsRollupRepository } from './analytics-rollup-repository.js';
export type { DedupRepository } from './dedup-repository.js';
export type { SecretPatternRepository } from './secret-pattern-repository.js';
export type { ProtectedPathsRepository } from './protected-paths-repository.js';
export type { SkillRepository } from './skill-repository.js';
export type { SkillBundleRepository } from './skill-bundle-repository.js';
export type { DictionaryRepository } from './dictionary-repository.js';
export type { DocumentRepository } from './document-repository.js';
export type { ContextFileRepository } from './context-file-repository.js';
export type { SSHKeyRepository } from './ssh-key-repository.js';
export type { BlobStore } from './blob-store.js';
export type { DefaultsRepository, AppearanceDefaults } from './defaults-repository.js';
// ADR-051/ADR-100: пайплайны (определения + экземпляры).
export type {
  PipelineRepository,
  PipelineDefinitionRecord,
  PipelineInstanceRecord,
  PipelineInstanceFilter,
} from './pipeline-repository.js';
export {
  PIPELINE_INSTANCE_DEFAULT_LIMIT,
  PIPELINE_INSTANCE_MAX_LIMIT,
  resolvePipelineInstanceLimit,
} from './pipeline-repository.js';
// ADR-086 §5: реестр установок пакетов расширений.
export type {
  PackRepository,
  PackInstallation,
  PackInstallationProvides,
  PackInstallationStatus,
} from './pack-repository.js';
// ADR-101 (Pipeline Engine): спецификации пайплайнов (черновик + опубликованные
// версии), прогоны и журнал выполнения. Не путать с legacy-портом ADR-100 выше —
// он заменяется на Э3.
export type {
  ProjectPipelineRepository,
  PipelineRecord,
  PipelineVersionRecord,
  PipelineScope,
  PipelineProvenance,
  PipelineFilter,
} from './project-pipeline-repository.js';
export type {
  PipelineRunRepository,
  PipelineRunRecord,
  PipelineRunEventRecord,
  PipelineRunFilter,
  PipelineRunEventListOptions,
} from './pipeline-run-repository.js';
export {
  COLLECTION_LIMIT_DEFAULT,
  COLLECTION_LIMIT_MAX,
  resolveCollectionLimit,
} from './collection-limit.js';
// PROP-108: порты Authority-слоя (политика инстанса + журнал решений).
export type { AuthorityPolicyRepository } from './authority-policy-repository.js';
export type {
  AuthorityDecisionJournal,
  AuthorityDecisionListOptions,
} from './authority-decision-journal.js';
