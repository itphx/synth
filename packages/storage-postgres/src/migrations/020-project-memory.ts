/**
 * Миграция 020_project_memory — политика памяти проекта (ADR-107).
 *
 * `memory jsonb` — `{enabled?: boolean}`: `false` выключает блоки и тулы
 * памяти для проекта, `undefined`/NULL — наследует политику инстанса
 * (сейчас — включено). Отдельная колонка, а не общий `settings`: порт
 * проекта типизирован, а `memory` читается composer'ом на каждом ходе.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`).
 */

export const MIGRATION_020_PROJECT_MEMORY = `
ALTER TABLE projects ADD COLUMN IF NOT EXISTS memory jsonb;
`;
