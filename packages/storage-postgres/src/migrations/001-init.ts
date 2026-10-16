/**
 * Миграция 001_init — полная схема PostgreSQL-драйвера хранения (PROP-032).
 *
 * DDL вынесен **inline TS-строкой** (а не `.sql`-ассетом) — package.json
 * публикует только `dist`, и `tsc` эмитит эту строку в собранный JS: не нужны
 * шаги копирования SQL в сборке/публикации.
 *
 * Соглашения (зафиксированы разведкой PROP-032, не менять без причины):
 *   - все времена — `timestamptz`; идентификаторы — `text`;
 *   - FK — только внутри инстанса; на `profiles`/`sessions` по `user_id`/`owner_id`
 *     FK НЕ ставится (`local`/`service:<id>`/username/`remote:<uuid>`);
 *   - таблицы создаются в схеме драйвера (внешний `CREATE SCHEMA`/`search_path`);
 *   - порты реализуются следующей волной — это схема под них.
 */

export const MIGRATION_001_INIT = `
-- Триграммный индекс по содержимому сообщений.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Сессии ────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id                    text PRIMARY KEY,
  title                 text,
  icon                  text,
  color                 text,
  session_origin        text NOT NULL,
  parent_id             text,
  branch_point          text,
  plan_approved         boolean,
  mode                  text,
  user_id               text,
  owner_id              text,
  project_id            text,
  todos                 jsonb,
  prompt_states         jsonb,
  obfuscation_map       jsonb,
  status                jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  mcp_servers           jsonb,
  pending_messages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_stream        jsonb,
  summarization_pending boolean NOT NULL DEFAULT false,
  can_summarize         boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  expires_at            timestamptz,
  archived_at           timestamptz,
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  total_tokens          bigint NOT NULL DEFAULT 0,
  cache_read_tokens     bigint NOT NULL DEFAULT 0,
  cache_write_tokens    bigint NOT NULL DEFAULT 0,
  reasoning_tokens      bigint NOT NULL DEFAULT 0,
  input_cost            double precision NOT NULL DEFAULT 0,
  output_cost           double precision NOT NULL DEFAULT 0,
  cache_read_cost       double precision NOT NULL DEFAULT 0,
  cache_write_cost      double precision NOT NULL DEFAULT 0,
  cache_hit_rate        double precision
);
CREATE INDEX sessions_updated_at_idx  ON sessions (updated_at DESC);
CREATE INDEX sessions_project_id_idx  ON sessions (project_id, updated_at DESC);
CREATE INDEX sessions_user_id_idx     ON sessions (user_id, updated_at DESC);
CREATE INDEX sessions_owner_id_idx    ON sessions (owner_id, updated_at DESC);
CREATE INDEX sessions_parent_id_idx   ON sessions (parent_id, updated_at DESC);
CREATE INDEX sessions_expires_at_idx  ON sessions (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX sessions_archived_at_idx ON sessions (archived_at) WHERE archived_at IS NOT NULL;

-- ── Сообщения (нормализованы; порядок — UNIQUE(session_id, seq)) ──────────
-- Суррогатный PK (message_uid): доменный id сообщения НЕ уникален в пределах
-- сессии (legacy-данные содержат дубликаты id), поэтому PK по id невозможен.
-- id остаётся обычной колонкой с индексом (session_id, id) для поиска/отладки;
-- seq — позиционный (драйвер нормализует при записи).
CREATE TABLE messages (
  message_uid   bigserial PRIMARY KEY,
  id            text NOT NULL,
  session_id    text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  role          text NOT NULL,
  origin        text NOT NULL,
  source_msg_id text,
  content       text NOT NULL DEFAULT '',
  parts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_calls    jsonb,
  tool_call_id  text,
  usage         jsonb,
  metadata      jsonb,
  prompt_meta   jsonb,
  debug_data    jsonb,
  summary_of    jsonb,
  model         text,
  provider      text,
  provider_type text,
  reasoning     text,
  source        text,
  author        text,
  agent_role    text,
  qa_pass       boolean,
  qa_reason     text,
  disabled      boolean NOT NULL DEFAULT false,
  pinned        boolean NOT NULL DEFAULT false,
  hidden        boolean NOT NULL DEFAULT false,
  ephemeral     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL,
  CONSTRAINT messages_session_seq_key UNIQUE (session_id, seq)
);
CREATE INDEX messages_session_id_idx    ON messages (session_id, id);
CREATE INDEX messages_session_seq_idx   ON messages (session_id, seq);
CREATE INDEX messages_content_trgm_idx  ON messages USING gin (content gin_trgm_ops);

-- ── Child-таблицы сессий ──────────────────────────────────────────────────
CREATE TABLE session_references (
  id             text PRIMARY KEY,
  session_id     text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ref_session_id text NOT NULL,
  label          text NOT NULL,
  message_range  jsonb NOT NULL,
  auto_summary   text,
  ordinal        integer NOT NULL,
  created_at     timestamptz NOT NULL
);
CREATE INDEX session_references_session_id_idx ON session_references (session_id, ordinal);

CREATE TABLE checkpoints (
  id         text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX checkpoints_session_id_idx ON checkpoints (session_id, created_at);

CREATE TABLE sticky_notes (
  id         text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content    text NOT NULL DEFAULT '',
  disabled   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX sticky_notes_session_id_idx ON sticky_notes (session_id);

-- ── Проекты ───────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  owner_id        text NOT NULL,
  description     text NOT NULL DEFAULT '',
  current_task    text NOT NULL DEFAULT '',
  invariants      text NOT NULL DEFAULT '',
  icon            text,
  color           text,
  workspace       text,
  plan            jsonb,
  log             jsonb,
  status_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  repos           jsonb,
  mcp             jsonb,
  skills          jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX projects_updated_at_idx ON projects (updated_at DESC);
CREATE INDEX projects_owner_id_idx   ON projects (owner_id);

CREATE TABLE project_members (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_id_idx ON project_members (user_id);

-- ── Профили ───────────────────────────────────────────────────────────────
CREATE TABLE profiles (
  id                     text PRIMARY KEY,
  username               text NOT NULL UNIQUE,
  email                  text UNIQUE,
  phone                  text,
  roles                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  team_roles             jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active              boolean NOT NULL DEFAULT true,
  preferences            jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                  text NOT NULL DEFAULT '',
  -- Nullable: отличаем «поле отсутствует (legacy-профиль)» от «явный false».
  -- Backfill метки [ИНТЕРВЬЮ] — в порту при чтении (паритет с FileProfileStore).
  interview_completed    boolean,
  interview_completed_at timestamptz,
  display_name           text,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  last_login             timestamptz
);

CREATE TABLE profile_identities (
  id           bigserial PRIMARY KEY,
  profile_id   text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  external_id  text NOT NULL,
  username     text,
  display_name text,
  linked_at    timestamptz NOT NULL,
  linked_by    text,
  CONSTRAINT profile_identities_provider_external_key UNIQUE (provider, external_id)
);
CREATE INDEX profile_identities_profile_id_idx ON profile_identities (profile_id);

-- ── Runtime-настройки, калибровка, маркеры миграций ───────────────────────
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE token_ratios (
  model      text PRIMARY KEY,
  ratio      double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE migration_markers (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ── Конфигурационные документы (providers/models/agents) ──────────────────
CREATE TABLE documents (
  kind       text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);

-- ── Внешние события (ADR-089) ─────────────────────────────────────────────
CREATE TABLE event_bindings (
  id             text PRIMARY KEY,
  source         text NOT NULL,
  chat_key       text,
  thread_key     text,
  session_id     text,
  mode           text NOT NULL,
  agent_template text,
  project        text
);
CREATE INDEX event_bindings_source_idx ON event_bindings (source);

CREATE TABLE event_routes (
  id       text PRIMARY KEY,
  name     text,
  priority integer NOT NULL DEFAULT 0,
  enabled  boolean NOT NULL DEFAULT true,
  match    jsonb NOT NULL DEFAULT '{}'::jsonb,
  target   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX event_routes_priority_idx ON event_routes (priority DESC);

CREATE TABLE event_api_keys (
  id                    text PRIMARY KEY,
  -- FK на event_bindings НЕТ: каскад реализован в коде (removeByBinding),
  -- как в файловой реализации (bindings.json и api-keys.json — независимые
  -- сторы, референсной целостности БД не требуют). Колонка и индекс — остаются.
  binding_id            text NOT NULL,
  label                 text NOT NULL,
  description           text,
  secret_hash           text NOT NULL,
  prefix                text NOT NULL,
  rate_limit_per_minute integer,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL,
  last_used_at          timestamptz,
  expires_at            timestamptz,
  revoked_at            timestamptz
);
CREATE UNIQUE INDEX event_api_keys_label_uq       ON event_api_keys (lower(label));
CREATE UNIQUE INDEX event_api_keys_secret_hash_uq ON event_api_keys (secret_hash);
CREATE INDEX        event_api_keys_binding_id_idx ON event_api_keys (binding_id);

CREATE TABLE event_journal (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL,
  ts           timestamptz NOT NULL,
  source       text,
  type         text,
  decision     jsonb,
  key_id       text,
  identity     jsonb,
  dedup_key    text,
  error        text,
  principal_id text,
  payload      jsonb
);
CREATE INDEX event_journal_ts_idx ON event_journal (ts DESC);

CREATE TABLE identity_claims (
  code         text PRIMARY KEY,
  provider     text NOT NULL,
  external_id  text NOT NULL,
  chat_key     text,
  -- Полный principalId отправителя (не восстанавливается склейкой provider:id).
  principal_id text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

CREATE TABLE dedup (
  key        text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

-- ── Шедулер (ADR-051) ─────────────────────────────────────────────────────
CREATE TABLE schedules (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  cron        text,
  every       text,
  target      jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt      text,
  payload     jsonb,
  owner_id    text,
  catch_up    text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_status text,
  last_error  text
);
CREATE INDEX schedules_enabled_idx ON schedules (enabled);

CREATE TABLE jobs (
  seq           bigserial PRIMARY KEY,
  id            text NOT NULL,
  schedule_id   text NOT NULL,
  schedule_name text NOT NULL,
  trigger       text NOT NULL,
  status        text NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  duration_ms   bigint NOT NULL DEFAULT 0,
  target        jsonb,
  dedup_key     text,
  decision      text,
  reason        text,
  session_id    text,
  error         text
);
CREATE INDEX jobs_schedule_id_idx ON jobs (schedule_id, started_at DESC);

-- ── Исходящие webhooks (ADR-052 этап II) ──────────────────────────────────
CREATE TABLE webhooks (
  id               text PRIMARY KEY,
  label            text NOT NULL,
  description      text,
  url              text NOT NULL,
  events           jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  secret_enc       bytea NOT NULL,
  secret_prefix    text NOT NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL,
  last_delivery_at timestamptz,
  last_status      text,
  disabled_at      timestamptz
);
CREATE UNIQUE INDEX webhooks_label_uq ON webhooks (lower(label));

CREATE TABLE webhook_deliveries (
  seq             bigserial PRIMARY KEY,
  id              text NOT NULL,
  -- FK на webhooks НЕТ: каскад реализован в коде (webhooks.remove чистит
  -- доставки отвязанной подписки), как у файловой реализации (deliveries.jsonl —
  -- отдельный журнал). Колонка и индекс — остаются.
  subscription_id text NOT NULL,
  event_type      text NOT NULL,
  status          text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  response_status integer,
  error           text,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz
);
CREATE INDEX webhook_deliveries_subscription_id_idx ON webhook_deliveries (subscription_id, created_at DESC);

-- ── Секреты и реестры ─────────────────────────────────────────────────────
CREATE TABLE ssh_keys (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  type           text,
  private_enc    bytea NOT NULL,
  passphrase_enc bytea,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz
);
-- Уникальность имени (регистронезависимо): код по-прежнему делает предпроверку,
-- но БД гарантирует инвариант и закрывает гонку.
CREATE UNIQUE INDEX ssh_keys_name_uq ON ssh_keys (lower(name));

CREATE TABLE ssh_key_agents (
  key_id   text NOT NULL REFERENCES ssh_keys(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  PRIMARY KEY (key_id, agent_id)
);
CREATE INDEX ssh_key_agents_agent_id_idx ON ssh_key_agents (agent_id);

CREATE TABLE service_keys (
  id                    text PRIMARY KEY,
  label                 text NOT NULL,
  description           text,
  roles                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes                jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_projects      jsonb,
  rate_limit_per_minute integer,
  secret_hash           text NOT NULL,
  prefix                text NOT NULL,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL,
  last_used_at          timestamptz,
  expires_at            timestamptz,
  revoked_at            timestamptz
);
CREATE UNIQUE INDEX service_keys_label_uq       ON service_keys (lower(label));
CREATE UNIQUE INDEX service_keys_secret_hash_uq ON service_keys (secret_hash);

CREATE TABLE mcp_registry (
  id                 text PRIMARY KEY,
  schema_version     integer NOT NULL DEFAULT 1,
  name               text NOT NULL UNIQUE,
  config             jsonb NOT NULL,
  origin             text NOT NULL,
  author             jsonb,
  trust              jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  enabled_by_default boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE skill_bundles (
  name        text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  skills      jsonb NOT NULL DEFAULT '[]'::jsonb,
  instruction text
);

CREATE TABLE maintenance_audit (
  seq     bigserial PRIMARY KEY,
  id      text NOT NULL,
  ts      timestamptz NOT NULL,
  op      text NOT NULL,
  status  text NOT NULL,
  actor   text,
  version text,
  details jsonb,
  error   text
);
CREATE INDEX maintenance_audit_ts_idx ON maintenance_audit (ts DESC);
`;
