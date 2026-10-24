/**
 * ADR-090 (WP-F): чтение собственных настроек плагина (`facade.getSettings`).
 *
 * Источник — **запись своего плагина** в `plugins.json`
 * (`PluginLayout.settingsPath`): `plugins[<имя плагина>].settings`
 * (`PluginRuntimeOverride`, ADR-090). Имя плагина задаёт хост (из активации),
 * а не плагин: настройки чужого плагина не видны.
 *
 * **Только чтение.** Writer'а per-plugin настроек сегодня нет (нет и API
 * изменения) — поэтому и события изменения не вводим: мёртвый API не плодим.
 * Файл маленький, поэтому снимок читается на **каждый** вызов — изменения
 * видны без рестарта. Влияние на уже активированные регистрации — на
 * усмотрение плагина.
 *
 * Атомарность записи не важна: читаемый снимок либо целый, либо
 * нечитаемый — в последнем случае настроек просто нет (`{}`).
 */
import { readFileSync } from 'node:fs';

import type { PluginSettingsFile } from '@itphx/synth-shared';

import type { PluginSettingsReader } from './activation.js';

/** Параметры ридера настроек плагинов. */
export interface PluginSettingsReaderOptions {
  /** Путь к файлу `plugins.json` (`PluginLayout.settingsPath`). */
  path: string;
}

/**
 * Собрать ридер настроек плагинов по файлу `plugins.json`.
 *
 * Любая ошибка (нет файла, битый JSON, неожиданная структура) — **пустые
 * настройки** (`{}`), а не исключение: сервис настроек не должен ломать
 * активацию плагина.
 */
export function createPluginSettingsReader(
  options: PluginSettingsReaderOptions,
): PluginSettingsReader {
  return (plugin: string): Record<string, unknown> => {
    let raw: string;
    try {
      raw = readFileSync(options.path, 'utf-8');
    } catch {
      return {};
    }
    let parsed: PluginSettingsFile;
    try {
      parsed = JSON.parse(raw) as PluginSettingsFile;
    } catch {
      return {};
    }
    const settings = parsed?.plugins?.[plugin]?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {};
    }
    // Копия + заморозка: плагин не может изменить снимок чужого вызова.
    return Object.freeze({ ...settings });
  };
}
