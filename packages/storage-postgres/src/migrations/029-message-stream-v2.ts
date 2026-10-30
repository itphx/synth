/**
 * Миграция 029_message_stream_v2 — модель «ход как последовательность шагов»
 * (ADR-118).
 *
 * В таблице `messages` появляются четыре аддитивные колонки:
 *   - `ord integer` — **монотонный** счётчик порядка записи в историю
 *     сессии (выдаётся при материализации, никогда не перенумеровывается);
 *   - `turn_id text` — идентификатор хода (`Turn`);
 *   - `step_index integer` — индекс шага внутри хода (0-based; шаг = один
 *     вызов LLM = одно assistant-сообщение);
 *   - `status text` — статус сообщения-хода
 *     (`streaming`/`completed`/`cancelled`/`error`).
 *
 * `seq` **не трогается**: он остаётся позиционным, а `UNIQUE (session_id, seq)`
 * сохраняется (ADR-118 §2 «Альтернативы (а)»).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 * Данные (проставка `ord`/`turn_id`/`step_index` старым сообщениям) миграцией
 * **не** делается: она построчная и живёт в ядре
 * (`packages/core/src/storage/migrations.ts`, ADR-118 §9).
 */

export const MIGRATION_029_MESSAGE_STREAM_V2 = `
-- ADR-118: порядок записи (ord), ход (turn_id), шаг (step_index), статус.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ord integer;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS step_index integer;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text;
CREATE INDEX IF NOT EXISTS messages_session_ord_idx ON messages (session_id, ord);
COMMENT ON COLUMN messages.ord IS 'ADR-118: монотонный счётчик порядка записи в историю сессии (не перенумеровывается)';
COMMENT ON COLUMN messages.turn_id IS 'ADR-118: идентификатор хода (Turn)';
COMMENT ON COLUMN messages.step_index IS 'ADR-118: индекс шага внутри хода (0-based)';
COMMENT ON COLUMN messages.status IS 'ADR-118: статус сообщения (streaming/completed/cancelled/error)';
`;
