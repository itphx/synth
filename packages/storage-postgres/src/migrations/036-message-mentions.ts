/**
 * Миграция 036_message_mentions — `@`-упоминания сообщения (ADR-126 §2.1).
 *
 * Добавляет к `messages` колонку `mentions jsonb` — массив
 * `[{kind, id, label, span:{start,end}}]`. Аддитивная и идемпотентная:
 * legacy-строки читаются как `undefined` (сообщений без упоминаний).
 */

export const MIGRATION_036_MESSAGE_MENTIONS = `
-- ADR-126 §2.1: упоминания @ (агент/файл/пользователь) в сообщении.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions jsonb;
COMMENT ON COLUMN messages.mentions IS 'ADR-126: @-упоминания сообщения (kind/id/label/span)';
`;
