/**
 * Миграция 014_credential_audit — журнал операций со слоем доступов
 * (ADR-105 Ф4).
 *
 * Отдельная append-only таблица: журнал доступа — **не** security-аудит
 * (семантика «операция с OAuth-кредой» ≠ «изменение политики»), поэтому свой
 * порт, своя таблица и свой набор колонок.
 *
 * Секретов в таблице нет: только id доступа, провайдер, операция, исход, код
 * ошибки и id MCP-коннектора (ADR-105 §7).
 *
 * `seq bigserial` — стабильный порядок «свежие первыми» (как у
 * `maintenance_audit`/`security_audit`/`plugin_audit`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_014_CREDENTIAL_AUDIT = `
-- Журнал операций со слоем доступов (ADR-105 Ф4): issue/refresh/revoke/bind/use.
CREATE TABLE IF NOT EXISTS credential_audit (
  seq           bigserial PRIMARY KEY,
  id            text NOT NULL,
  ts            timestamptz NOT NULL,
  op            text NOT NULL,
  credential_id text NOT NULL,
  provider      text NOT NULL,
  outcome       text NOT NULL,
  error_code    text,
  connector_id  text
);
CREATE INDEX IF NOT EXISTS credential_audit_ts_idx           ON credential_audit (ts DESC);
CREATE INDEX IF NOT EXISTS credential_audit_credential_ts_idx ON credential_audit (credential_id, ts DESC);
`;
