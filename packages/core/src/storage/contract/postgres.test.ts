import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, vi } from 'vitest';
import type { ProviderConfig } from '@itphx/synth-shared';

// Схема создаётся + применяются миграции на каждый `make()` под параллельной
// нагрузкой — первый тест может не уложиться в дефолтные 5 c.
vi.setConfig({ testTimeout: 30000 });

import {
  createTmpDir,
  describeAnalyticsRollupRepository,
  describeBlobStore,
  describeContextFileRepository,
  describeDefaultsRepository,
  describeDedupRepository,
  describeDictionaryRepository,
  describeDocumentRepository,
  describeEventApiKeyRepository,
  describeEventBindingRepository,
  describeEventJournalRepository,
  describeEventRouteRepository,
  describeIdentityClaimRepository,
  describeJobRepository,
  describeMaintenanceAuditRepository,
  describePluginAuditRepository,
  describePluginLockRepository,
  describeSecurityAuditRepository,
  describeEgressRequestLogRepository,
  describeExternalCredentialRepository,
  describeMcpRegistryRepository,
  describePackRepository,
  describePipelineRepository,
  describePipelineRunRepository,
  describeProfileRepository,
  describeProjectPipelineRepository,
  describeProjectRepository,
  describeProtectedPathsRepository,
  describeScheduleRepository,
  describeSecretPatternRepository,
  describeServiceKeyRepository,
  describeSessionRepository,
  describeSettingsRepository,
  describeSkillBundleRepository,
  describeSkillRepository,
  describeSSHKeyRepository,
  describeWebhookDeliveryRepository,
  describeWebhookRepository,
} from './index.js';
import type { StorageContext } from '../storage-context.js';

/**
 * Контрактный прогон доменных портов на PostgreSQL-драйвере
 * (ADR-097, волна 3b-lifecycle) — рядом с `file.test.ts`/`memory.test.ts`.
 *
 * Гейт по env `SYNTH_TEST_POSTGRES_DSN`: без него весь файл `describe.skip`
 * (герметичный запуск без БД). С DSN каждый `make()` создаёт **уникальную схему**
 * (`synth_test_<random>`) и уникальный временный `dataDir` (для FS/package-bound
 * портов), прогоняет миграции и собирает `StorageContext` драйвера
 * (`createPostgresStorage`). Контрактный suite `dispose` не вызывает, поэтому
 * освобождение ресурсов делает `afterEach`: `ctx.close()` (пул соединений) +
 * `DROP SCHEMA … CASCADE` + удаление tmp-каталога.
 *
 * Драйвер тянется **динамическим** `import()` по строке-константе (как
 * `storage-context.ts` в core): `@itphx/synth-storage-postgres` — опциональная
 * зависимость, статический импорт сломал бы typecheck core без собранного драйвера.
 *
 * Все 27 доменных портов реализованы (волна 3b): контрактные блоки проходят
 * против живой БД; FS/package-bound порты (`skills`/`contextFiles`/`blobs`) —
 * файловые реализации внутри драйвера.
 */

const DSN = process.env.SYNTH_TEST_POSTGRES_DSN;
const describePg = DSN ? describe : describe.skip;

/** Аннотация `string` намеренная — `import()` не резолвится на этапе типов (опциональный пакет). */
const POSTGRES_DRIVER_PACKAGE: string = '@itphx/synth-storage-postgres';

/**
 * Прогрев драйвера на уровне модуля (только при живом DSN — без него весь
 * файл пропускается): `loadDriver()` ниже вызывается из тестов, и без
 * прогрева загрузка модуля ложится на бюджет первого теста контракта
 * (под нагрузкой — десятки секунд вместо миллисекунд). Top-level await не
 * подчиняется `testTimeout`/`hookTimeout`. `.catch()` обязателен: драйвер
 * опционален, его отсутствие не должно ронять файл (код под тестом
 * классифицирует это как ошибку зависимости — fail-closed).
 */
if (DSN) {
  await import(POSTGRES_DRIVER_PACKAGE).catch(() => undefined);
}

/** Минимальный локальный контракт драйвера (типы пакета не резолвятся статически). */
interface PostgresDriverModule {
  createPostgresStorage(config: Record<string, unknown>): Promise<StorageContext>;
  /** Отдельное соединение — для `DROP SCHEMA … CASCADE` при очистке. */
  createPostgresConnection(config: Record<string, unknown>): { dropSchema(schema?: string): Promise<void> };
}

let driverPromise: Promise<PostgresDriverModule> | null = null;

async function loadDriver(): Promise<PostgresDriverModule> {
  if (!driverPromise) {
    driverPromise = import(POSTGRES_DRIVER_PACKAGE) as unknown as Promise<PostgresDriverModule>;
  }
  return driverPromise;
}

