/**
 * StorageContext — единая точка сборки слоя хранения (ADR-096, шаг W2.3).
 *
 * Делает шов реальным: домен (composition root — `server/app/deps.ts`,
 * `backend/app/deps.ts`) получает порты из одного места, а не собирает
 * конкретные классы по-отдельности. Сейчас доступны два backend'а:
 *   - `file`   — файловые реализации (JSON + атомарная запись, ADR-005);
 *   - `memory` — in-memory реализации (герметичные тесты, без ФС).
 *
 * Каждый вызов фабрики создаёт **новые** экземпляры (никаких модульных
 * синглтонов) — это важно для герметичных тестов.
 */

import { join } from 'node:path';
import type { AgentDefinition, ModelConfig, PostgresSslMode, PostgresStorageConfig, ProviderConfig, SecurityTlsConfig, SynthConfig, TlsRuntimeSettings } from '@itphx/synth-shared';
import {
  normalizePostgresSslMode,
  readTlsRuntimeSettings,
  resolveDegradedMode,
  resolvePostgresConfig,
  resolvePostgresPassword,
  resolveSecretKey,
  resolveStorageBackend,
  resolveStorageFallbackDir,
} from '@itphx/synth-shared';
import type {
  AnalyticsRollupRepository,
  BlobStore,
  ContextFileRepository,
  DedupRepository,
  DefaultsRepository,
  DictionaryRepository,
  DocumentRepository,
  EventApiKeyRepository,
  EventBindingRepository,
  EventJournalRepository,
  EventRouteRepository,
  ExternalCredentialRepository,
  IdentityClaimRepository,
  JobRepository,
  MaintenanceAuditRepository,
  PluginAuditRepository,
  PluginLockRepository,
  SecurityAuditRepository,
  EgressRequestLogRepository,
  McpRegistryRepository,
  PackRepository,
  PipelineRepository,
  PipelineRunRepository,
  ProfileRepository,
  ProjectPipelineRepository,
  ProjectRepository,
  ProtectedPathsRepository,
  ScheduleRepository,
  SecretPatternRepository,
  ServiceKeyRepository,
  SessionRepository,
  SettingsRepository,
  SkillBundleRepository,
  SkillRepository,
  SSHKeyRepository,
  WebhookDeliveryRepository,
  WebhookRepository,
} from './ports/index.js';

// ── Файловые реализации ────────────────────────────────────────────────
import { FileStore } from './file-store.js';
import { JsonStore } from './json-store.js';
import { ProjectStore } from './project-store.js';
import { FileProfileStore } from './profile-store.js';
import { RuntimeSettingsStore } from './runtime-settings.js';
import { DefaultsStore } from './defaults-store.js';
import { SecretPatternStore } from '../engine/gateway/secret-pattern-store.js';
import type { SecretPattern } from '../engine/gateway/secret-pattern-store.js';
import { DEFAULT_PATTERNS } from '../engine/gateway/secret-detector.js';
import { ProtectedPathsStore } from '../engine/security/protected-paths-store.js';
import { loadProtectedPaths } from '../engine/security/protected-paths.js';
import type { ProtectedPathsPolicy } from '../engine/security/protected-paths.js';
import { DictionaryStore } from '../engine/router/dictionary-store.js';
import { McpRegistryStore } from './mcp-registry-store.js';
import { ServiceApiKeyStore } from './service-api-key-store.js';
import { EventApiKeyStore } from './event-api-key-store.js';
import { EventBindingStore } from './event-binding-store.js';
import { EventJournalStore } from './event-journal-store.js';
import { RouteRuleStore } from './route-rule-store.js';
import { IdentityClaimStore } from './identity-claim-store.js';
import { WebhookStore } from './webhook-store.js';
import { WebhookDeliveryStore } from './webhook-delivery-store.js';
import { ScheduleStore } from './schedule-store.js';
import { JobStore } from './job-store.js';
import { MaintenanceAuditStore } from './maintenance-audit-store.js';
import { FilePluginAuditStore } from './file-plugin-audit-store.js';
import { FilePluginLockStore, defaultPluginLockPath } from './file-plugin-lock-store.js';
import { SecurityAuditStore } from './security-audit-store.js';
// PROP-107 (Ф1): внешние доступы (OAuth-креды к коннекторам) —
// `{dataDir}/secrets/oauth/credentials.json` (в `secrets/` — чтобы обычный
// бэкап без `--with-secrets` их не захватывал, PROP-107 §10).
import { ExternalCredentialStore } from './external-credential-store.js';
import { applyStartupProxyConfig } from '../security/proxy-startup.js';
import { EgressRequestLogStore } from './egress-request-log-store.js';
import { AnalyticsRollupStore } from './analytics-rollup-store.js';
import { FileDedupStore, MemoryDedupStore } from '../engine/events/dedup-store.js';
import { SkillStore } from './skill-store.js';
import { SkillBundleStore } from './skill-bundle-store.js';
import { FilePipelineStore } from './file-pipeline-store.js';
import { FilePackStore } from './file-pack-store.js';
import { FileProjectPipelineStore } from './file-project-pipeline-store.js';
import { FilePipelineRunStore } from './file-pipeline-run-store.js';
import { ContextConfig } from '../engine/context/config.js';
import { SSHKeyStore } from './ssh-key-store.js';
import { FileBlobStore } from './file-blob-store.js';
import type { LeaderFactoryOptions, Mutex, MutexFactoryOptions } from './mutex.js';
import type { SchedulerLeader } from '../engine/scheduler/leader.js';
import { setStorageDegradedState } from '../engine/permission/storage-state.js';

// ── In-memory реализации ───────────────────────────────────────────────
import {
  MemoryAnalyticsRollupRepository,
  MemoryBlobStore,
  MemoryContextFileRepository,
  MemoryDefaultsRepository,
  MemoryDictionaryRepository,
  MemoryDocumentRepository,
  MemoryEventApiKeyRepository,
  MemoryEventBindingRepository,
  MemoryEventJournalRepository,
  MemoryEventRouteRepository,
  MemoryExternalCredentialRepository,
  MemoryIdentityClaimRepository,
  MemoryJobRepository,
  MemoryMaintenanceAuditRepository,
  MemoryPluginAuditRepository,
  MemoryPluginLockRepository,
  MemorySecurityAuditRepository,
  MemoryEgressRequestLogRepository,
  MemoryMcpRegistryRepository,
  MemoryPackRepository,
  MemoryPipelineRepository,
  MemoryPipelineRunRepository,
  MemoryProfileRepository,
  MemoryProjectPipelineRepository,
  MemoryProjectRepository,
  MemoryProtectedPathsRepository,
  MemoryScheduleRepository,
  MemorySecretPatternRepository,
  MemoryServiceKeyRepository,
  MemorySessionRepository,
  MemorySettingsRepository,
  MemorySkillBundleRepository,
  MemorySkillRepository,
  MemorySSHKeyRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookRepository,
  MemoryDedupRepository,
} from './memory/index.js';

