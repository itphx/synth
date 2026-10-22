/**
 * PROP-068 §4.3: кэш сканов.
 *
 * Ключ — `sha256(версия правил\0source\0source_url\0content_hash)`
 * (PROP-068 §4.3): повторный скан **идентичного** содержимого не выполняется.
 * **Версия правил входит в ключ** (`PLUGIN_SCAN_RULES_VERSION`): при изменении
 * правил сканера старый вердикт из кэша не переиспользуется — иначе бандл,
 * признанный безопасным по старым правилам, получил бы «зелёный» вердикт по
 * новым. Кэш **in-process** (на инстанс): постоянное хранилище кэша — задача
 * Ф5 (установщик), здесь достаточно не сканировать один и тот же бандл дважды
 * подряд.
 */
import { createHash } from 'node:crypto';

import { PLUGIN_SCAN_RULES_VERSION } from '@itphx/synth-shared';

import type { PluginScanReport } from './scanner.js';

/** Кэш результатов скана (in-process, ограничен по размеру). */
export class PluginScanCache {
  private readonly _entries = new Map<string, PluginScanReport>();

  constructor(private readonly _maxEntries: number = 100) {}

  /**
   * Ключ записи кэша: версия правил + источник + URL источника + content-hash.
   *
   * @param source источник установки (`npm`/`local`/`catalog`/…).
   * @param sourceUrl URL/идентификатор источника.
   * @param contentHash content-hash бандла.
   * @param rulesVersion версия правил сканера (по умолчанию — текущая).
   */
  static key(
    source: string,
    sourceUrl: string,
    contentHash: string,
    rulesVersion: string = PLUGIN_SCAN_RULES_VERSION,
  ): string {
    return createHash('sha256')
      .update(`${rulesVersion}\0${source}\0${sourceUrl}\0${contentHash}`, 'utf8')
      .digest('hex');
  }

  /** Отчёт по ключу (`undefined` — промах). */
  get(key: string): PluginScanReport | undefined {
    return this._entries.get(key);
  }

  /** Положить отчёт в кэш (лишние записи вытесняются — FIFO). */
  set(key: string, report: PluginScanReport): void {
    if (this._entries.has(key)) this._entries.delete(key);
    this._entries.set(key, report);
    while (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next();
      if (oldest.done) break;
      this._entries.delete(oldest.value);
    }
  }

  /** Число записей кэша. */
  get size(): number {
    return this._entries.size;
  }

  /** Очистить кэш. */
  clear(): void {
    this._entries.clear();
  }
}
