/**
 * Миграция 037_timers — таймеры/будильники и история их срабатываний
 * (PROP-141, Часть B; ADR-097 — драйвер слоя хранения).
 *
 * Две независимые таблицы:
 * - `timers` — реестр автоматизаций: вид (`timer`/`alarm`), проект и сессия
 *   (оба обязательны — инстансных автоматизаций нет), владелец, режим повтора
 *   (`repeat jsonb`), статус и ближайшее срабатывание (`fires_at`);
 * - `timer_firings` — append-only история срабатываний: плановое время
 *   (`scheduled_for`), фактическое (`fired_at`), задержка (`lag_ms`), итог
 *   (`outcome`).
 *
 * FK нет (паритет с файловыми реализациями): удаление сессии не чистит
 * таймеры — их снимает каскад `removeBySession`; история срабатываний после
 * удаления таймера остаётся (ретеншн как у Job-истории).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_037_TIMERS = `
-- PROP-141 (Часть B): реестр таймеров/будильников.
CREATE TABLE IF NOT EXISTS timers (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  name        text,
  comment     text NOT NULL,
  project_id  text NOT NULL,
  session_id  text NOT NULL,
  owner_id    text NOT NULL,
  repeat      jsonb NOT NULL,
  status      text NOT NULL,
  fires_at    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  fired_at    timestamptz,
  last_error  text
);
CREATE INDEX IF NOT EXISTS timers_session_status_idx ON timers (session_id, status);
CREATE INDEX IF NOT EXISTS timers_project_status_idx  ON timers (project_id, status);
CREATE INDEX IF NOT EXISTS timers_status_idx          ON timers (status);
CREATE INDEX IF NOT EXISTS timers_fires_at_idx        ON timers (fires_at);

-- PROP-141 (Часть B): история срабатываний (append-only).
-- seq bigserial — порядок добавления (как у plugin_audit/pipeline_run_events):
-- выборка «в порядке добавления» детерминирована.
CREATE TABLE IF NOT EXISTS timer_firings (
  seq            bigserial PRIMARY KEY,
  id             text NOT NULL UNIQUE,
  timer_id       text NOT NULL,
  fired_at       timestamptz NOT NULL,
  scheduled_for  timestamptz NOT NULL,
  lag_ms         bigint NOT NULL,
  outcome        text NOT NULL,
  session_id     text NOT NULL
);
CREATE INDEX IF NOT EXISTS timer_firings_timer_idx ON timer_firings (timer_id, seq);
CREATE INDEX IF NOT EXISTS timer_firings_fired_at_idx ON timer_firings (fired_at);

COMMENT ON TABLE timers IS 'PROP-141: реестр таймеров и будильников (привязаны к проекту и сессии)';
COMMENT ON TABLE timer_firings IS 'PROP-141: append-only история срабатываний таймеров';
`;
