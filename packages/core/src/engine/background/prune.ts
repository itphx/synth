/**
 * Retention-очистка записей реестра фоновых прогонов (этап 1 roadmap 0.13 —
 * блок 4).
 *
 * По образцу `engine/events/journal-prune.ts` и `engine/question/prune.ts`:
 * prune сразу при старте и далее каждые `intervalMs` (по умолчанию 6 ч; таймер
 * `unref` — процесс не держим). Удаляются только **терминальные** записи
 * (`completed`/`failed`/`cancelled`/`orphaned`), метка которых строго старше
 * отсечки (`background.retentionDays`).
 */
import type { BackgroundRunRepository } from '../../storage/ports/background-run-repository.js';

export interface BackgroundRunPrunerOptions {
  /** Текущий срок хранения в днях (`<= 0` — prune пропускается). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * Запустить pruner фоновых прогонов. Возвращает stop-функцию (остановка таймера).
 *
 * Ошибки очистки логируются `console.warn` и не роняют процесс.
 */
export function startBackgroundRunPruner(
  repository: BackgroundRunRepository,
  opts: BackgroundRunPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = async (): Promise<void> => {
    try {
      const days = opts.getRetentionDays();
      if (!Number.isFinite(days) || days <= 0) return;
      const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      await repository.prune(cutoff);
    } catch (err) {
      console.warn(
        `[BackgroundRunPruner] очистка реестра фоновых прогонов не удалась: ${err instanceof Error ? err.message : String(err)}`,
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
