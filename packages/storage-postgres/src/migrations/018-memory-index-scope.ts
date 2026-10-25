/**
 * Миграция 018_memory_index_scope — область видимости индекса памяти
 * (PROP-047 §2.1 «предпосылка A», ADR-096 — слой хранения).
 *
 * `scope text` — область видимости индекса: `project` (виден только своему
 * проекту) или `instance` (виден всем на инстансе). Дефолт — `project`:
 * это историческое поведение (индекс без области видимости виден своему
 * проекту), поэтому легаси-строки после миграции читаются ровно так же.
 *
 * Индекс под фильтр `scope` порта (`listIndexes`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_018_MEMORY_INDEX_SCOPE = `
-- Область видимости индекса памяти (проектный / общий на инстанс).
ALTER TABLE memory_indexes ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'project';
CREATE INDEX IF NOT EXISTS memory_indexes_scope_idx ON memory_indexes (scope);
`;
