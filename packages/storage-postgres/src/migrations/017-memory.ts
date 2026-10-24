/**
 * Миграция 017_memory — порты памяти: факты, индексы и чанки
 * (PROP-047 §2.1 «предпосылка A», ADR-096 — слой хранения).
 *
 * - `memory_facts` — утверждения с провенансом и жизненным циклом
 *   (`candidate`/`active`/`superseded`/`retracted`). Ключ — `id`; провенанс,
 *   история ревизий и метаданные — `jsonb` (структура принадлежит порту, схема
 *   БД её не дублирует).
 * - `memory_indexes` — заголовки индексов: поколение (`generation`),
 *   состояние (`state`), фингерпринт эмбеддинга и статистика корпуса.
 * - `memory_chunks` — чанки корпуса: вектор эмбеддинга хранится **в `jsonb`**,
 *   а не в `pgvector`: расширение `vector` в БД не установлено, а
 *   `CREATE EXTENSION` требует прав администратора (в драйвере такой DDL не
 *   допускается — миграция должна проходить на «голой» БД). ANN-поиск в порт
 *   не входит (PROP-047 §3) — retrieval целиком в плагине; при переходе на
 *   `pgvector` меняется только представление колонки.
 *
 * Ключи и индексы:
 * - `memory_facts.id` — первичный ключ (id факта уникален в инстансе);
 * - `memory_indexes.id` — первичный ключ;
 * - `memory_chunks` — составной первичный ключ `(index_id, generation, id)`:
 *   чанк уникален в пределах поколения индекса, а префикс ключа даёт
 *   уникальность в пределах `(index_id, generation)`;
 * - индексы по `namespace`/`project_id`/`user_id`/`status`/`kind` — под фильтры
 *   порта (`list`/`count`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_017_MEMORY = `
-- PROP-047: факты памяти (утверждения с провенансом и жизненным циклом).
CREATE TABLE IF NOT EXISTS memory_facts (
  id            text PRIMARY KEY,
  namespace     text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  text          text NOT NULL,
  kind          text NOT NULL,
  project_id    text,
  user_id       text,
  provenance    jsonb NOT NULL,
  confidence    double precision NOT NULL DEFAULT 0,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  valid_until   timestamptz,
  superseded_by text,
  revisions     jsonb,
  metadata      jsonb
);
CREATE INDEX IF NOT EXISTS memory_facts_namespace_idx ON memory_facts (namespace);
CREATE INDEX IF NOT EXISTS memory_facts_project_idx   ON memory_facts (project_id);
CREATE INDEX IF NOT EXISTS memory_facts_user_idx      ON memory_facts (user_id);
CREATE INDEX IF NOT EXISTS memory_facts_status_idx    ON memory_facts (status);
CREATE INDEX IF NOT EXISTS memory_facts_kind_idx      ON memory_facts (kind);
CREATE INDEX IF NOT EXISTS memory_facts_updated_idx   ON memory_facts (updated_at DESC, id);

-- PROP-047: заголовки индексов памяти (поколение, состояние, фингерпринт).
CREATE TABLE IF NOT EXISTS memory_indexes (
  id          text PRIMARY KEY,
  namespace   text NOT NULL,
  name        text NOT NULL,
  provider_id text NOT NULL,
  project_id  text,
  source      jsonb NOT NULL,
  state       text NOT NULL,
  generation  integer NOT NULL DEFAULT 0,
  fingerprint jsonb NOT NULL,
  stats       jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  error       text
);
CREATE INDEX IF NOT EXISTS memory_indexes_namespace_idx ON memory_indexes (namespace);
CREATE INDEX IF NOT EXISTS memory_indexes_project_idx   ON memory_indexes (project_id);
CREATE INDEX IF NOT EXISTS memory_indexes_provider_idx  ON memory_indexes (provider_id);
CREATE INDEX IF NOT EXISTS memory_indexes_state_idx     ON memory_indexes (state);
CREATE INDEX IF NOT EXISTS memory_indexes_updated_idx   ON memory_indexes (updated_at DESC, id);

-- PROP-047: чанки корпуса (вектор — jsonb, без pgvector).
CREATE TABLE IF NOT EXISTS memory_chunks (
  index_id             text NOT NULL,
  generation           integer NOT NULL,
  id                   text NOT NULL,
  document_id          text NOT NULL,
  ordinal              integer NOT NULL,
  text                 text NOT NULL,
  vector               jsonb,
  embedding_input_hash text,
  metadata             jsonb,
  PRIMARY KEY (index_id, generation, id)
);
CREATE INDEX IF NOT EXISTS memory_chunks_generation_idx
  ON memory_chunks (index_id, generation, document_id, ordinal);
CREATE INDEX IF NOT EXISTS memory_chunks_document_idx
  ON memory_chunks (index_id, document_id);
`;
