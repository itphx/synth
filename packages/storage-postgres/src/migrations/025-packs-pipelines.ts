/**
 * Миграция 025_packs_pipelines — перевод в SQL двух «переходно файловых»
 * портов инстанса (ADR-116): реестра установок пакетов расширений
 * (`PackRepository`, ADR-086 §5 / PROP-068) и legacy-пайплайнов
 * (`PipelineRepository`, ADR-051/ADR-100).
 *
 * Таблицы повторяют доменные типы портов (`PackInstallation`,
 * `PipelineDefinitionRecord`, `PipelineInstanceRecord`), поэтому скалярные поля
 * определения (`on_error`/`max_attempts`/`ttl`) — колонки, а не jsonb:
 * по ним возможны выборки, и триггеры не требуются.
 * - `pack_installations` — ключ записи — имя пакета (уникально в инстансе);
 *   `manifest`/`files`/`provides` — `jsonb` (манифест и содержимое отложенной
 *   установки сохраняются как есть);
 * - `pipeline_definitions` — ключ — `id`; `installed_by` — `jsonb`
 *   (`{pack, version}` — провенанс установки пакетом);
 * - `pipeline_instances` — экземпляры прогонов: `steps`/`trigger`/`payload` —
 *   `jsonb`, `attempts` — `integer`, `status` — текст (значения — доменный
 *   перечень, CHECK не ставится: расширение перечня не должно требовать DDL).
 *
 * Индексы: выборка экземпляров — по определению (`pipeline_id`) и «свежие
 * первыми» (`created_at DESC`).
 *
 * FK нет (паритет с файловой реализацией): удаление определения **не** трогает
 * экземпляры — прогон самодостаточен, чистка идёт в коде порта.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_025_PACKS_PIPELINES = `
-- ADR-116: реестр установок пакетов расширений (ADR-086 §5 / PROP-068).
CREATE TABLE IF NOT EXISTS pack_installations (
  name              text PRIMARY KEY,          -- имя пакета, уникально в инстансе
  version           text NOT NULL,
  kind              text NOT NULL,             -- plugin | gateway | addon | pack | storage
  pack_type         text,                      -- тип контент-пака (только kind='pack')
  description       text,
  status            text NOT NULL,             -- active | pending_approval | disabled
  requires_approval boolean NOT NULL DEFAULT false,
  trust_level       text,                      -- ADR-106 Ф5: фактическое доверие пакета
  manifest          jsonb,                     -- сырой манифест synth.pack (аудит/детали в UI)
  files             jsonb,                     -- файлы пакета для отложенной установки
  provides          jsonb NOT NULL,            -- id'ы поставленных сущностей (agents/skills/mcp/pipelines)
  installed_by      text,
  installed_at      timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);
COMMENT ON TABLE pack_installations IS 'Установленные пакеты расширений: имя — ключ upsert, installed_at иммутабелен (ADR-086/ADR-116)';

-- ADR-116: legacy-пайплайны (ADR-051/ADR-100) — определения автомата.
CREATE TABLE IF NOT EXISTS pipeline_definitions (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text,
  version      text,
  steps        jsonb NOT NULL,
  on_error     text,                           -- fail | retry | rollback
  max_attempts integer,
  ttl          text,
  installed_by jsonb,                          -- провенанс {pack, version}
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
COMMENT ON TABLE pipeline_definitions IS 'Определения legacy-пайплайнов инстанса: upsert по id, created_at иммутабелен (ADR-051/ADR-100)';

-- ADR-116: экземпляры legacy-пайплайнов (прогоны автомата).
CREATE TABLE IF NOT EXISTS pipeline_instances (
  id               text PRIMARY KEY,
  pipeline_id      text NOT NULL,
  pipeline_version text,
  status           text NOT NULL,
  steps            jsonb NOT NULL,
  current_step     text,
  trigger          jsonb,
  attempts         integer NOT NULL DEFAULT 0,
  payload          jsonb,
  error            text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_instances_pipeline_idx ON pipeline_instances (pipeline_id);
CREATE INDEX IF NOT EXISTS pipeline_instances_created_idx ON pipeline_instances (created_at DESC);
COMMENT ON TABLE pipeline_instances IS 'Экземпляры legacy-пайплайнов: выборка «свежие первыми», фильтры по определению/статусу (ADR-116)';
`;
