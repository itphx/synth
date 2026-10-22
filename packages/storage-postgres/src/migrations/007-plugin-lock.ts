/**
 * Миграция 007_plugin_lock — lock-файл плагинов (PROP-068 §4.4 / PROP-090 §5).
 *
 * Lock — **источник истины** для update/uninstall: по строке известны
 * источник, pin (`ref`), content-hash, уровень доверия и вердикт скана.
 * Ключ — имя плагина (уникально в инстансе), поэтому upsert — `ON CONFLICT`.
 *
 * Миграция идемпотентна (`IF NOT EXISTS`) — повторное применение безопасно.
 */

export const MIGRATION_007_PLUGIN_LOCK = `
-- Lock-файл плагинов: провенанс установки (источник истины для update/uninstall).
CREATE TABLE IF NOT EXISTS plugin_lock (
  name          text PRIMARY KEY,
  version       text NOT NULL,
  source        text NOT NULL,
  identifier    text,
  trust_level   text NOT NULL,
  scan_verdict  text NOT NULL,
  content_hash  text NOT NULL,
  ref           text,
  entry         text,
  installed_at  timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
`;
