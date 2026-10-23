/**
 * Миграция 011_session_steer_inbox — очередь инъекций (steering) сессии
 * (ADR-104, Ф1).
 *
 * `steer_inbox` — jsonb-массив сообщений, отправленных во время активного
 * хода (`mode: 'steer'`). Хранится отдельно от `pending_messages`: оркестратор
 * вычитывает очередь на границе шага и вплетает сообщения в текущий ход.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_011_SESSION_STEER_INBOX = `
-- Очередь инъекций (steering) сессии.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS steer_inbox jsonb NOT NULL DEFAULT '[]'::jsonb;
`;
