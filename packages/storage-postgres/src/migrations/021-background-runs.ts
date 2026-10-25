/**
 * Миграция 021_background_runs — вопросы пользователю и реестр фоновых
 * прогонов (этап 1 roadmap 0.13: блок 1.2 «фоны» + блок 1.3 «ask_user»).
 *
 * Две независимые таблицы:
 * - `questions` — персистентные вопросы пользователю (PROP: блок 1.3): состав
 *   вопросов и ответы — `jsonb`, выборки — по сессии и статусу;
 * - `background_runs` — единый реестр фоновой работы (PROP-096 — фоновые
 *   саб-агенты, PROP-097 — фоновые шелл-процессы): вид, статус, владелец и
 *   параметры прогона, лог — относительный путь в BlobStore.
 *
 * FK нет (паритет с файловыми реализациями): удаление сессии не чистит
 * вопросы/прогоны — их чистит retention-очистка (`prune`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_021_BACKGROUND_RUNS = `
-- Вопросы пользователю (этап 1 roadmap 0.13, блок 1.3).
CREATE TABLE IF NOT EXISTS questions (
  id           text PRIMARY KEY,
  session_id   text NOT NULL,
  turn_id      text,
  tool_call_id text,
  agent_role   text,
  questions    jsonb NOT NULL,
  status       text NOT NULL,
  answers      jsonb,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  expires_at   timestamptz,
  answered_at  timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  answered_by  text
);
CREATE INDEX IF NOT EXISTS questions_session_status_idx ON questions (session_id, status);
CREATE INDEX IF NOT EXISTS questions_status_idx        ON questions (status);
CREATE INDEX IF NOT EXISTS questions_updated_at_idx     ON questions (updated_at);

-- Единый реестр фоновых прогонов (этап 1 roadmap 0.13, блок 1.2;
-- PROP-096 — фоновые саб-агенты, PROP-097 — фоновые шелл-процессы).
CREATE TABLE IF NOT EXISTS background_runs (
  id               text PRIMARY KEY,
  kind             text NOT NULL,
  status           text NOT NULL,
  session_id       text NOT NULL,
  project_id       text,
  child_session_id text,
  agent_role       text,
  description      text,
  command          text,
  cwd              text,
  pid              integer,
  log_path         text,
  exit_code        integer,
  signal           text,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL,
  summary          text,
  metadata         jsonb
);
CREATE INDEX IF NOT EXISTS background_runs_session_status_idx ON background_runs (session_id, status);
CREATE INDEX IF NOT EXISTS background_runs_status_idx         ON background_runs (status);
CREATE INDEX IF NOT EXISTS background_runs_started_at_idx     ON background_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS background_runs_updated_at_idx     ON background_runs (updated_at);
`;
