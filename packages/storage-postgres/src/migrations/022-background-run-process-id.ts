/**
 * Миграция 022_background_run_process_id — идентификатор фонового процесса
 * в реестре фоновых прогонов.
 *
 * `process_id text` — идентификатор фонового процесса у порта исполнения
 * (`proc_<uuid>`, ADR-113/ADR-077): по нему процесс останавливается и
 * различается в UI. Поле появилось в контракте `BackgroundRunRecord` позже
 * миграции `021`, поэтому колонки в таблице `background_runs` не было — PG-порт
 * её не писал и не читал, и в уведомлении/UI `process_id` был `bgr_…`
 * (id записи реестра) вместо `proc_…`.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_022_BACKGROUND_RUN_PROCESS_ID = `
-- Идентификатор фонового процесса у порта исполнения.
ALTER TABLE background_runs ADD COLUMN IF NOT EXISTS process_id text;
COMMENT ON COLUMN background_runs.process_id IS 'proc_<uuid> — идентификатор фонового процесса у порта исполнения (ADR-113/ADR-077)';
`;
