/**
 * Миграция 006_plugin_audit — журнал аудита плагинов (ADR-090).
 *
 * Отдельная append-only таблица: журнал плагинов — **не** security-аудит
 * (семантика «событие расширения» ≠ «изменение политики»), поэтому свой
 * порт, своя таблица и свой набор колонок.
 *
 * `seq bigserial` — стабильный порядок «свежие первыми» (как у
 * `maintenance_audit`/`security_audit`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_006_PLUGIN_AUDIT = `
-- Журнал аудита плагинов (ADR-090): активация/деактивация расширения.
CREATE TABLE IF NOT EXISTS plugin_audit (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL,
  ts           timestamptz NOT NULL,
  actor        text NOT NULL,
  scope        text NOT NULL,
  action       text NOT NULL,
  plugin       text NOT NULL,
  version      text NOT NULL,
  trust_level  text,
  scan_verdict text,
  content_hash text,
  mode         text,
  outcome      text NOT NULL,
  reason       text,
  source       text
);
CREATE INDEX IF NOT EXISTS plugin_audit_ts_idx     ON plugin_audit (ts DESC);
CREATE INDEX IF NOT EXISTS plugin_audit_plugin_ts_idx ON plugin_audit (plugin, ts DESC);
`;