/** Уникальная схема прогона (каждый `make()` — независимое состояние). */
function uniqueSchema(): string {
  return `synth_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// Контрактный suite не вызывает `dispose` — освобождаем ресурсы в `afterEach`.
let activeDisposers: Array<() => Promise<void>> = [];

async function makeContext(): Promise<{ ctx: StorageContext; dispose: () => Promise<void> }> {
  const driver = await loadDriver();
  const schema = uniqueSchema();
  const { dir, dispose: disposeDir } = await createTmpDir('synth-pg-contract-');

  let ctx: StorageContext;
  try {
    ctx = await driver.createPostgresStorage({
      dataDir: dir,
      connectionString: DSN,
      schema,
    });
  } catch (err) {
    await disposeDir().catch(() => undefined);
    throw err;
  }

  const dispose = async (): Promise<void> => {
    const close = ctx.close;
    if (close) await close().catch(() => undefined);
    await driver
      .createPostgresConnection({ connectionString: DSN, schema })
      .dropSchema(schema)
      .catch(() => undefined);
    await disposeDir().catch(() => undefined);
  };

  activeDisposers.push(dispose);
  return { ctx, dispose };
}

/** `make()` контракта: уникальный контекст драйвера + один из его портов. */
async function makePort<K extends keyof StorageContext>(
  port: K,
): Promise<{ repo: StorageContext[K]; dispose: () => Promise<void> }> {
  const { ctx, dispose } = await makeContext();
  return { repo: ctx[port], dispose };
}

describePg('контрактные тесты PostgreSQL-драйвера (уникальная схема + миграции)', () => {
  afterEach(async () => {
    const pending = activeDisposers;
    activeDisposers = [];
    await Promise.allSettled(pending.map((d) => d()));
  });

  afterAll(async () => {
    const pending = activeDisposers;
    activeDisposers = [];
    await Promise.allSettled(pending.map((d) => d()));
  });

  describeSessionRepository('PG → SessionRepository', () => makePort('sessions'));
  describeProjectRepository('PG → ProjectRepository', () => makePort('projects'));
  describeProfileRepository('PG → ProfileRepository', () => makePort('profiles'));
  describeSettingsRepository('PG → SettingsRepository', () => makePort('settings'));

  describeEventBindingRepository('PG → EventBindingRepository', () => makePort('eventBindings'));
  describeEventRouteRepository('PG → EventRouteRepository', () => makePort('eventRoutes'));
  describeEventJournalRepository('PG → EventJournalRepository', () => makePort('eventJournal'));
  describeEventApiKeyRepository('PG → EventApiKeyRepository', () => makePort('eventApiKeys'));
  describeIdentityClaimRepository('PG → IdentityClaimRepository', () => makePort('identityClaims'));
  describeDedupRepository('PG → DedupRepository', () => makePort('dedup'));

  describeScheduleRepository('PG → ScheduleRepository', () => makePort('schedules'));
  describeJobRepository('PG → JobRepository', () => makePort('jobs'));
  describeMaintenanceAuditRepository('PG → MaintenanceAuditRepository', () => makePort('maintenanceAudit'));
  // PROP-090 §9: журнал аудита плагинов (отдельный порт, не security-аудит).
  describePluginAuditRepository('PG → PluginAuditRepository', () => makePort('pluginAudit'));
  // PROP-068 §4.4 / PROP-090 §5: lock-файл плагинов.
  describePluginLockRepository('PG → PluginLockRepository', () => makePort('pluginLock'));
  describeSecurityAuditRepository('PG → SecurityAuditRepository', () => makePort('securityAudit'));
  describeEgressRequestLogRepository('PG → EgressRequestLogRepository', () => makePort('egressRequests'));
  describeAnalyticsRollupRepository('PG → AnalyticsRollupRepository', () => makePort('analyticsRollups'));

  describeServiceKeyRepository('PG → ServiceKeyRepository', () => makePort('serviceKeys'));
  describeSSHKeyRepository('PG → SSHKeyRepository', () => makePort('sshKeys'));
  describeWebhookRepository('PG → WebhookRepository', () => makePort('webhooks'));
  describeWebhookDeliveryRepository('PG → WebhookDeliveryRepository', () => makePort('webhookDeliveries'));

  describeMcpRegistryRepository('PG → McpRegistryRepository', () => makePort('mcpRegistry'));
  describeSkillRepository('PG → SkillRepository (file-backed)', () => makePort('skills'));
  describeSkillBundleRepository('PG → SkillBundleRepository', () => makePort('skillBundles'));
  describeDictionaryRepository('PG → DictionaryRepository', () => makePort('dictionaries'));

  // ADR-096 (W2.4): конфигурационные словари (провайдеры/модели/агенты) — один порт-провайдер.
  describeDocumentRepository<ProviderConfig>(
    'PG → DocumentRepository (providers)',
    () => makePort('providers'),
    (key) => ({ name: key } as unknown as ProviderConfig),
  );

  describeContextFileRepository('PG → ContextFileRepository (file-backed)', () => makePort('contextFiles'));
  describeSecretPatternRepository('PG → SecretPatternRepository', () => makePort('secretPatterns'));
  describeProtectedPathsRepository('PG → ProtectedPathsRepository', () => makePort('protectedPaths'));

  describeBlobStore('PG → BlobStore (file-backed)', () => makePort('blobs'));
  describeDefaultsRepository('PG → DefaultsRepository', () => makePort('defaults'));

  // ADR-105 (Ф1): внешние доступы к коннекторам (таблица `external_credentials`,
  // миграция 011; шифрование токенов — core-хелперами, мастер-ключ в `{dataDir}`).
  describeExternalCredentialRepository('PG → ExternalCredentialRepository', () =>
    makePort('externalCredentials'),
  );

  // ADR-051/ADR-100 + ADR-086 §5: переходно файловые порты драйвера.
  describePipelineRepository('PG → PipelineRepository (file-backed)', () => makePort('pipelines'));
  describePackRepository('PG → PackRepository (file-backed)', () => makePort('packs'));

  // ADR-101 (Pipeline Engine): спецификации пайплайнов, прогоны и журнал.
  describeProjectPipelineRepository('PG → ProjectPipelineRepository', () =>
    makePort('projectPipelines'),
  );
  describePipelineRunRepository('PG → PipelineRunRepository', async () => {
    const { ctx, dispose } = await makeContext();
    return { repo: ctx.pipelineRuns, pipelines: ctx.projectPipelines, dispose };
  });
});
