/**
 * Миграция 023_session_worktree — привязка сессии к git-worktree.
 *
 * `worktree jsonb` — снимок привязки сессии к worktree (ADR-114 §1.3/§3.4):
 * `worktree_id`/`project_id`/`repo_path`/`directory`/`branch`. Поле появилось
 * в контракте `Session.worktree` после миграции `021`, поэтому колонки в
 * таблице `sessions` не было — PG-порт её не писал и не читал, и привязка не
 * переживала рестарт инстанса (резолв cwd уходил в `project.workspace`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_023_SESSION_WORKTREE = `
-- Привязка сессии к worktree (ADR-114): снимок привязки в одном jsonb-объекте.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree jsonb;
COMMENT ON COLUMN sessions.worktree IS 'Привязка сессии к git-worktree: worktree_id/project_id/repo_path/directory/branch (ADR-114)';
`;
