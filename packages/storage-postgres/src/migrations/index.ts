/**
 * Реестр SQL-миграций схемы PostgreSQL-драйвера (PROP-032, волна 3a).
 *
 * Отдельный механизм от `meta.json`/file-миграций (ADR-092): версия схемы БД
 * живёт в таблице `synth_schema_migrations` (см. `migrate.ts`). Миграции
 * применяются строго по возрастанию `version`; `id` — стабильное имя-метка.
 *
 * Добавление миграции: новый модуль `NNN-<name>.ts` с SQL-строкой и запись в
 * массив `MIGRATIONS` (версии уникальны и монотонны).
 */

import { MIGRATION_001_INIT } from './001-init.js';

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
];

/** Последняя (ожидаемая) версия схемы. */
export function latestSchemaVersion(migrations: readonly PostgresMigration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}
