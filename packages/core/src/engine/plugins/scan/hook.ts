/**
 * ADR-090: дефолтная реализация seam'а `PluginScanHook` — встроенный
 * статический сканер (`scan/scanner.ts`).
 *
 * Хук умеет сканировать два вида бандла:
 * - **каталог** (`descriptor.rootDir` — распакованный бандл, ADR-090);
 * - **карту файлов** (`descriptor.files` — тот же бандл в памяти).
 *
 * Если сканировать нечего (ни каталога, ни файлов) — хук возвращает
 * `performed: false` и вердикт `safe` по умолчанию: по журналу аудита видно,
 * что скана не было (в установщике Ф5 каталог передаётся обязательно).
 */
import type { PluginScanQuotas } from '@itphx/synth-shared';

import type { PluginScanHook, PluginScanResult } from '../activation.js';
import { PluginScanCache } from './cache.js';
import { scanPluginDirectory, scanPluginFiles } from './scanner.js';
import type { PluginScanOptions } from './scanner.js';

/** Опции дефолтного скана. */
export interface PluginScanHookOptions {
  /** Словарь системных словарей — детектор prompt-injection. */
  dictionaryStore?: PluginScanOptions['dictionaryStore'];
  /** Язык словаря (по умолчанию `ru`). */
  lang?: string;
  /** Кэш сканов (in-process; по умолчанию — общий на хук). */
  cache?: PluginScanCache;
  /** Переопределение квот (тесты/инстанс). */
  quotas?: Partial<PluginScanQuotas>;
  /** Источник установки (по умолчанию — из дескриптора). */
  source?: string;
  /** URL источника (по умолчанию — из дескриптора). */
  sourceUrl?: string;
}

/**
 * Создать дефолтный хук скана (встроенный сканер).
 *
 * Кэш по умолчанию — свой на хук (один инстанс сканера = один кэш).
 */
export function createPluginScanHook(opts: PluginScanHookOptions = {}): PluginScanHook {
  const cache = opts.cache ?? new PluginScanCache();
  return async (descriptor): Promise<PluginScanResult> => {
    const scanOptions: PluginScanOptions = {
      ...(opts.dictionaryStore ? { dictionaryStore: opts.dictionaryStore } : {}),
      ...(opts.lang ? { lang: opts.lang } : {}),
      cache,
      ...(opts.quotas ? { quotas: opts.quotas } : {}),
      source: opts.source ?? descriptor.source ?? '',
      sourceUrl: opts.sourceUrl ?? descriptor.sourceUrl ?? '',
    };

    if (descriptor.rootDir) {
      return await scanPluginDirectory(descriptor.rootDir, scanOptions);
    }
    if (descriptor.files) {
      return scanPluginFiles(descriptor.files, scanOptions);
    }
    return {
      verdict: 'safe',
      performed: false,
      findings: [],
      reason: 'Сканировать нечего: не передан ни каталог бандла, ни его файлы.',
    };
  };
}
