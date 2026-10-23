/**
 * Миграция 015_authority — порты Authority-слоя (ADR-106 Ф0/Ф1).
 *
 * - `authority_policy` — политика полномочий **инстанса** (ADR-106 Ф0): одна
 *   строка (`id = 'instance'`), документ — JSONB (`actions`/`roles`/`targets`/
 *   `ceilings`/`agents`). Политика одна на инстанс, поэтому отдельная таблица
 *   с единственным ключом: «политика не задана» (`строк нет`) и «политика
 *   задана и ничего не разрешает» (пустой документ) — **разные** состояния
 *   (fail-closed на оси «user», а не «политика без грантов»).
 * - `authority_decisions` — append-only журнал решений Authority-слоя (ADR-106
 *   Ф1): `seq bigserial` — стабильный порядок «свежие первыми» (как у
 *   `security_audit`/`plugin_audit`). Секретов и сырых путей в записи нет:
 *   нормализация цели — на стороне вызывающего (shadow-слой).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_015_AUTHORITY = `
-- ADR-106 Ф0: политика полномочий инстанса (одна строка — политика инстанса).
CREATE TABLE IF NOT EXISTS authority_policy (
  id         text PRIMARY KEY,
  document   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ADR-106 Ф1: append-only журнал решений Authority-слоя.
CREATE TABLE IF NOT EXISTS authority_decisions (
  seq               bigserial PRIMARY KEY,
  id                text NOT NULL,
  ts                timestamptz NOT NULL,
  principal         text NOT NULL,
  action            text NOT NULL,
  target            text NOT NULL,
  effect            text NOT NULL,
  source            text NOT NULL,
  reason            text,
  mode              text NOT NULL DEFAULT 'shadow',
  permission_effect text
);
CREATE INDEX IF NOT EXISTS authority_decisions_ts_idx     ON authority_decisions (ts DESC);
CREATE INDEX IF NOT EXISTS authority_decisions_action_idx ON authority_decisions (action);
CREATE INDEX IF NOT EXISTS authority_decisions_effect_idx ON authority_decisions (effect);
CREATE INDEX IF NOT EXISTS authority_decisions_source_idx ON authority_decisions (source);
`;
