/**
 * Сборка `StorageContext` PostgreSQL-драйвера (ADR-097, волна 3b-каркас).
 *
 * Контекст собирается из независимых файлов-групп портов
 * (`src/ports/{sessions,principals,events,content,audit,analytics}.ts`) — по одной
 * фабрике на группу, чтобы волна реализации правила группы параллельно и без
 * конфликтов:
 *   - `buildSessionPorts(deps)`   → `sessions`;
 *   - `buildPrincipalPorts(deps)` → `projects`/`profiles`/`settings`/`defaults`/
 *     `providers`/`models`/`agents`;
 *   - `buildEventPorts(deps)`     → `eventBindings`/`eventRoutes`/`eventApiKeys`/
 *     `eventJournal`/`identityClaims`/`dedup`/`schedules`/`jobs`/`webhooks`/
 *     `webhookDeliveries`;
 *   - `buildContentPorts(deps)`   → `serviceKeys`/`sshKeys`/`mcpRegistry`/
 *     `skillBundles`/`dictionaries`/`secretPatterns`/`protectedPaths`/
 *     `maintenanceAudit`;
 *   - `buildAuditPorts(deps)`     → `securityAudit`/`egressRequests`;
 *   - `buildAnalyticsPorts(deps)` → `analyticsRollups` (ADR-102);
 *   - `buildAuthorityPorts(deps)` → `authorityPolicy`/`authorityDecisions` (ADR-106 Ф0/Ф1);
 *   - `buildExternalCredentialPorts(deps)` → `externalCredentials` (ADR-105 Ф1);
 *   - `buildCredentialAuditPorts(deps)`  → `credentialAudit` (ADR-105 Ф4);
 *   - `buildPipelinePorts(deps)`  → `projectPipelines`/`pipelineRuns` (ADR-101);
 *   - `buildMemoryPorts(deps)`     → `memoryFacts`/`memoryIndexes` (PROP-047 §2.1);
 *   - `buildQuestionPorts(deps)`   → `questions` (этап 1 roadmap 0.13, блок 1.3);
 *   - `buildBackgroundRunPorts(deps)` → `backgroundRuns` (этап 1 roadmap 0.13,
 *     блок 1.2 — фоновые саб-агенты и шелл-процессы);
 *   - `buildWorktreePorts(deps)`   → `worktrees` (ADR-114 — инвентарь
 *     git-worktree'ов; generic-таблица `documents`, `kind='worktree'`).
 *   - `buildBlobRefPorts(deps)`    → `blobRefs` (ADR-115/ADR-116 — учёт ссылок
 *     на объекты blob-хранилища; таблица `blob_refs`).
 *   - `buildPackPorts(deps)`       → `packs` (ADR-086 §5 — реестр установок
 *     пакетов расширений; таблица `pack_installations`).
 *   - `buildLegacyPipelinePorts(deps)` → `pipelines` (ADR-051/ADR-100 — реестр
 *     определений и экземпляров инстанса; таблицы `pipeline_definitions`/
 *     `pipeline_instances`). Не путать с `buildPipelinePorts` (ADR-101).
 *   - `buildSkillPorts(deps, blobs)` → `skills` (ADR-046 §4 / ADR-116 —
 *     метаданные в таблице `instance_skills`, содержимое — в blob-сторе
 *     `skills/<name>/…`).
 *   - `buildContextFilePorts(deps, opts)` → `contextFiles` (ADR-069/ADR-070 /
 *     ADR-116 — пользовательская часть в таблице `context_files`, системные
 *     промпты образа остаются ФС).
 *
 * Все доменные порты реализованы поверх SQL; **`blobs`** остаётся файловым по
 * конструкции (байты вложений/логов/содержимого скиллов — на томе, в БД только
 * `blob_refs`; ADR-091/ADR-092: ФС-периметр вне портов). `packs`, legacy
 * `pipelines`, `skills` и `contextFiles` — **SQL** (ADR-116): таблицы
 * `pack_installations`/`pipeline_definitions`/`pipeline_instances` (миграция 025),
 * `instance_skills` (миграция 026; содержимое скиллов — в blob-сторе) и
 * `context_files` (миграция 027; системные промпты образа остаются ФС).
 *
 * Рантайм-импорт core сужен до трёх точечных вещей (ADR-116): `FileBlobStore` +
 * `prepareBlobRoot`/`blobRootPath` (blob-порт — файловый по конструкции, корень
 * `{dataDir}/blobs`) и `ContextConfig` (системные промпты образа — его резолвер;
 * пользовательская часть контекста в SQL). Файловый контекст
 * (`createFileStorage`) драйвер **не собирает**. Для портов БД core по-прежнему
 * не тянется: порты подключаются динамическим `import()` из core по
 * `storage.backend`.
 */

