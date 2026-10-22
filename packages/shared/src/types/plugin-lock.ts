/**
 * PROP-068 §4.4 / PROP-090 §5: запись lock-файла плагинов (`plugins.lock.json`).
 *
 * **Источник истины для update/uninstall** (PROP-068 §4.4). Pin обязателен:
 * `ref` (sha/тег) + `content_hash`; автоматического «взять latest» нет —
 * update только явной операцией.
 *
 * Имена полей — snake_case (как в модели `lock.json` из PROP-068 §4.4).
 */
import type { PluginScanVerdict } from './plugin-audit.js';
import type { CatalogTrustLevel } from './trust.js';

/** Запись lock-файла плагинов. */
export interface PluginLockEntry {
  /** Имя плагина (из манифеста `synth.pack`). */
  name: string;
  /** Версия плагина (semver). */
  version: string;
  /** Источник установки (`npm`/`local`/`catalog`/`builtin`/…). */
  source: string;
  /** Идентификатор источника (`owner/repo`, URL, npm-пакет…). */
  identifier?: string;
  /** Фактический уровень доверия (резолвится по источнику, не по манифесту). */
  trust_level: CatalogTrustLevel;
  /** Вердикт последнего скана. */
  scan_verdict: PluginScanVerdict;
  /** Content-hash бандла (sha256 от отсортированного набора файлов). */
  content_hash: string;
  /** Pin: sha/тег источника. */
  ref?: string;
  /** Точка входа бандла (например `dist/index.js`). */
  entry?: string;
  /** ISO-время установки. */
  installed_at: string;
  /** ISO-время последней записи. */
  updated_at: string;
}

/** Формат файла `plugins.lock.json` (общий формат JSON-коллекций слоя хранения). */
export interface PluginLockFile {
  /** Версия схемы файла (на будущее — миграции хранилища, ADR-092). */
  schemaVersion: number;
  /** Записи установленных плагинов. */
  plugins: PluginLockEntry[];
}