/** Физический backend хранения (`storage.backend` в конфиге). */
export type StorageBackendKind = 'file' | 'memory' | 'postgres';

/**
 * ADR-097: backend-специфичные примитивы межпроцессной координации
 * (advisory-локи БД). Предоставляется backend'ом, у которого есть механизм
 * блокировки за пределами общего FS (сейчас — только `postgres`); file/memory
 * `locks` не задают, и домен использует `FileMutex`/`FileLeader` напрямую.
 */
export interface StorageLocks {
  /** Мьютекс для namespaced-имени (PG: session-level advisory-lock). */
  createMutex(options: MutexFactoryOptions): Mutex;
  /** Лидер-выбор планировщика для namespaced-имени (PG: удерживаемый advisory-lock). */
  createLeader(options: LeaderFactoryOptions): SchedulerLeader;
}

/**
 * ADR-097/ADR-091: снимок здоровья backend'а хранения — диагностика
 * `synth doctor` и admin-API. Для `postgres` — реальный пробный запрос
 * (`latencyMs`) и версия схемы БД; файловые backend'ы шов не задают.
 */
export interface StorageHealth {
  /** Проба прошла успешно (соединение живо). */
  ok: boolean;
  /** Задержка пробного запроса, мс. */
  latencyMs?: number;
  /** Версия схемы backend'а (postgres: `synth_schema_migrations`); `null` — нет схемы. */
  schemaVersion?: number | null;
  /** Ожидаемая (поддержанная драйвером) версия схемы. */
  expectedSchemaVersion?: number;
  /** Текст ошибки, если проба не удалась. */
  error?: string;
}

/**
 * ADR-097/ADR-092: план/применение миграций схемы **backend'а** (postgres).
 * Отдельный контур от файлового `meta.json` (ADR-092) — версия живёт в БД.
 */
export interface StorageSchemaMigrationResult {
  /** Текущая версия схемы (`null` — таблица миграций/схема отсутствует). */
  current: number | null;
  /** Ожидаемая (целевая) версия. */
  expected: number;
  /** Версии, ожидающие применения (по возрастанию). */
  pending: number[];
  /** Применённые в этом вызове версии (пусто при `dryRun`). */
  applied: number[];
}

/**
 * ADR-097: режим работы со схемой БД при сборке контекста (`postgres`):
 * `apply` (дефолт) — применить недостающие миграции; `assert` — проверить
 * актуальность (fail-closed, DBA-режим); `skip` — не трогать схему
 * (диагностика `synth doctor` и CLI-команды, которые управляют миграциями сами).
 */
export type PostgresSchemaMode = 'apply' | 'assert' | 'skip';

/**
 * ADR-098 (W5): снимок пробного подключения к недоступному backend'у
 * (диагностика деградированного режима — `/api/v2/storage/status`).
 */
export interface StorageBackendProbe {
  /** Соединение установлено. */
  ok: boolean;
  /** Задержка пробного запроса, мс. */
  latencyMs?: number;
  /** Текст ошибки, если соединения нет. */
  error?: string;
}

/**
 * ADR-098 (W5): деградированный режим хранилища. Возникает, когда выбранный
 * backend (`postgres`) недоступен на старте, а `storage.degradedMode`
 * `fallback-file`: сервис поднимается на файловом хранилище в `fallbackDir`,
 * **строго read-only** (мутации отклоняются, `503 STORAGE_DEGRADED_READONLY`).
 * Доступ — только администраторам (managed) / единственному владельцу (standalone).
 *
 * Авто-возврата к БД нет: `StorageContext` замкнут в deps, живая подмена
 * рискованна. Возврат — рестарт после восстановления соединения; проверка
 * соединения — `probe` (`GET /api/v2/storage/status`).
 */
export interface StorageDegradedInfo {
  /** Всегда `true` (маркер состояния). */
  active: true;
  /** Backend, который оказался недоступен. */
  backend: StorageBackendKind;
  /** Каталог файлового фоллбека, на котором поднят сервис (отдельный от dataDir!). */
  fallbackDir: string;
  /** Человекочитаемая причина недоступности backend'а. */
  reason: string;
  /** Момент входа в режим (ISO). */
  since: string;
  /** Пробное подключение к исходному backend'у (для диагностики возврата). */
  probe?: () => Promise<StorageBackendProbe>;
}

/**
 * Собранный слой хранения: домен получает порты (а не конкретные классы).
 * Поле `kind` — какой backend собран (для диагностики/предупреждений).
 */
