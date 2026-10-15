import type { EventJournalRepository } from '../../storage/ports/event-journal-repository.js';

export interface EventJournalPrunerOptions {
  /** Текущий срок хранения журнала в днях (<= 0 — prune пропускается). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * ADR-089: периодическая retention-очистка журнала событий.
 *
 * Сразу при старте выполняет `prune`, затем повторяет его каждые `intervalMs`
 * (по умолчанию 6 ч; таймер `unref`, не держит процесс). Если `retentionDays <= 0`
 * — prune пропускается (безлимитное хранение). Ошибки логируются `console.warn`
 * и не роняют процесс. Возвращает stop-функцию (остановка таймера).
 */
export function startEventJournalPruner(
  journal: EventJournalRepository,
  opts: EventJournalPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = async (): Promise<void> => {
    try {
      const days = opts.getRetentionDays();
      if (!Number.isFinite(days) || days <= 0) return;
      await journal.prune(days);
    } catch (err) {
      console.warn(
        `[EventJournalPruner] prune журнала не удался: ${err instanceof Error ? err.message : String(err)}`,
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
