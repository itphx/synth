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
 *     блок 1.2 — фоновые саб-агенты и шелл-процессы).
 *
 * Все доменные порты реализованы поверх SQL; FS/package-bound порты (`skills`,
 * `contextFiles`, `blobs`) — **файловые реализации** core (контент скиллов/
 * prompts-ролей и blob-дерево остаются на диске; ADR-091/ADR-092: ФС-периметр
 * вне портов).
 *
 * Осознанное исключение: драйвер в этой части **импортирует core рантаймом**
 * (`createFileStorage`), чтобы переиспользовать уже проверенные файловые
 * реализации, а не дублировать их. Для портов БД core по-прежнему не тянется:
 * порты подключаются динамическим `import()` из core по `storage.backend`.
 */

import { createFileStorage } from '@itphx/synth-core';
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
import { buildQuestionPorts } from './ports/questions.js';
import { buildBackgroundRunPorts } from './ports/background-runs.js';
import { buildPluginLockPorts } from './ports/plugin-lock.js';
import { buildPrincipalPorts } from './ports/principals.js';
import { buildSessionPorts } from './ports/sessions.js';
import { createPostgresLocks } from './locks.js';

/** Опции сборки контекста PostgreSQL. */
export interface BuildPostgresContextOptions {
  dataDir: string;
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
  /** Каталог системных словарей (пробрасывается группе `content`/файловым портам). */
  systemDictionariesDir?: string;
  /** Корень пользовательских промптов/ролей (файловый порт `contextFiles`). */
  contextUserDataDir?: string;
  /**
   * ADR-097: живое соединение драйвера — удерживается в контексте, порты БД
   * ходят через него; `close()` контекста закрывает пул.
   */
  connection: PostgresConnection;
  /** ADR-097: синхронные данные/хелперы core (см. `CoreSyncDeps`). */
  coreSync: CoreSyncDeps;
}

/** Собрать `StorageContext`: четыре группы портов + файловые FS-порты + `close`. */
export function buildPostgresStorageContext(opts: BuildPostgresContextOptions): StorageContext {
  // Файловый контекст переиспользуется только для FS/package-bound портов
  // (`skills`/`contextFiles`/`blobs`); прочие его порты не задействованы.
  const file = createFileStorage({
    dataDir: opts.dataDir,
    secretKey: opts.secretKey,
    env: opts.env,
    systemDictionariesDir: opts.systemDictionariesDir,
    contextUserDataDir: opts.contextUserDataDir,
  });

  const background: Promise<unknown>[] = [];

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
    // FS/package-bound порты: остаются файловыми (см. шапку модуля).
    skills: file.skills,
    contextFiles: file.contextFiles,
    blobs: file.blobs,
    // ADR-051/ADR-100 (пайплайны) и ADR-086 §5 (реестр установок пакетов) —
    // переходно файловые (тот же FS/package-bound класс портов, что и выше):
    // SQL-реализация этих двух портов в драйвере ещё не заведена, домен к ним
    // ещё не подключён (ADR-090 отложен). Контрактный suite проходит и на них
    // (файловая реализация core), поэтому поведение backend'ов совпадает.
    pipelines: file.pipelines,
    packs: file.packs,
  };
}
