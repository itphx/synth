/**
 * PROP-068 §4.3: кэш сканов.
 *
 * Ключ — `sha256(source\0source_url)` + `content_hash` (PROP-068 §4.3): повторный
 * скан **идентичного** содержимого не выполняется. Кэш **in-process**
 * (на инстанс): постоянное хранилище кэша — задача Ф5 (установщик), здесь
 * достаточно не сканировать один и тот же бандл дважды подряд.
 */
import { createHash } from 'node:crypto';

import type { PluginScanReport } from './scanner.js';

/** Кэш результатов скана (in-process, ограничен по размеру). */
export class PluginScanCache {
  private readonly _entries = new Map<string, PluginScanReport>();

  constructor(private readonly _maxEntries: number = 100) {}

  /**
   * Ключ записи кэша: источник + URL источника + content-hash содержимого.
   *
   * @param source источник установки (`npm`/`local`/`catalog`/…).
   * @param sourceUrl URL/идентификатор источника.
   * @param contentHash content-hash бандла.
   */
  static key(source: string, sourceUrl: string, contentHash: string): string {
    return createHash('sha256')
      .update(`${source}\0${sourceUrl}\0${contentHash}`, 'utf8')
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
