/**
 * Миграция 009_plugin_lock_previous — ступень отката в lock-файле плагинов
 * (PROP-090 §«Запись lock», долги Д2).
 *
 * `previous jsonb` — предыдущая установленная версия (`version`,
 * `content_hash`, `entry?`, `installed_at`). Хранится **ровно одна** ступень:
 * обновление перезаписывает её, откат меняет местами текущую и предыдущую.
 * У записи, поставленной обычной установкой, колонка `NULL` (поле в домене
 * отсутствует, а не `null`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_009_PLUGIN_LOCK_PREVIOUS = `
-- Ступень отката: предыдущая версия плагина (одна, jsonb).
ALTER TABLE plugin_lock ADD COLUMN IF NOT EXISTS previous jsonb;
`;
