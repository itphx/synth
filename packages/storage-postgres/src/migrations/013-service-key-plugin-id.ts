/**
 * Миграция 013_service_key_plugin_id — привязка service-key к плагину
 * (PROP-090 Ф7, Уровень 2: server-scoped токены).
 *
 * `plugin_id` — имя плагина, которому выдан ключ. Ключ с привязкой сервер
 * принимает только с заголовком `X-Synth-Plugin-Id` и тем же значением, со
 * scope `plugins:invoke` и (при `plugins.hybrid.mode='allowlist'`) с именем
 * плагина в серверном allow-list.
 *
 * Колонка **внутренняя**: публичный контракт `/api/v2/service-keys` не
 * меняется (ADR-052) — привязка видна только в enforcement-контексте.
 *
 * У ключа, выданного обычным путём, колонка `NULL` (в домене поля нет).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_013_SERVICE_KEY_PLUGIN_ID = `
-- Привязка service-key к плагину (server-scoped токен, PROP-090 Ф7).
ALTER TABLE service_keys ADD COLUMN IF NOT EXISTS plugin_id text;
`;
