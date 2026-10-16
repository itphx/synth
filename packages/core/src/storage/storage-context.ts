/**
 * StorageContext — единая точка сборки слоя хранения (PROP-032, шаг W2.3).
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
import type { AgentDefinition, ModelConfig, PostgresStorageConfig, ProviderConfig, SynthConfig } from '@itphx/synth-shared';
import {
  resolveDegradedMode,
  resolvePostgresConfig,
  resolvePostgresPassword,
  resolveSecretKey,
  resolveStorageBackend,
  resolveStorageFallbackDir,
} from '@itphx/synth-shared';
import type {
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
  IdentityClaimRepository,
  JobRepository,
  MaintenanceAuditRepository,
  McpRegistryRepository,
  ProfileRepository,
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
import { ProtectedPathsStore } from '../engine/security/protected-paths-store.js';
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
import { FileDedupStore, MemoryDedupStore } from '../engine/events/dedup-store.js';
import { SkillStore } from './skill-store.js';
import { SkillBundleStore } from './skill-bundle-store.js';
import { ContextConfig } from '../engine/context/config.js';
import { SSHKeyStore } from './ssh-key-store.js';
import { FileBlobStore } from './file-blob-store.js';

// ── In-memory реализации ───────────────────────────────────────────────
import {
  MemoryBlobStore,
  MemoryContextFileRepository,
  MemoryDefaultsRepository,
  MemoryDictionaryRepository,
  MemoryDocumentRepository,
  MemoryEventApiKeyRepository,
  MemoryEventBindingRepository,
  MemoryEventJournalRepository,
  MemoryEventRouteRepository,
  MemoryIdentityClaimRepository,
  MemoryJobRepository,
  MemoryMaintenanceAuditRepository,
  MemoryMcpRegistryRepository,
  MemoryProfileRepository,
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
 * Собранный слой хранения: домен получает порты (а не конкретные классы).
 * Поле `kind` — какой backend собран (для диагностики/предупреждений).
 */
export interface StorageContext {
  kind: StorageBackendKind;
  /**
   * PROP-032: освобождение ресурсов backend'а (пул соединений и т.п.).
   * Опционально: `file`/`memory` его не задают (ресурсов процесса нет), драйвер
   * БД удерживает соединение в контексте и закрывает его здесь. Домен зовёт
   * `close()` на graceful shutdown (`synth serve`).
   */
  close?(): Promise<void>;
  sessions: SessionRepository;
  projects: ProjectRepository;
  profiles: ProfileRepository;
  settings: SettingsRepository;
  defaults: DefaultsRepository;
  secretPatterns: SecretPatternRepository;
  protectedPaths: ProtectedPathsRepository;
  dictionaries: DictionaryRepository;
  /** Конфигурационные словари (PROP-032, W2.4): `providers`/`models`/`agents`. */
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
  dedup: DedupRepository;
  skills: SkillRepository;
  skillBundles: SkillBundleRepository;
  contextFiles: ContextFileRepository;
  sshKeys: SSHKeyRepository;
  blobs: BlobStore;
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
   * PROP-032: параметры PostgreSQL (используются при `kind: 'postgres'`); пароль
   * сюда НЕ входит — отдельное поле `postgresPassword` (инвариант 13).
   */
  postgres?: PostgresStorageConfig;
  /** PROP-032: пароль PostgreSQL (env/файл, не config.yaml). */
  postgresPassword?: string;
  /** PROP-032 (задел W5): политика при недоступности backend. */
  degradedMode?: 'fallback-file' | 'halt';
  /** PROP-032 (задел W5): каталог файлового фоллбека при деградации. */
  fallbackDir?: string;
}

/**
 * PROP-032/ADR-078: выбранный внешний backend недоступен (нет пакета-драйвера
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
 * Конфиг, передаваемый драйверу `@itphx/synth-storage-postgres` — форма драйвера
 * (ADR-097/PROP-032): `connectionString` либо `pool.{host, database}`. Резолвер
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
    /** Требовать TLS (`storage.postgres.ssl`). */
    ssl?: boolean;
  };
  /** Схема БД (namespace таблиц). */
  schema?: string;
  /** Пароль БД (инвариант 13: не из config.yaml; env/файл). */
  password?: string;
}

