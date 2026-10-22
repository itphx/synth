/**
 * Реестр SQL-миграций схемы PostgreSQL-драйвера (ADR-097, волна 3a).
 *
 * Отдельный механизм от `meta.json`/file-миграций (ADR-092): версия схемы БД
 * живёт в таблице `synth_schema_migrations` (см. `migrate.ts`). Миграции
 * применяются строго по возрастанию `version`; `id` — стабильное имя-метка.
 *
 * Добавление миграции: новый модуль `NNN-<name>.ts` с SQL-строкой и запись в
 * массив `MIGRATIONS` (версии уникальны и монотонны).
 */

import { MIGRATION_001_INIT } from './001-init.js';
import { MIGRATION_002_EGRESS_AUDIT } from './002-egress-audit.js';
import { MIGRATION_003_ANALYTICS_ROLLUPS } from './003-analytics-rollups.js';
import { MIGRATION_004_PIPELINE_ENGINE } from './004-pipeline-engine.js';
import { MIGRATION_005_PIPELINE_PROVENANCE } from './005-pipeline-provenance.js';

/** Одна версионированная SQL-миграция. */
export interface PostgresMigration {
  /** Версия (первичный ключ таблицы миграций), строго возрастает. */
  version: number;
  /** Стабильное имя-метка (`001_init`). */
  id: string;
  /** Тело миграции (может содержать несколько SQL-выражений). */
  sql: string;
}

/** Полный набор миграций драйвера (по возрастанию версии). */
export const MIGRATIONS: readonly PostgresMigration[] = [
  { version: 1, id: '001_init', sql: MIGRATION_001_INIT },
  { version: 2, id: '002_egress_audit', sql: MIGRATION_002_EGRESS_AUDIT },
  { version: 3, id: '003_analytics_rollups', sql: MIGRATION_003_ANALYTICS_ROLLUPS },
  { version: 4, id: '004_pipeline_engine', sql: MIGRATION_004_PIPELINE_ENGINE },
  { version: 5, id: '005_pipeline_provenance', sql: MIGRATION_005_PIPELINE_PROVENANCE },
];

/** Последняя (ожидаемая) версия схемы. */
export function latestSchemaVersion(migrations: readonly PostgresMigration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}
