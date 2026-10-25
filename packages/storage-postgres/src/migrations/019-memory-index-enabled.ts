/**
 * Миграция 019_memory_index_enabled — переключатель индекса памяти.
 *
 * `enabled boolean` — используется ли индекс в recall/search (PROP-047 §2.1,
 * ADR-096). Дефолт `true` — историческое поведение: легаси-строки после
 * миграции читаются как включённые. Выключенный индекс остаётся в портале
 * (виден в списке), но не попадает в пригодные для recall.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_019_MEMORY_INDEX_ENABLED = `
-- Переключатель индекса памяти (используется в recall/search).
ALTER TABLE memory_indexes ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
`;
