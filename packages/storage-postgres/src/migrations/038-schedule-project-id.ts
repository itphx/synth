/**
 * Миграция 038_schedule_project_id — проект расписания (PROP-141, Часть B
 * «Расписания: привязка к проекту»; ADR-097 — драйвер слоя хранения).
 *
 * Инстансных автоматизаций нет: каждое расписание принадлежит проекту.
 * Поэтому у расписания появляется колонка `project_id`, а существующие
 * записи получают проект **бэкфиллом**:
 * - `pipeline` → `target->>'projectId'` (проект-владелец пайплайна);
 * - `ephemeral` → `target->>'project'` (проект цели);
 * - `bound`/`queue` → проект сессии-цели (`sessions.project_id`).
 *
 * Проект вывести нельзя (легаси `ephemeral` без проекта, удалённая сессия) —
 * запись **не теряется**: она остаётся в реестре, но отключается и
 * помечается `last_error = 'project_required'` (не срабатывает).
 *
 * Миграция идемпотентна (`IF NOT EXISTS` + `WHERE project_id IS NULL`).
 */

export const MIGRATION_038_SCHEDULE_PROJECT_ID = `
-- PROP-141: проект расписания (обязателен — инстансных автоматизаций нет).
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS project_id text;

-- Бэкфилл: проект выводится из цели.
UPDATE schedules SET project_id = COALESCE(
  NULLIF(target->>'projectId', ''),
  NULLIF(target->>'project', ''),
  (SELECT s.project_id FROM sessions s WHERE s.id = target->>'sessionId')
)
WHERE project_id IS NULL;

-- Проект вывести нельзя: запись остаётся, но не срабатывает.
UPDATE schedules
SET enabled = false, last_error = 'project_required'
WHERE project_id IS NULL OR project_id = '';

CREATE INDEX IF NOT EXISTS schedules_project_idx ON schedules (project_id);

COMMENT ON COLUMN schedules.project_id IS 'PROP-141: проект-владелец расписания (обязателен)';
`;
