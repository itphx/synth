/**
 * Миграция 035_project_access — состояние списка доступа к проекту (PROP-133).
 *
 * Добавляет к `projects` два столбца:
 *   - `group_members jsonb NOT NULL DEFAULT '{}'::jsonb` — гранты группам
 *     (имя группы → роль `owner|editor|viewer`);
 *   - `everyone_role text` (nullable) — роль для всех пользователей инстанса;
 *     `NULL` — проект не опубликован.
 *
 * Миграция **только аддитивная**: существующие проекты получают пустые группы и
 * `NULL` в «всем» — состояние доступа остаётся «только автор» (PROP-133:
 * «Совместимость»), поведение не меняется.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_035_PROJECT_ACCESS = `
-- PROP-133: состояние списка доступа (пользовательские гранты, группы, «всем»).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS group_members jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS everyone_role text;
COMMENT ON COLUMN projects.group_members IS 'PROP-133: гранты группам (имя группы → роль owner|editor|viewer)';
COMMENT ON COLUMN projects.everyone_role IS 'PROP-133: роль для всех пользователей инстанса; NULL — проект не опубликован';
`;
