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
import { MIGRATION_006_PLUGIN_AUDIT } from './006-plugin-audit.js';
import { MIGRATION_007_PLUGIN_LOCK } from './007-plugin-lock.js';
import { MIGRATION_008_PLUGIN_AUDIT_SCAN } from './008-plugin-audit-scan.js';
import { MIGRATION_009_PLUGIN_LOCK_PREVIOUS } from './009-plugin-lock-previous.js';
import { MIGRATION_010_PLUGIN_LOCK_MODE } from './010-plugin-lock-mode.js';
import { MIGRATION_011_SESSION_STEER_INBOX } from './011-session-steer-inbox.js';
import { MIGRATION_012_EXTERNAL_CREDENTIALS } from './012-external-credentials.js';
import { MIGRATION_013_SERVICE_KEY_PLUGIN_ID } from './013-service-key-plugin-id.js';
import { MIGRATION_014_SESSION_MODE_BY_PRINCIPAL } from './014-session-mode-by-principal.js';
import { MIGRATION_015_AUTHORITY } from './015-authority.js';
import { MIGRATION_016_CREDENTIAL_AUDIT } from './016-credential-audit.js';
import { MIGRATION_017_MEMORY } from './017-memory.js';

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
  { version: 6, id: '006_plugin_audit', sql: MIGRATION_006_PLUGIN_AUDIT },
  { version: 7, id: '007_plugin_lock', sql: MIGRATION_007_PLUGIN_LOCK },
  { version: 8, id: '008_plugin_audit_scan', sql: MIGRATION_008_PLUGIN_AUDIT_SCAN },
  { version: 9, id: '009_plugin_lock_previous', sql: MIGRATION_009_PLUGIN_LOCK_PREVIOUS },
  { version: 10, id: '010_plugin_lock_mode', sql: MIGRATION_010_PLUGIN_LOCK_MODE },
  { version: 11, id: '011_session_steer_inbox', sql: MIGRATION_011_SESSION_STEER_INBOX },
  { version: 12, id: '012_external_credentials', sql: MIGRATION_012_EXTERNAL_CREDENTIALS },
  { version: 13, id: '013_service_key_plugin_id', sql: MIGRATION_013_SERVICE_KEY_PLUGIN_ID },
  { version: 14, id: '014_session_mode_by_principal', sql: MIGRATION_014_SESSION_MODE_BY_PRINCIPAL },
  { version: 15, id: '015_authority', sql: MIGRATION_015_AUTHORITY },
  { version: 16, id: '016_credential_audit', sql: MIGRATION_016_CREDENTIAL_AUDIT },
  { version: 17, id: '017_memory', sql: MIGRATION_017_MEMORY },
];

/** Последняя (ожидаемая) версия схемы. */
export function latestSchemaVersion(migrations: readonly PostgresMigration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}