import { join } from 'node:path';
// ADR-116: точечный рантайм-импорт core — blob-порт (файловый по конструкции) и
// `ContextConfig` как источник каталога системных промптов образа.
import { blobRootPath, ContextConfig, FileBlobStore, prepareBlobRoot } from '@itphx/synth-core';
import type {
  StorageContext,
  StorageHealth,
  StorageSchemaMigrationResult,
} from '@itphx/synth-core';
import type { PostgresConnection } from './pool.js';
import { latestSchemaVersion, MIGRATIONS } from './migrations/index.js';
import { planMigrations, readSchemaVersion, runMigrations } from './migrate.js';
import { buildContentPorts } from './ports/content.js';
import { buildAuditPorts } from './ports/audit.js';
import { buildAnalyticsPorts } from './ports/analytics.js';
import { buildAuthorityPorts } from './ports/authority.js';
import { buildExternalCredentialPorts } from './ports/external-credentials.js';
import { buildCredentialAuditPorts } from './ports/credential-audit.js';
import { buildMemoryPorts } from './ports/memory.js';
import type { CoreSyncDeps, PortDeps } from './ports/deps.js';
import { buildEventPorts } from './ports/events.js';
import { buildPipelinePorts } from './ports/pipelines.js';
// ADR-116: реестр установок пакетов (ADR-086 §5) и legacy-пайплайны
// (ADR-051/ADR-100) переведены в SQL (миграция `025_packs_pipelines`).
import { buildPackPorts } from './ports/packs.js';
import { buildLegacyPipelinePorts } from './ports/legacy-pipelines.js';
// ADR-116: instance-скиллы — метаданные в SQL (`instance_skills`, миграция 026),
// содержимое — в blob-сторе (`skills/<name>/…`).
import { buildSkillPorts } from './ports/skills.js';
// ADR-116: файлы контекста — пользовательская часть в SQL (`context_files`,
// миграция 027), системные промпты образа остаются ФС.
import { buildContextFilePorts } from './ports/context-files.js';
import { buildQuestionPorts } from './ports/questions.js';
import { buildBackgroundRunPorts } from './ports/background-runs.js';
import { buildWorktreePorts } from './ports/worktrees.js';
// ADR-115/ADR-116: учёт ссылок на объекты blob-хранилища (таблица `blob_refs`).
import { buildBlobRefPorts } from './ports/blob-refs.js';
import { buildPluginLockPorts } from './ports/plugin-lock.js';
import { buildPrincipalPorts } from './ports/principals.js';
import { buildSessionPorts } from './ports/sessions.js';
import { createPostgresLocks } from './locks.js';

/** Опции сборки контекста PostgreSQL. */
export interface BuildPostgresContextOptions {
  dataDir: string;
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Каталог системных словарей (пробрасывается группе `content`). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (композиция `contextFiles`: системные промпты — ФС образа). */
  contextUserDataDir?: string;
  /**
   * ADR-097: живое соединение драйвера — удерживается в контексте, порты БД
   * ходят через него; `close()` контекста закрывает пул.
   */
  connection: PostgresConnection;
  /** ADR-097: синхронные данные/хелперы core (см. `CoreSyncDeps`). */
  coreSync: CoreSyncDeps;
}

