/**
 * Миграция 028_message_reasoning_signature — подпись thinking-блока Anthropic
 * в истории сообщений.
 *
 * `reasoning_signature text` — подпись блока `thinking` (`signature`), пустая
 * строка валидна; `reasoning_redacted jsonb` — массив opaque-данных блоков
 * `redacted_thinking` (реплеятся в историю verbatim). Без этих полей
 * tool-loop при включённом thinking отвергается API («thinking не возвращён в
 * историю»): PG-порт их не писал и не читал, и подпись терялась после рестарта.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_028_MESSAGE_REASONING_SIGNATURE = `
-- Anthropic: подпись thinking-блока и opaque-данные redacted-блоков сообщения.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_signature text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_redacted jsonb;
COMMENT ON COLUMN messages.reasoning_signature IS 'Anthropic: подпись thinking-блока (пустая строка валидна)';
COMMENT ON COLUMN messages.reasoning_redacted IS 'Anthropic: opaque-данные блоков redacted_thinking (verbatim data)';
`;
