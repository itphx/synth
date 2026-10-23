/**
 * Миграция 013_session_mode_by_principal — режим сессии по принципалу
 * (ADR-106 Ф4, шаг C).
 *
 * `mode_by_principal` — jsonb-карта переопределений режима сессии по id
 * участника (`{ "<userId>": "yolo" }`). Режим — свойство хода: `yolo`,
 * выставленный одним участником, действует только на его ходы и не снимает
 * подтверждения у других участников.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_013_SESSION_MODE_BY_PRINCIPAL = `
-- ADR-106 Ф4 (шаг C): режим сессии по принципалу.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode_by_principal jsonb;
`;
