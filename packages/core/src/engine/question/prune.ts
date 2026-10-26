/**
 * Retention-очистка записей вопросов (этап 1 roadmap 0.13 — блок 3).
 *
 * По образцу `engine/events/journal-prune.ts`: prune сразу при старте и далее
 * каждые `intervalMs` (по умолчанию 6 ч; таймер `unref` — процесс не держим).
 * Удаляются только **терминальные** записи (`answered`/`cancelled`), метка
 * которых строго старше отсечки (`questions.retentionDays`).
 */
import type { QuestionRepository } from '../../storage/ports/question-repository.js';

export interface QuestionPrunerOptions {
  /** Текущий срок хранения в днях (`<= 0` — prune пропускается). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * Запустить pruner вопросов. Возвращает stop-функцию (остановка таймера).
 *
 * Ошибки очистки логируются `console.warn` и не роняют процесс.
 */
export function startQuestionPruner(
  repository: QuestionRepository,
  opts: QuestionPrunerOptions,
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
        `[QuestionPruner] очистка вопросов не удалась: ${err instanceof Error ? err.message : String(err)}`,
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
