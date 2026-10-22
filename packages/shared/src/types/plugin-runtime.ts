/**
 * PROP-090 §5: runtime-override включений/настроек плагинов (`plugins.json`).
 *
 * Файл лежит рядом с lock-файлом в раскладке `<home>/plugin/` (без home —
 * `{dataDir}/plugin/`) и хранит **per-plugin** переопределения: включён ли
 * плагин и его произвольные настройки. Инстансные политики слоя плагинов
 * (`plugins.enabled`/`trustFloor`/`scan`/…) живут отдельно — в runtime-настройках
 * (`RuntimeSettings.plugins`, `{dataDir}/settings.json`).
 */

/** Переопределение конкретного плагина (runtime). */
export interface PluginRuntimeOverride {
  /** Включён ли плагин (`false` — выключен владельцем). */
  enabled?: boolean;
  /** Произвольные настройки плагина (схема — на стороне плагина). */
  settings?: Record<string, unknown>;
}

/** Формат файла `plugins.json`. */
export interface PluginSettingsFile {
  /** Версия формата (сейчас `1`). */
  version: number;
  /** Переопределения по имени плагина. */
  plugins: Record<string, PluginRuntimeOverride>;
}

/** Текущая версия формата `plugins.json`. */
export const PLUGIN_SETTINGS_FILE_VERSION = 1;