export interface StorageContext {
  kind: StorageBackendKind;
  /**
   * ADR-098 (W5): сервис работает на файловом фоллбеке, т.к. выбранный backend
   * (`postgres`) недоступен. Задано только в деградированном режиме.
   */
  degraded?: StorageDegradedInfo;
  /**
   * ADR-097: освобождение ресурсов backend'а (пул соединений и т.п.).
   * Опционально: `file`/`memory` его не задают (ресурсов процесса нет), драйвер
   * БД удерживает соединение в контексте и закрывает его здесь. Домен зовёт
   * `close()` на graceful shutdown (`synth serve`).
   */
  close?(): Promise<void>;
  /**
   * ADR-097: примитивы координации БД (advisory-локи). Не задано для
   * file/memory — домен тогда использует файловые `FileMutex`/`FileLeader`.
   */
  locks?: StorageLocks;
  /**
   * ADR-097/ADR-091: диагностика backend'а (probe БД + версия схемы). Не задано
   * для file/memory — контур `doctor` тогда работает по файловому каталогу.
   */
  health?(): Promise<StorageHealth>;
  /**
   * ADR-097/ADR-092: миграции схемы backend'а (`postgres`) — план (`dryRun`) или
   * применение. Не задано для file/memory (там `meta.json`/`runMigrations` core).
   */
  schemaMigrations?(opts?: { dryRun?: boolean }): Promise<StorageSchemaMigrationResult>;
  /**
   * ADR-097: удаление схемы backend'а (`postgres`) — `synth uninstall --purge-db`.
   * По умолчанию данные БД не трогаются; вызывается только по явному флагу.
   */
  purgeSchema?(): Promise<void>;
  sessions: SessionRepository;
  projects: ProjectRepository;
  profiles: ProfileRepository;
  settings: SettingsRepository;
  defaults: DefaultsRepository;
  secretPatterns: SecretPatternRepository;
  protectedPaths: ProtectedPathsRepository;
  dictionaries: DictionaryRepository;
  /** Конфигурационные словари (ADR-096, W2.4): `providers`/`models`/`agents`. */
  providers: DocumentRepository<ProviderConfig>;
  models: DocumentRepository<ModelConfig>;
  agents: DocumentRepository<AgentDefinition>;
  mcpRegistry: McpRegistryRepository;
  serviceKeys: ServiceKeyRepository;
  eventApiKeys: EventApiKeyRepository;
  eventBindings: EventBindingRepository;
  eventRoutes: EventRouteRepository;
  eventJournal: EventJournalRepository;
  identityClaims: IdentityClaimRepository;
  webhooks: WebhookRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  schedules: ScheduleRepository;
  jobs: JobRepository;
  maintenanceAudit: MaintenanceAuditRepository;
  /**
   * PROP-090 §9: журнал аудита плагинов (append-only). Отдельный порт, а не
   * расширение `securityAudit`: семантика «событие расширения» ≠ «изменение
   * политики».
   */
  pluginAudit: PluginAuditRepository;
  /**
   * PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов (`plugins.lock.json`) —
   * **источник истины** для update/uninstall (провенанс: источник, pin,
   * content-hash, доверие, вердикт скана).
   */
  pluginLock: PluginLockRepository;
  /** Аудит изменений egress/security-политик (append-only). */
  securityAudit: SecurityAuditRepository;
  /** Журнал внешних запросов (append-only, retention-прунер). */
  egressRequests: EgressRequestLogRepository;
  /** ADR-102: пред-агрегированные суточные роллапы аналитики. */
  analyticsRollups: AnalyticsRollupRepository;
  dedup: DedupRepository;
  skills: SkillRepository;
  skillBundles: SkillBundleRepository;
  contextFiles: ContextFileRepository;
  sshKeys: SSHKeyRepository;
  /**
   * PROP-107 (Ф1): внешние доступы к коннекторам (OAuth-креды). Порт хранит
   * метаданные и зашифрованные токены; plaintext наружу не отдаётся.
   */
  externalCredentials: ExternalCredentialRepository;
  blobs: BlobStore;
  /** ADR-051/ADR-100: определения и экземпляры пайплайнов. */
  pipelines: PipelineRepository;
  /** ADR-086 §5: реестр установок пакетов расширений. */
  packs: PackRepository;
  /**
   * ADR-101: спецификации пайплайнов (черновик + опубликованные версии).
   * Не путать с `pipelines` выше — legacy-декларации ADR-100 (заменяются на Э3).
   */
  projectPipelines: ProjectPipelineRepository;
  /** ADR-101: прогоны пайплайнов и журнал выполнения (append-only). */
  pipelineRuns: PipelineRunRepository;
}

/** Параметры сборки слоя хранения (общие для file/memory). */
export interface StorageContextConfig {
  dataDir: string;
  /** ADR-076: мастер-ключ секретов at-rest (env > config > файл в dataDir). */
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** `events.dedupStore`: 'memory' (дефолт) | 'file'. */
  dedupStore?: 'memory' | 'file';
  /** `scheduler.crossProcessLocks` — сериализация мутаций ScheduleStore. */
  scheduleCrossProcess?: boolean;
  /** Каталог системных словарей (по умолчанию — `dictionaries/` пакета core). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (по умолчанию `{dataDir}/context`). */
  contextUserDataDir?: string;
  /** `commands.bundlesPath` — каталог instance-bundles (like-for-like с deps). */
  bundlesPath?: string;
  /** Каталог встроенных промптов (`StandaloneConfig.systemPromptsDir`). */
  systemPromptsDir?: string;
  /**
   * ADR-097: параметры PostgreSQL (используются при `kind: 'postgres'`); пароль
   * сюда НЕ входит — отдельное поле `postgresPassword` (инвариант 13).
   */
  postgres?: PostgresStorageConfig;
  /**
   * ADR-099: доверие TLS/CA (`security.tls`) — источник CA/mTLS для
   * `storage.postgres.sslmode=verify-full` (прокидывается драйверу БД).
   */
  security?: { tls?: SecurityTlsConfig };
  /**
   * ADR-099: runtime bootstrap-настройки TLS (`{dataDir}/security-tls.json`) —
   * per-host клиентские профили для БД и исходящих запросов. Читаются до
   * подключения к PostgreSQL.
   */
  tlsRuntime?: TlsRuntimeSettings;
  /** ADR-097: пароль PostgreSQL (env/файл, не config.yaml). */
  postgresPassword?: string;
  /** ADR-097: режим работы со схемой БД при сборке (см. `PostgresSchemaMode`). */
  postgresSchemaMode?: PostgresSchemaMode;
  /** ADR-098 (задел W5): политика при недоступности backend. */
  degradedMode?: 'fallback-file' | 'halt';
  /** ADR-098 (задел W5): каталог файлового фоллбека при деградации. */
  fallbackDir?: string;
  /**
   * PROP-090 §5: путь к lock-файлу плагинов. По умолчанию —
   * `{dataDir}/plugin/plugins.lock.json`; при home-модели (ADR-079) —
   * `<home>/plugin/plugins.lock.json` (путь задаёт composition root).
   */
  pluginLockPath?: string;
}

/**
 * ADR-097/ADR-078: выбранный внешний backend недоступен (нет пакета-драйвера
 * или он не экспортирует фабрику). Ошибка «внешняя зависимость недоступна» —
 * потребитель показывает понятное сообщение, а не сырой трейс `import()`.
 */