/** Собрать `StorageContext`: доменные порты (SQL) + blob-стор (ФС) + `close`. */
export function buildPostgresStorageContext(opts: BuildPostgresContextOptions): StorageContext {
  // ADR-116: blob-стор остаётся файловым по конструкции, поэтому создаётся
  // точечно (а не сборкой всего файлового контекста) с тем же корнем, что у
  // файлового backend'а — `{dataDir}/blobs`. `prepareBlobRoot` идемпотентно
  // создаёт каталог и переносит логи старой раскладки.
  prepareBlobRoot(opts.dataDir);
  const blobs = new FileBlobStore({ root: blobRootPath(opts.dataDir) });

  const background: Promise<unknown>[] = [];

  // ADR-116: пользовательская часть файлов контекста — SQL, системные промпты —
  // ФС. Каталог пользовательских файлов тот же, что у файловой реализации
  // (используется лишь как путь по умолчанию для композиции).
  const contextUserDataDir = opts.contextUserDataDir ?? join(opts.dataDir, 'context');
  // Каталог системных промптов образа резолвит сам `ContextConfig`
  // (`{root}/prompts`, fallback `{root}/dist/prompts`) — берём его у класса,
  // чтобы поведение не разошлось с файловой реализацией; файловый контекст ради
  // этого не нужен.
  const systemPromptsDir = new ContextConfig({ userDataDir: contextUserDataDir }).systemPromptsDir;

  const deps: PortDeps = {
    connection: opts.connection,
    dataDir: opts.dataDir,
    secretKey: opts.secretKey,
    env: opts.env,
    systemDictionariesDir: opts.systemDictionariesDir,
    contextUserDataDir: opts.contextUserDataDir,
    coreSync: opts.coreSync,
    // Фоновые задачи сборки (best-effort прогрев кэшей `content`) — дожидаемся
    // их в `close()` до закрытия пула, иначе warm-запросы падают с «пул недоступен».
    trackBackground: (task) => background.push(task),
  };

  return {
    kind: 'postgres',
    // ADR-097: соединение живёт в контексте; `close()` закрывает пул (graceful
    // shutdown домена). Перед закрытием дожидаемся фоновых задач сборки
    // (best-effort прогрев синхронных кэшей `content`): warm-запросы не должны
    // попадать в уже закрытый пул — иначе диагностика/`backup`/`migrate` видят
    // ложные предупреждения «прогрев порта не удался: пул недоступен».
    close: async () => {
      await Promise.allSettled(background);
      await opts.connection.end();
    },
    // ADR-097/ADR-091: диагностика backend'а — реальный probe БД + версия схемы
    // (read-only, без применения миграций) для `synth doctor`/admin-API.
    health: async (): Promise<StorageHealth> => {
      const started = Date.now();
      try {
        await opts.connection.query('SELECT 1');
        const schemaVersion = await readSchemaVersion(opts.connection, opts.connection.schema);
        return {
          ok: true,
          latencyMs: Date.now() - started,
          schemaVersion,
          expectedSchemaVersion: latestSchemaVersion(MIGRATIONS),
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    // ADR-097/ADR-092: миграции схемы БД — план (`dryRun`) или применение
    // (лок/транзакции берёт `runMigrations`).
    schemaMigrations: async (migrationOpts?: { dryRun?: boolean }): Promise<StorageSchemaMigrationResult> => {
      if (migrationOpts?.dryRun) {
        const plan = await planMigrations(opts.connection, { schema: opts.connection.schema });
        return { ...plan, applied: [] };
      }
      const result = await runMigrations(opts.connection, { schema: opts.connection.schema });
      return {
        current: result.version,
        expected: result.version,
        pending: [],
        applied: result.applied,
      };
    },
    // ADR-097: удаление схемы БД — только по явному `uninstall --purge-db`.
    purgeSchema: () => opts.connection.dropSchema(),
    // ADR-097: примитивы координации БД (advisory-локи) — composition root
    // подставляет их вместо файловых `FileMutex`/`FileLeader`.
    locks: createPostgresLocks(opts.connection),
    ...buildSessionPorts(deps),
    ...buildPrincipalPorts(deps),
    ...buildEventPorts(deps),
    ...buildContentPorts(deps),
    ...buildAuditPorts(deps),
    // ADR-106 (Ф0/Ф1): порты Authority-слоя — политика полномочий инстанса
    // (`authority_policy`, миграция 014) и append-only журнал решений
    // (`authority_decisions`).
    ...buildAuthorityPorts(deps),
    // ADR-105 (Ф1): внешние доступы к коннекторам (таблица `external_credentials`,
    // миграция 011). Токены шифруются core-хелперами (ленивый `import()`), в БД
    // лежит готовый `enc:v1:…`; наружу отдаются только метаданные с маской.
    ...buildExternalCredentialPorts(deps),
    // ADR-105 (Ф4): журнал операций со слоем доступов (таблица
    // `credential_audit`, миграция 016). Секретов и id сессий/пользователей
    // в записях нет.
    ...buildCredentialAuditPorts(deps),
    // ADR-102: порт роллапов аналитики — пред-агрегированные суточные бакеты
    // (`analytics_rollups`, миграция 003) с атомарным `ON CONFLICT … DO UPDATE`.
    ...buildAnalyticsPorts(deps),
    // ADR-101: спецификации пайплайнов, прогоны и журнал выполнения
    // (`pipeline_specs`/`pipeline_versions`/`pipeline_runs`/`pipeline_run_events`,
    // миграция 004).
    ...buildPipelinePorts(deps),
    // PROP-047 §2.1 (предпосылка A): порты памяти — факты, индексы и чанки
    // (`memory_facts`/`memory_indexes`/`memory_chunks`, миграция 017). Векторы
    // хранятся в `jsonb` (без `pgvector` — расширение в БД не установлено).
    ...buildMemoryPorts(deps),
    // PROP-068 §4.4 / ADR-090: lock-файл плагинов (таблица `plugin_lock`,
    // миграция 007) — источник истины для update/uninstall.
    ...buildPluginLockPorts(deps),
    // Этап 1 roadmap 0.13: вопросы пользователю (таблица `questions`) и единый
    // реестр фоновых прогонов (таблица `background_runs`) — миграция 021.
    ...buildQuestionPorts(deps),
    ...buildBackgroundRunPorts(deps),
    // ADR-114: инвентарь git-worktree'ов — generic-таблица `documents`
    // (`kind='worktree'`), без новой миграции.
    ...buildWorktreePorts(deps),
    // ADR-115/ADR-116: учёт ссылок на объекты blob-хранилища — таблица
    // `blob_refs` (миграция 024). Байты объектов остаются на томе (`blobs`).
    ...buildBlobRefPorts(deps),
    // ADR-116: blob-стор остаётся файловым по конструкции (байты вложений,
    // логов, содержимого скиллов — на томе; в БД только `blob_refs`).
    blobs,
    // ADR-116: пользовательские файлы контекста/промптов — SQL
    // (`context_files`, миграция 027); системные промпты образа — ФС по пути
    // `ContextConfig.systemPromptsDir` (композиция читает их напрямую, а
    // пользовательские override — из кэша таблицы).
    ...buildContextFilePorts(deps, {
      systemPromptsDir,
      createConfig: (overrides) =>
        new ContextConfig({ userDataDir: contextUserDataDir, systemPromptsDir, overrides }),
    }),
    // ADR-116: instance-скиллы — метаданные в SQL (`instance_skills`,
    // миграция 026), содержимое — в том же blob-сторе (`skills/<name>/…`).
    ...buildSkillPorts(deps, blobs),
    // ADR-116: реестр установок пакетов (ADR-086 §5) и legacy-пайплайны
    // (ADR-051/ADR-100) — SQL-реализации (таблицы `pack_installations` /
    // `pipeline_definitions` / `pipeline_instances`, миграция 025). До ADR-116
    // они были переходно файловыми; контрактный suite проверяет SQL.
    ...buildPackPorts(deps),
    ...buildLegacyPipelinePorts(deps),
  };
}
