/**
 * Миграция 004_pipeline_engine — спецификации пайплайнов, опубликованные
 * версии, прогоны и журнал выполнения (ADR-101).
 *
 * Таблицы:
 * - `pipeline_specs` — пайплайн (черновик спецификации + счётчики версий);
 *   `scope` разделяет шаблоны инстанса (`instance`) и пайплайны проекта
 *   (`project`, `project_id` задан);
 * - `pipeline_versions` — **иммутабельные снимки** опубликованных спецификаций,
 *   ключ `(pipeline_id, version)`;
 * - `pipeline_runs` — заголовки прогонов; `spec` — **снимок** спецификации на
 *   момент запуска (прогон самодостаточен и переживает удаление пайплайна);
 * - `pipeline_run_events` — журнал выполнения (append-only, `seq bigserial` —
 *   порядок добавления).
 *
 * FK нет: удаление пайплайна чистит его версии **в коде** (паритет с
 * файловой реализацией), а прогоны удалению пайплайна не подвержены вовсе.
 */

export const MIGRATION_004_PIPELINE_ENGINE = `
-- ── Pipeline Engine (ADR-101) ────────────────────────────────────────────────
CREATE TABLE pipeline_specs (
  id                text PRIMARY KEY,
  scope             text NOT NULL,
  project_id        text,
  name              text NOT NULL,
  description       text,
  icon              text,
  draft             jsonb,
  draft_version     integer NOT NULL DEFAULT 1,
  published_version integer,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX pipeline_specs_scope_idx      ON pipeline_specs (scope);
CREATE INDEX pipeline_specs_project_id_idx ON pipeline_specs (project_id);

CREATE TABLE pipeline_versions (
  pipeline_id  text NOT NULL,
  version      integer NOT NULL,
  spec         jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  published_by text,
  PRIMARY KEY (pipeline_id, version)
);

CREATE TABLE pipeline_runs (
  id           text PRIMARY KEY,
  pipeline_id  text NOT NULL,
  version      integer NOT NULL,
  spec         jsonb NOT NULL,
  project_id   text,
  status       text NOT NULL,
  current_node text,
  trigger_data jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX pipeline_runs_pipeline_id_idx ON pipeline_runs (pipeline_id);
CREATE INDEX pipeline_runs_project_id_idx  ON pipeline_runs (project_id);
CREATE INDEX pipeline_runs_status_idx      ON pipeline_runs (status);
CREATE INDEX pipeline_runs_created_at_idx  ON pipeline_runs (created_at DESC);

CREATE TABLE pipeline_run_events (
  seq     bigserial PRIMARY KEY,
  run_id  text NOT NULL,
  ts      timestamptz NOT NULL,
  type    text NOT NULL,
  payload jsonb
);
CREATE INDEX pipeline_run_events_run_id_idx ON pipeline_run_events (run_id, ts);
`;