export class StorageBackendUnavailableError extends Error {
  readonly code = 'STORAGE_BACKEND_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'StorageBackendUnavailableError';
    if (options && options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * ADR-098 (W5): выбранный backend (`postgres`) недоступен, а политика
 * `storage.degradedMode='halt'` запрещает файловый фоллбек — старт остановлен.
 * Ошибка с внятным текстом (что не так и что делать), а не сырой трейс драйвера.
 */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'StorageUnavailableError';
    if (options && options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Конфиг, передаваемый драйверу `@itphx/synth-storage-postgres` — форма драйвера
 * (ADR-097): `connectionString` либо `pool.{host, database}`. Резолвер
 * `resolvePostgresConfig` отдаёт «плоскую» форму (`dsn`/`host`/…), поэтому
 * `createPostgresStorage` мапит её в этот контракт (иначе драйвер не получал бы
 * способа подключения и падал на валидации).
 */
export interface PostgresStorageDriverConfig {
  /** Каталог данных инстанса (`{dataDir}`) — для секретов/файловых нужд драйвера. */
  dataDir: string;
  /** Строка подключения `postgres://…` (из `storage.postgres.dsn`/`SYNTH_POSTGRES_DSN`); приоритетнее `pool`. */
  connectionString?: string;
  /** Параметры пула, если `connectionString` не задана. */
  pool?: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    /** Максимальный размер пула (`storage.postgres.poolMax`). */
    max?: number;
    /**
     * ADR-099/ADR-097: TLS-режим (`storage.postgres.sslmode`, нормализованный;
     * `verify-ca` → `verify-full`). Не задан — используется legacy `ssl`.
     */
    sslmode?: PostgresSslMode;
    /** Legacy-флаг TLS (`storage.postgres.ssl`; когда `sslmode` не задан). */
    ssl?: boolean;
  };
  /**
   * ADR-099: доверие TLS/CA (`security.tls`) — CA/mTLS для `verify-full`.
   * Единый источник доверия (тот же, что для исходящих https-запросов).
   */
  tls?: SecurityTlsConfig;
  /** ADR-099: runtime bootstrap-настройки TLS (per-host mTLS, CA/reject). */
  tlsRuntime?: TlsRuntimeSettings;
  /** Env для резолва `security.tls` (ADR-023). */
  env?: NodeJS.ProcessEnv;
  /** Схема БД (namespace таблиц). */
  schema?: string;
  /** Пароль БД (инвариант 13: не из config.yaml; env/файл). */
  password?: string;
  /**
   * ADR-097: режим работы со схемой при сборке контекста (`apply`/`assert`/`skip`).
   * `skip` — только подключение (диагностика/CLI, управляющие миграциями сами).
   */
  schemaMode?: PostgresSchemaMode;
  /**
   * ADR-097: инъекция синхронных данных core в драйвер — sync-геттеры
   * портов (`secretPatterns`/`protectedPaths`/`dictionaries`) не могут ждать I/O
   * или ленивый `import()`. Core собирает значения у себя (ассеты/реестры) и
   * передаёт драйверу вместо обхода его `exports`-карты.
   */
  coreSync?: PostgresCoreSyncDeps;
}

/** Синхронные данные core, инъектируемые в драйвер (форма — `PortDeps` драйвера). */
export interface PostgresCoreSyncDeps {
  /** Дефолтные паттерны детекции секретов (`DEFAULT_PATTERNS`, `RegExp.source` → строка). */
  secretPatterns: SecretPattern[];
  /** Системный base политики защищённых путей (`loadProtectedPaths`, без override). */
  protectedPathsBase: ProtectedPathsPolicy;
  /** Системный источник словарей (`DictionaryStore`). */
  systemDictionaries: DictionaryRepository;
}

/** Локальный тип фабрики драйвера (пакет опционален и не резолвится на этапе типов). */
interface PostgresStorageDriverModule {
  createPostgresStorage(config: PostgresStorageDriverConfig): Promise<StorageContext>;
  /** Каталог-заглушка пользовательских словарей драйвера (общий с его `resolveCoreSyncDeps`). */
  POSTGRES_EMPTY_USER_DICTIONARIES_SUBDIR?: string;
}

/**
 * ADR-097: имя пакета-драйвера. Аннотация `string` намеренная — путь не должен
 * резолвиться TypeScript'ом на этапе типов (пакет опционален), `import()`
 * выполняется только в рантайме.
 */
const POSTGRES_DRIVER_PACKAGE: string = '@itphx/synth-storage-postgres';

/**
 * Файловый backend: те же реализации и аргументы, что собирал
 * `packages/core/src/server/app/deps.ts` (побайтово то же поведение).
 */
export function createFileStorage(config: StorageContextConfig): StorageContext {
  const dataDir = config.dataDir;
  const contextUserDataDir = config.contextUserDataDir ?? join(dataDir, 'context');
  return {
    kind: 'file',
    sessions: new FileStore({ dataDir }),
    projects: new ProjectStore({ dataDir }),
    profiles: new FileProfileStore({ dataDir }),
    settings: new RuntimeSettingsStore({ dataDir }),
    defaults: new DefaultsStore({ dataDir }),
    secretPatterns: new SecretPatternStore({ dataDir }),
    protectedPaths: new ProtectedPathsStore({ dataDir }),
    // Словари: системные — из пакета core (или заданного каталога), пользовательские —
    // `{dataDir}/dictionaries` (позиционный ctor `(userDataDir, systemDir?)`).
    dictionaries: new DictionaryStore(dataDir, config.systemDictionariesDir),
    // ADR-096 (W2.4): провайдеры/модели/агенты — «ключ → JSON-документ».
    providers: new JsonStore<ProviderConfig>({ dataDir, subdir: 'providers' }),
    models: new JsonStore<ModelConfig>({ dataDir, subdir: 'models' }),
    agents: new JsonStore<AgentDefinition>({ dataDir, subdir: 'agents' }),
    mcpRegistry: new McpRegistryStore({ dataDir }),
    serviceKeys: new ServiceApiKeyStore({ dataDir }),
    eventApiKeys: new EventApiKeyStore({ dataDir }),
    eventBindings: new EventBindingStore({ dataDir }),
    eventRoutes: new RouteRuleStore({ dataDir }),
    eventJournal: new EventJournalStore({ dataDir }),
    identityClaims: new IdentityClaimStore({ dataDir }),
    webhooks: new WebhookStore({
      dataDir,
      secretKey: config.secretKey,
      env: config.env,
    }),
    webhookDeliveries: new WebhookDeliveryStore({ dataDir }),
    schedules: new ScheduleStore({
      dataDir,
      crossProcess: config.scheduleCrossProcess,
    }),
    jobs: new JobStore({ dataDir }),
    maintenanceAudit: new MaintenanceAuditStore({ dataDir }),
    // PROP-090 §9: журнал аудита плагинов (`audit/plugins.jsonl`).
    pluginAudit: new FilePluginAuditStore({ dataDir }),
    // PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов. Путь задаётся
    // раскладкой (`<home>/plugin/plugins.lock.json` при home-модели), без
    // home — `{dataDir}/plugin/plugins.lock.json`.
    pluginLock: new FilePluginLockStore({
      path: config.pluginLockPath ?? defaultPluginLockPath(dataDir),
    }),
    securityAudit: new SecurityAuditStore({ dataDir }),
    egressRequests: new EgressRequestLogStore({ dataDir }),
    analyticsRollups: new AnalyticsRollupStore({ dataDir }),
    // ADR-051/ADR-089: источник дедупа — in-process (default) или файловый межпроцессный.
    dedup: config.dedupStore === 'file' ? new FileDedupStore({ dataDir }) : new MemoryDedupStore(),
    skills: new SkillStore({ dataDir }),
    skillBundles: new SkillBundleStore({ dataDir, bundlesPath: config.bundlesPath }),
    contextFiles: new ContextConfig({
      userDataDir: contextUserDataDir,
      systemPromptsDir: config.systemPromptsDir,
    }),
    sshKeys: new SSHKeyStore({
      dataDir,
      secretKey: config.secretKey,
      env: config.env,
    }),
    // PROP-107 (Ф1): доступы к внешним сервисам — `secrets/oauth/credentials.json`
    // (шифрование мастер-ключом, 0600).
    externalCredentials: new ExternalCredentialStore({
      dataDir,
      secretKey: config.secretKey,
      env: config.env,
    }),
    blobs: new FileBlobStore({ root: dataDir }),
    // ADR-051/ADR-100: пайплайны — определения (`pipelines/definitions.json`)
    // и экземпляры (`pipelines/instances.json`).
    pipelines: new FilePipelineStore({ dataDir }),
    // ADR-086 §5: реестр установок пакетов расширений (`packs.json`).
    packs: new FilePackStore({ dataDir }),
    // ADR-101: спецификации пайплайнов (`pipelines/pipelines.json` +
    // `pipelines/versions.json`) и прогоны (`pipelines/runs.json` +
    // append-only `pipelines/run-events.jsonl`).
    projectPipelines: new FileProjectPipelineStore({ dataDir }),
    pipelineRuns: new FilePipelineRunStore({ dataDir }),
  };
}

/**
 * In-memory backend: чистая сборка без модулей ФС (`fs`/`path`), состояние — в
 * памяти процесса. `dedupStore` неактуален — дедуп всегда in-process.
 */
export function createMemoryStorage(config: Partial<StorageContextConfig> = {}): StorageContext {
  void config;
  return {
    kind: 'memory',
    sessions: new MemorySessionRepository(),
    projects: new MemoryProjectRepository(),
    profiles: new MemoryProfileRepository(),
    settings: new MemorySettingsRepository(),
    defaults: new MemoryDefaultsRepository(),
    secretPatterns: new MemorySecretPatternRepository(),
    protectedPaths: new MemoryProtectedPathsRepository(),
    dictionaries: new MemoryDictionaryRepository(),
    providers: new MemoryDocumentRepository<ProviderConfig>(),
    models: new MemoryDocumentRepository<ModelConfig>(),
    agents: new MemoryDocumentRepository<AgentDefinition>(),
    mcpRegistry: new MemoryMcpRegistryRepository(),
    serviceKeys: new MemoryServiceKeyRepository(),
    eventApiKeys: new MemoryEventApiKeyRepository(),
    eventBindings: new MemoryEventBindingRepository(),
    eventRoutes: new MemoryEventRouteRepository(),
    eventJournal: new MemoryEventJournalRepository(),
    identityClaims: new MemoryIdentityClaimRepository(),
    webhooks: new MemoryWebhookRepository(),
    webhookDeliveries: new MemoryWebhookDeliveryRepository(),
    schedules: new MemoryScheduleRepository(),
    jobs: new MemoryJobRepository(),
    maintenanceAudit: new MemoryMaintenanceAuditRepository(),
    pluginAudit: new MemoryPluginAuditRepository(),
    pluginLock: new MemoryPluginLockRepository(),
    securityAudit: new MemorySecurityAuditRepository(),
    egressRequests: new MemoryEgressRequestLogRepository(),
    analyticsRollups: new MemoryAnalyticsRollupRepository(),
    dedup: new MemoryDedupRepository(),
    skills: new MemorySkillRepository(),
    skillBundles: new MemorySkillBundleRepository(),
    contextFiles: new MemoryContextFileRepository(),
    sshKeys: new MemorySSHKeyRepository(),
    externalCredentials: new MemoryExternalCredentialRepository(),
    blobs: new MemoryBlobStore(),
    pipelines: new MemoryPipelineRepository(),
    packs: new MemoryPackRepository(),
    projectPipelines: new MemoryProjectPipelineRepository(),
    pipelineRuns: new MemoryPipelineRunRepository(),
  };
}

/**
 * ADR-096: диспетчер backend'а по `storage.backend`. Синхронный — только для
 * `file`/`memory` (обратная совместимость тестов). `postgres` требует
 * асинхронной сборки (динамический `import()` драйвера) — используйте
 * `createStorageContextAsync`. Домен должен вызывать async-версию.
 *
 * @deprecated используйте `createStorageContextAsync` (единый асинхронный каскад).
 */
export function createStorageContext(
  kind: StorageBackendKind,
  config: StorageContextConfig,
): StorageContext {
  if (kind === 'memory') return createMemoryStorage(config);
  if (kind === 'file') return createFileStorage(config);
  if (kind === 'postgres') {
    throw new StorageBackendUnavailableError(
      "createStorageContext('postgres', …) синхронно недоступен — используйте createStorageContextAsync().",
    );
  }
  // Fail-closed: неизвестный backend (опечатка в значении) не подменяется файловым.
  throw new StorageUnavailableError(
    `storage.backend="${String(kind)}" не поддерживается — ожидается 'file' | 'memory' | 'postgres'.`,
  );
}

/**
 * ADR-097: сборка PostgreSQL-backend через динамический `import()` опционального
 * пакета-драйвера. Пакет не резолвится на этапе типов (см. `POSTGRES_DRIVER_PACKAGE`).
 * Нет пакета/`pg` — понятная ошибка `StorageBackendUnavailableError` (ADR-078),
 * а не сырой трейс `import()`.
 */
export async function createPostgresStorage(config: StorageContextConfig): Promise<StorageContext> {
  let mod: PostgresStorageDriverModule;
  try {
    mod = (await import(POSTGRES_DRIVER_PACKAGE)) as PostgresStorageDriverModule;
  } catch (err) {
    throw new StorageBackendUnavailableError(
      `storage.backend='postgres' недоступен: не удалось загрузить драйвер ` +
        `'${POSTGRES_DRIVER_PACKAGE}'. Установите пакет (npm i ${POSTGRES_DRIVER_PACKAGE} pg) ` +
        `или выберите другой backend ('file'/'memory').`,
      { cause: err },
    );
  }

  if (!mod || typeof mod.createPostgresStorage !== 'function') {
    throw new StorageBackendUnavailableError(
      `storage.backend='postgres': драйвер '${POSTGRES_DRIVER_PACKAGE}' ` +
        `не экспортирует createPostgresStorage().`,
    );
  }

  // Маппинг «плоской» resolved-формы (dsn/host/…) в контракт драйвера
  // (`connectionString` / `pool`): пароль — только из env/файла (инвариант 13).
  const pg = config.postgres;
  const pool: NonNullable<PostgresStorageDriverConfig['pool']> = {};
  if (pg?.host) pool.host = pg.host;
  if (pg?.port !== undefined) pool.port = pg.port;
  if (pg?.user) pool.user = pg.user;
  if (pg?.database) pool.database = pg.database;
  if (pg?.poolMax !== undefined) pool.max = pg.poolMax;
  const sslmode = pg?.sslmode !== undefined ? normalizePostgresSslMode(pg.sslmode) : undefined;
  if (sslmode !== undefined) pool.sslmode = sslmode;
  if (pg?.ssl !== undefined) pool.ssl = pg.ssl;
  if (config.postgresPassword) pool.password = config.postgresPassword;

  const driverConfig: PostgresStorageDriverConfig = {
    dataDir: config.dataDir,
    ...(pg?.dsn ? { connectionString: pg.dsn } : {}),
    ...(Object.keys(pool).length > 0 ? { pool } : {}),
    ...(pg?.schema ? { schema: pg.schema } : {}),
    // ADR-099: единый источник доверия TLS (CA/mTLS) — прокидка в драйвер.
    ...(config.security?.tls ? { tls: config.security.tls } : {}),
    ...(config.tlsRuntime ? { tlsRuntime: config.tlsRuntime } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.postgresPassword ? { password: config.postgresPassword } : {}),
    ...(config.postgresSchemaMode ? { schemaMode: config.postgresSchemaMode } : {}),
    // ADR-097: core собирает sync-данные портов (ассеты/реестры) сам и
    // инъектирует их драйверу — тот не обходит `exports`-карту core.
    coreSync: buildPostgresCoreSyncDeps(mod, config),
  };
  return mod.createPostgresStorage(driverConfig);
}

/**
 * ADR-097: собрать синхронные данные core для драйвера (инъекция).
 *
 * Sync-геттеры портов драйвера (`secretPatterns`/`protectedPaths`/`dictionaries`)
 * работают на горячем пути и не могут ждать I/O: core отдаёт готовые значения
 * (дефолтные паттерны детекции, системный base защищённых путей, системный
 * источник словарей) вместо обхода `exports`-карты со стороны драйвера.
 */
function buildPostgresCoreSyncDeps(
  mod: PostgresStorageDriverModule,
  config: StorageContextConfig,
): PostgresCoreSyncDeps {
  const emptyUserDictionariesSubdir =
    mod.POSTGRES_EMPTY_USER_DICTIONARIES_SUBDIR ?? 'storage-postgres/no-user-dictionaries';
  return {
    secretPatterns: DEFAULT_PATTERNS.map((pattern) => ({
      type: pattern.type,
      regex: typeof pattern.regex === 'string' ? pattern.regex : pattern.regex.source,
    })),
    protectedPathsBase: loadProtectedPaths({ overridePath: '' }),
    systemDictionaries: new DictionaryStore(
      join(config.dataDir, emptyUserDictionariesSubdir),
      config.systemDictionariesDir,
    ),
  };
}

/**
 * ADR-098 (W5): коды ошибок хранения, при которых файловый фоллбек **запрещён**
 * (fail-closed) — см. матрицу у `createPostgresStorageWithFallback`.
 */
const FAIL_CLOSED_STORAGE_CODES: ReadonlySet<string> = new Set([
  'STORAGE_POSTGRES_CONFIG_INVALID',
  'STORAGE_POSTGRES_DEPENDENCY_MISSING',
  'STORAGE_BACKEND_UNAVAILABLE',
  'STORAGE_POSTGRES_SCHEMA_TOO_NEW',
]);

/** Классы ошибок хранения, при которых фоллбек запрещён (страховка по `name`). */
const FAIL_CLOSED_STORAGE_NAMES: ReadonlySet<string> = new Set([
  'PostgresStorageConfigError',
  'PostgresStorageDependencyError',
  'StorageBackendUnavailableError',
]);

/** Код ошибки «схема БД отстаёт от драйвера» (лечится `synth migrate`). */
const SCHEMA_OUTDATED_CODE = 'STORAGE_POSTGRES_SCHEMA_OUTDATED';

function storageErrorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Ошибка конфигурации/зависимости/«схема новее» — фоллбек на пустой файл запрещён. */
function isFailClosedStorageError(err: unknown): boolean {
  const code = storageErrorCodeOf(err);
  if (code !== undefined && FAIL_CLOSED_STORAGE_CODES.has(code)) return true;
  const name = err instanceof Error ? err.name : undefined;
  return name !== undefined && FAIL_CLOSED_STORAGE_NAMES.has(name);
}

/** Схема БД отстаёт от драйвера (`STORAGE_POSTGRES_SCHEMA_OUTDATED`). */
function isSchemaOutdatedError(err: unknown): boolean {
  return storageErrorCodeOf(err) === SCHEMA_OUTDATED_CODE;
}

/**
 * ADR-098 (W5): политика при недоступности backend'а (`storage.degradedMode`).
 * `fallback-file` (default) — подняться на файловом фоллбеке в `fallbackDir`
 * (отдельный каталог!), `halt` — остановить старт с внятной ошибкой.
 *
 * ── Матрица «тип ошибки → поведение» ─────────────────────────────────────────
 *
 * **fail-closed** (старт остановлен, `StorageUnavailableError`, `degradedMode` не
 * применяется): файловый фоллбек запрещён, т.к. он маскировал бы проблему
 * развёртывания пустым хранилищем — администратор видел бы «все данные исчезли»
 * вместо внятной ошибки.
 *
 *   | Тип ошибки (класс / код)                                  | Почему fail-closed |
 *   |-----------------------------------------------------------|--------------------|
 *   | `PostgresStorageConfigError` (`…CONFIG_INVALID`)          | неверный конфиг/креды/схема — опечатка, а не отказ БД |
 *   | `PostgresStorageDependencyError` (`…DEPENDENCY_MISSING`)  | нет модуля `pg` — проблема развёртывания, не отказ БД |
 *   | `StorageBackendUnavailableError` (`…BACKEND_UNAVAILABLE`) | не загрузился пакет-драйвер — то же |
 *   | `PostgresStorageSchemaError` `…SCHEMA_TOO_NEW`            | БД новее драйвера (откат версии) — нельзя молча стартовать на пустом фоллбеке |
 *
 * **деградация** (фоллбек при `fallback-file`, ошибка при `halt`) — это **отказ БД**:
 *
 *   | Тип ошибки (класс / код)                                  | Почему деградация |
 *   |-----------------------------------------------------------|-------------------|
 *   | `PostgresConnectionError` (сеть/класс `08`/`57P0x`)       | БД недоступна по сети — штатный сценарий фоллбека |
 *   | auth-ошибка сервера (`28P01`/`28000`/`42501` → `QueryError`) | сервер ответил «доступ запрещён» — отказ БД, не конфиг |
 *   | `PostgresStorageSchemaError` `…SCHEMA_OUTDATED`           | схема отстаёт — данные в БД есть, лечится `synth migrate` (подсказка в причине) |
 *   | прочие runtime-ошибки (`QueryError`/`LockTimeoutError`)   | сбой выполнения в БД; доступ к read-only диагностике нужнее простоя |
 */
async function createPostgresStorageWithFallback(
  config: StorageContextConfig,
): Promise<StorageContext> {
  try {
    return await createPostgresStorage(config);
  } catch (err) {
    const rawReason = err instanceof Error ? err.message : String(err);

    // Fail-closed: конфиг/зависимость/схема новее — фоллбек не применяется.
    if (isFailClosedStorageError(err)) {
      console.error(
        '[storage] ✗ fail-closed: конфигурация/зависимость/схема хранилища неисправна — ' +
          'файловый фоллбек запрещён (storage.degradedMode не применяется)',
      );
      console.error(`[storage]   причина: ${rawReason}`);
      throw new StorageUnavailableError(
        `Не удалось собрать PostgreSQL-хранилище (storage.backend='postgres'): ` +
          `ошибка конфигурации/зависимости/схемы — старт остановлен (fail-closed), ` +
          `файловый фоллбек не применяется независимо от storage.degradedMode. ` +
          `Проверьте способ подключения/креды, установите драйвер (\`pg\`) либо выровняйте ` +
          `схему БД, затем перезапустите. Причина: ${rawReason}`,
        { cause: err },
      );
    }

    const mode = config.degradedMode ?? 'fallback-file';
    const reason = isSchemaOutdatedError(err)
      ? `${rawReason} — подсказка: примените миграции схемы (synth migrate) и перезапустите сервис.`
      : rawReason;

    if (mode === 'halt') {
      throw new StorageUnavailableError(
        `Не удалось подключиться к PostgreSQL (storage.backend='postgres'), ` +
          `а storage.degradedMode='halt' запрещает файловый фоллбек — старт остановлен. ` +
          `Проверьте доступность БД/сеть/креды и схему (synth doctor), затем перезапустите. ` +
          `Причина: ${reason}`,
        { cause: err },
      );
    }

    const fallbackDir =
      config.fallbackDir && config.fallbackDir !== ''
        ? config.fallbackDir
        : join(config.dataDir, 'fallback');

    // Громкое предупреждение (ADR-098 W5): сервис поднимается в аварийном read-only.
    console.error('[storage] ⚠️  PostgreSQL недоступен — переход в ДЕГРАДИРОВАННЫЙ режим (fallback-file)');
    console.error(`[storage]   причина: ${reason}`);
    console.error(`[storage]   файловый фоллбек: ${fallbackDir}`);
    console.error('[storage]   режим строгого read-only: мутации отклоняются (503 STORAGE_DEGRADED_READONLY);');
    console.error('[storage]   доступ — только администраторам; для возврата к БД восстановите соединение и перезапустите сервис.');

    // Файловое хранилище в отдельном каталоге-фоллбеке (не dataDir!) — чтобы не
    // смешивать с реальными данными (split-brain).
    const fallback = createFileStorage({ ...config, dataDir: fallbackDir });
    const since = new Date().toISOString();
    return {
      ...fallback,
      degraded: {
        active: true,
        backend: 'postgres',
        fallbackDir,
        reason,
        since,
        probe: () => probePostgresBackend(config),
      },
    };
  }
}

/** ADR-098 (W5): пробное подключение к исходному postgres-backend'у (диагностика). */
async function probePostgresBackend(config: StorageContextConfig): Promise<StorageBackendProbe> {
  try {
    const ctx = await createPostgresStorage({ ...config, postgresSchemaMode: 'skip' });
    try {
      const health = ctx.health ? await ctx.health() : { ok: true };
      return { ok: health.ok, latencyMs: health.latencyMs, error: health.error };
    } finally {
      await ctx.close?.();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ADR-096: единый **асинхронный** каскад сборки слоя хранения. `file`/`memory` —
 * существующие синхронные фабрики, `postgres` — динамическая загрузка драйвера.
 * Именно эту функцию должен вызывать домен (composition root).
 *
 * ADR-098 (W5): при недоступности `postgres` применяется `storage.degradedMode`
 * (`fallback-file` → файловый фоллбек в `fallbackDir`, `halt` → ошибка старта).
 * Диагностический режим `postgresSchemaMode: 'skip'` (doctor/CLI-миграции) политику
 * деградации не применяет — ошибка подключения пробрасывается наверх, а
 * runtime-состояние деградации не трогается.
 *
 * При сборке **основного** контекста публикует состояние деградации в ось
 * доступности тулов (`setStorageDegradedState`).
 */
export async function createStorageContextAsync(
  kind: StorageBackendKind,
  config: StorageContextConfig,
): Promise<StorageContext> {
  // ADR-099: bootstrap-настройки TLS читаются **до** подключения к PostgreSQL
  // (настройки доверия нужны самому подключению). Явно переданные — приоритетнее.
  if (kind === 'postgres' && config.tlsRuntime === undefined) {
    const runtime = readTlsRuntimeSettings(config.dataDir);
    if (runtime) config = { ...config, tlsRuntime: runtime };
  }
  if (kind === 'postgres' && config.postgresSchemaMode === 'skip') {
    // Диагностика (`synth doctor`, управление миграциями): ошибку не маскируем.
    return createPostgresStorage(config);
  }

  const context = await createStorageContextWithDegradation(kind, config);
  setStorageDegradedState(
    context.degraded
      ? { degraded: true, fallbackDir: context.degraded.fallbackDir, reason: context.degraded.reason }
      : null,
  );
  return context;
}

/** Сборка контекста по backend'у с применением политики деградации (postgres). */
async function createStorageContextWithDegradation(
  kind: StorageBackendKind,
  config: StorageContextConfig,
): Promise<StorageContext> {
  switch (kind) {
    case 'memory':
      return createMemoryStorage(config);
    case 'file':
      return createFileStorage(config);
    case 'postgres':
      return createPostgresStorageWithFallback(config);
    default:
      // Fail-closed: невалидный `storage.backend` не уводится на файловый backend.
      throw new StorageUnavailableError(
        `storage.backend="${String(kind)}" не поддерживается — ожидается 'file' | 'memory' | 'postgres'.`,
      );
  }
}

/** Опции `buildStorageContext` — сборка слоя из конфига инстанса (CLI/backend). */
export interface BuildStorageContextOptions {
  dataDir: string;
  /** Полный конфиг инстанса (источник `storage.*`). */
  config: SynthConfig;
  env?: NodeJS.ProcessEnv;
  /** ADR-079: home-каталог (для резолва `{dataDir}`/фоллбека). */
  home?: string | null;
  /** ADR-076: мастер-ключ (иначе резолвится из config/env). */
  secretKey?: string;
  dedupStore?: 'memory' | 'file';
  scheduleCrossProcess?: boolean;
  systemPromptsDir?: string;
  bundlesPath?: string;
  contextUserDataDir?: string;
  systemDictionariesDir?: string;
  /** ADR-097: режим работы со схемой БД при сборке (`postgres`). */
  postgresSchemaMode?: PostgresSchemaMode;
  /**
   * PROP-090 §5: путь к lock-файлу плагинов (`plugins.lock.json`). Задаёт
   * composition root — при home-модели это `<home>/plugin/plugins.lock.json`
   * (иначе порт смотрел бы в `{dataDir}/plugin/…`, и CLI с `--home` разошёлся
   * бы с сервером).
   */
  pluginLockPath?: string;
}

/**
 * ADR-096: собрать слой хранения из конфига инстанса — resolved backend +
 * параметры PG + пароль (env/файл) + задел деградации. Общий хелпер для мест без
 * `StandaloneConfig` (CLI-команды, `chat.ts`, maintenance), чтобы не дублировать
 * резолвинг. Домен должен предпочитать этот хелпер / `createStorageContextAsync`.
 */
export async function buildStorageContext(
  opts: BuildStorageContextOptions,
): Promise<StorageContext> {
  const env = opts.env ?? process.env;
  const kind = resolveStorageBackend(opts.config, env);
  const storage = await createStorageContextAsync(kind, {
    dataDir: opts.dataDir,
    secretKey: opts.secretKey ?? resolveSecretKey(opts.config, env),
    env,
    postgres: resolvePostgresConfig(opts.config, env),
    postgresPassword: resolvePostgresPassword({ dataDir: opts.dataDir }, env),
    // ADR-099: единый источник доверия TLS (CA/mTLS) для `sslmode=verify-full`.
    ...(opts.config.security?.tls ? { security: { tls: opts.config.security.tls } } : {}),
    // ADR-099: bootstrap-настройки читаются до подключения к PostgreSQL.
    ...(() => {
      const runtime = readTlsRuntimeSettings(opts.dataDir);
      return runtime ? { tlsRuntime: runtime } : {};
    })(),
    ...(opts.postgresSchemaMode ? { postgresSchemaMode: opts.postgresSchemaMode } : {}),
    degradedMode: resolveDegradedMode(opts.config),
    fallbackDir: resolveStorageFallbackDir(opts.config, env, opts.home ?? null),
    dedupStore: opts.dedupStore,
    scheduleCrossProcess: opts.scheduleCrossProcess,
    systemPromptsDir: opts.systemPromptsDir,
    bundlesPath: opts.bundlesPath,
    contextUserDataDir: opts.contextUserDataDir,
    systemDictionariesDir: opts.systemDictionariesDir,
    ...(opts.pluginLockPath ? { pluginLockPath: opts.pluginLockPath } : {}),
  });
  // ADR-099: CLI/обслуживание — после создания storage применяем прокси
  // (config ← runtime) до дальнейших исходящих запросов. В серверных точках
  // (`createStandaloneApp`/`createBackendStorage`) тот же шаг выполняется явно.
  await applyStartupProxyConfig(
    storage.settings,
    { proxy: opts.config.proxy },
    env,
    { dataDir: opts.dataDir },
  );
  return storage;
}
