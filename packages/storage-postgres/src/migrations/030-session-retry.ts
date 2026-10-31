/**
 * Миграция 030_session_retry — персистентное состояние ретрая сессии.
 *
 * `retry jsonb` — снимок состояния повторной попытки LLM-вызова
 * (`stream_id`/`attempt`/`max_retries`/`retry_at`/`error`). Поле появилось в
 * контракте `Session.retry` после миграции `029`, поэтому колонки в таблице
 * `sessions` не было — PG-порт её не писал и не читал, и после reload/restart
 * клиент не видел, что ход повторяется (в отличие от файлового backend).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_030_SESSION_RETRY = `
-- Состояние ретрая сессии (персистентное): stream_id/attempt/max_retries/retry_at/error.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS retry jsonb;
COMMENT ON COLUMN sessions.retry IS 'Персистентное состояние ретрая сессии: stream_id/attempt/max_retries/retry_at/error';
`;
