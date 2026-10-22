/**
 * Миграция 010_plugin_lock_mode — режим исполнения плагина в lock-файле
 * (PROP-090 §«Два режима исполнения», Ф4б-2).
 *
 * `mode` — объявленный режим плагина (`inline` | `remote` | `both`): хост по нему
 * выбирает транспорт (код в процессе core или отдельный процесс на loopback).
 * `remote_entry` — точка входа удалённого процесса внутри бандла
 * (`dist/server.js`); заполняется только для режимов `remote`/`both`, если файл
 * реально есть в бандле.
 *
 * У записи, поставленной обычной (inline) установкой, обе колонки `NULL`
 * (в домене поля отсутствуют, а не `null`).
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_010_PLUGIN_LOCK_MODE = `
-- Режим исполнения плагина и точка входа удалённого процесса.
ALTER TABLE plugin_lock ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE plugin_lock ADD COLUMN IF NOT EXISTS remote_entry text;
`;
