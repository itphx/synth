/**
 * PROP-068 §4.4 / ADR-090: запись lock-файла плагинов (`plugins.lock.json`).
 *
 * **Источник истины для update/uninstall** (PROP-068 §4.4). Pin обязателен:
 * `ref` (sha/тег) + `content_hash`; автоматического «взять latest» нет —
 * update только явной операцией.
 *
 * **Откат.** Update сохраняет предыдущую версию рядом (`previous`), а
 * `rollback` меняет местами текущую и предыдущую — ровно одна ступень, явная
 * операция (ADR-090).
 *
 * Имена полей — snake_case (как в модели `lock.json` из PROP-068 §4.4).
 */
import type { PluginScanVerdict } from './plugin-audit.js';
import type { PackPluginMode } from './pack.js';
import type { CatalogTrustLevel } from './trust.js';

/**
 * Предыдущая установленная версия плагина — **одна ступень** для отката
 * (`PluginInstaller.rollback`, ADR-090).
 *
 * Хранится только то, что нужно для отката: версия, content-hash, точка входа
 * и время установки. Источник/pin/доверие/вердикт скана — свойства плагина, а
 * не версии: они остаются в основной записи lock.
 *
 * **Откат — явная операция** (как и обновление): автоматического «предыдущая
 * версия подхватится сама» нет. Ступень ровно одна: следующее обновление
 * перезаписывает `previous`, поэтому «откат на две версии назад» — это два
 * последовательных `rollback`.
 */
export interface PluginLockPrevious {
  /** Версия, с которой был выполнен переход. */
  version: string;
  /** Content-hash этой версии (sha256 от отсортированного набора файлов). */
  content_hash: string;
  /** Точка входа бандла этой версии (например `dist/index.js`). */
  entry?: string;
  /** ISO-время установки этой версии. */
  installed_at: string;
}

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
  /**
   * Ф4б-2: режим исполнения из манифеста (`inline`/`remote`/`both`).
   *
   * Записывается установкой (эффективный режим: `mode` манифеста, иначе
   * `inline`). Активация выбирает транспорт по этому полю, а не перечитывая
   * манифест; у legacy-записей поле отсутствует — трактуется как `inline`.
   */
  mode?: PackPluginMode;
  /**
   * Ф4б-2: серверная точка входа удалённого плагина (`dist/server.js`).
   *
   * Пишется, если режим `remote`/`both` и файл есть в бандле. Именно её
   * запускает `PluginProcessManager`; в дескриптор активации попадает как
   * `remoteEntry`.
   */
  remote_entry?: string;
  /** ISO-время установки. */
  installed_at: string;
  /** ISO-время последней записи. */
  updated_at: string;
  /**
   * Предыдущая установленная версия (одна ступень — для `rollback`).
   *
   * Заполняется `PluginInstaller.update` (и переставляется `rollback` —
   * текущая версия становится предыдущей). У записи, поставленной обычной
   * установкой, поля нет.
   */
  previous?: PluginLockPrevious;
}

/** Формат файла `plugins.lock.json` (общий формат JSON-коллекций слоя хранения). */
export interface PluginLockFile {
  /** Версия схемы файла (на будущее — миграции хранилища, ADR-092). */
  schemaVersion: number;
  /** Записи установленных плагинов. */
  plugins: PluginLockEntry[];
}
