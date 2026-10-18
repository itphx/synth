/**
 * PROP-102 §8: retention-очистка суточных роллапов аналитики.
 *
 * По образцу `engine/events/journal-prune.ts`: прогон сразу при старте, затем
 * каждые `intervalMs` (по умолчанию 6 ч; таймер `unref`, процесс не держит).
 * `retentionDays <= 0` — хранение без ограничения (prune пропускается).
 * Граница — `utcDay(now - retentionDays * 24ч)`; удаляются бакеты строго
 * старше неё. Ошибки логируются и не роняют процесс.
 */

import type { AnalyticsRollupRepository } from '../storage/ports/index.js';
import { utcDay } from './service.js';

export interface AnalyticsRollupPrunerOptions {
  /** Текущий срок хранения роллапов в днях (<= 0 — prune пропускается). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
  /** Источник текущего времени (тесты); по умолчанию `new Date()`. */
  now?: () => Date;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Граница retention: сутки UTC, раньше которых бакеты удаляются.
 * `retentionDays <= 0` → `null` (без ограничения).
 */
export function analyticsRetentionCutoff(retentionDays: number, now: Date = new Date()): string | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return utcDay(new Date(now.getTime() - retentionDays * MS_PER_DAY));
}

/**
 * Запустить периодическую очистку роллапов. Возвращает stop-функцию
 * (остановка таймера; применяется на graceful shutdown).
 */
export function startAnalyticsRollupPruner(
  repo: AnalyticsRollupRepository,
  opts: AnalyticsRollupPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());

  const run = async (): Promise<void> => {
    try {
      const cutoff = analyticsRetentionCutoff(opts.getRetentionDays(), now());
      if (cutoff === null) return;
      await repo.prune(cutoff);
    } catch (err) {
      console.warn(
        `[AnalyticsRollupPruner] очистка роллапов не удалась: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