/** Локальный тип фабрики драйвера (пакет опционален и не резолвится на этапе типов). */
interface PostgresStorageDriverModule {
  createPostgresStorage(config: PostgresStorageDriverConfig): Promise<StorageContext>;
}

/**
 * PROP-032: имя пакета-драйвера. Аннотация `string` намеренная — путь не должен
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
    // PROP-032 (W2.4): провайдеры/модели/агенты — «ключ → JSON-документ».
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
    blobs: new FileBlobStore({ root: dataDir }),
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
    dedup: new MemoryDedupRepository(),
    skills: new MemorySkillRepository(),
    skillBundles: new MemorySkillBundleRepository(),
    contextFiles: new MemoryContextFileRepository(),
    sshKeys: new MemorySSHKeyRepository(),
    blobs: new MemoryBlobStore(),
  };
}

/**
 * PROP-032: диспетчер backend'а по `storage.backend`. Синхронный — только для
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
  if (kind === 'postgres') {
    throw new StorageBackendUnavailableError(
      "createStorageContext('postgres', …) синхронно недоступен — используйте createStorageContextAsync().",
    );
  }
  return createFileStorage(config);
}

/**
 * PROP-032: сборка PostgreSQL-backend через динамический `import()` опционального
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
  if (pg?.ssl !== undefined) pool.ssl = pg.ssl;
  if (config.postgresPassword) pool.password = config.postgresPassword;

  const driverConfig: PostgresStorageDriverConfig = {
    dataDir: config.dataDir,
    ...(pg?.dsn ? { connectionString: pg.dsn } : {}),
    ...(Object.keys(pool).length > 0 ? { pool } : {}),
    ...(pg?.schema ? { schema: pg.schema } : {}),
    ...(config.postgresPassword ? { password: config.postgresPassword } : {}),
  };
  return mod.createPostgresStorage(driverConfig);
}

/**
 * PROP-032: единый **асинхронный** каскад сборки слоя хранения. `file`/`memory` —
 * существующие синхронные фабрики, `postgres` — динамическая загрузка драйвера.
 * Именно эту функцию должен вызывать домен (composition root).
 */
export async function createStorageContextAsync(
  kind: StorageBackendKind,
  config: StorageContextConfig,
): Promise<StorageContext> {
  switch (kind) {
    case 'memory':
      return createMemoryStorage(config);
    case 'postgres':
      return createPostgresStorage(config);
    default:
      return createFileStorage(config);
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
}

/**
 * PROP-032: собрать слой хранения из конфига инстанса — resolved backend +
 * параметры PG + пароль (env/файл) + задел деградации. Общий хелпер для мест без
 * `StandaloneConfig` (CLI-команды, `chat.ts`, maintenance), чтобы не дублировать
 * резолвинг. Домен должен предпочитать этот хелпер / `createStorageContextAsync`.
 */
export async function buildStorageContext(
  opts: BuildStorageContextOptions,
): Promise<StorageContext> {
  const env = opts.env ?? process.env;
  const kind = resolveStorageBackend(opts.config, env);
  return createStorageContextAsync(kind, {
    dataDir: opts.dataDir,
    secretKey: opts.secretKey ?? resolveSecretKey(opts.config, env),
    env,
    postgres: resolvePostgresConfig(opts.config, env),
    postgresPassword: resolvePostgresPassword({ dataDir: opts.dataDir }, env),
    degradedMode: resolveDegradedMode(opts.config),
    fallbackDir: resolveStorageFallbackDir(opts.config, env, opts.home ?? null),
    dedupStore: opts.dedupStore,
    scheduleCrossProcess: opts.scheduleCrossProcess,
    systemPromptsDir: opts.systemPromptsDir,
    bundlesPath: opts.bundlesPath,
    contextUserDataDir: opts.contextUserDataDir,
    systemDictionariesDir: opts.systemDictionariesDir,
  });
}
