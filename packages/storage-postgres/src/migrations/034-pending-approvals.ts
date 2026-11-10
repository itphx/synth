/**
 * Миграция 034_pending_approvals — ожидания подтверждения прав (ADR-029).
 *
 * **Отдельная таблица, а не поле документа сессии**: документ сессии пишется
 * полной перезаменой (`save`), а результаты параллельных тулов — точечно
 * (`appendMessage`, ADR-118 §4). Запись ожидания в тот же документ затирала бы
 * точечные записи → гонка lost update.
 *
 * Таблица `pending_approvals`: состав ожидания (тул, аргументы, причина,
 * «виновник») + метаданные (сессия, владелец, момент публикации, таймаут,
 * ход, принципал). Выборка — по сессии.
 *
 * FK нет (паритет с файловыми реализациями): удаление сессии не чистит
 * ожидания — их снимает сам менеджер подтверждений.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасо.
 */

export const MIGRATION_034_PENDING_APPROVALS = `
-- Ожидания подтверждения прав (ADR-029): отдельный стор, не документ сессии.
CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id text PRIMARY KEY,
  session_id  text NOT NULL,
  owner_id    text,
  tool_name   text NOT NULL,
  arguments   jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason      text NOT NULL DEFAULT '',
  trigger     jsonb,
  asked_at    timestamptz NOT NULL DEFAULT now(),
  timeout_ms  integer NOT NULL DEFAULT 0,
  turn_id     text,
  principal   text
);
CREATE INDEX IF NOT EXISTS pending_approvals_session_idx ON pending_approvals (session_id);
COMMENT ON TABLE pending_approvals IS 'Ожидания подтверждения прав (ADR-029): отдельный стор, переживает рестарт инстанса';
`;
