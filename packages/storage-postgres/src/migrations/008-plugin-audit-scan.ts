/**
 * Миграция 008_plugin_audit_scan — поля скана в журнале аудита плагинов
 * (ADR-090, Ф2).
 *
 * Ф1-журнал знал только вердикт скана; Ф2 добавил действие `scan` и два поля:
 * `scan_performed` (выполнялся ли скан — по нему видно, что скан был **выключен
 * политикой**) и `scan_findings` (число находок).
 *
 * Миграция идемпотентна (`ADD COLUMN IF NOT EXISTS`).
 */

export const MIGRATION_008_PLUGIN_AUDIT_SCAN = `
-- Скан плагина: выполнялся ли и сколько находок (ADR-090, Ф2).
ALTER TABLE plugin_audit ADD COLUMN IF NOT EXISTS scan_performed boolean;
ALTER TABLE plugin_audit ADD COLUMN IF NOT EXISTS scan_findings integer;
`;
