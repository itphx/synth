/**
 * Retention-очистка логов фоновых процессов (PROP-097).
 *
 * Логи процессов живут в blob-хранилище (`processes/<runId>.log`), а записи
 * прогона — в реестре фоновых прогонов. Обе сущности чистим по одному сроку
 * (`background.retentionDays`), но по отдельности: лог удаляется, когда его
 * запись реестра устарела, а запись — когда лог уже не нужен.
 *
 * По образцу `engine/background/prune.ts`: prune сразу при старте и далее
 * каждые `intervalMs` (по умолчанию 6 ч; таймер `unref` — процесс не держим).
 * Ошибки логируются `console.warn` и не роняют процесс.
 */
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import type { BackgroundRunRepository } from '../../storage/ports/background-run-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { PROCESS_LOG_DIR, processStreamLogPath } from '../background/service.js';

export interface ProcessLogPrunerOptions {
  /** Текущий срок хранения в днях (`<= 0` — по сроку не чистим). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * Все пути логов прогона: общий лог + файлы потоков.
 *
 * Разделение потоков (ADR-113) — у прогона **три** файла лога: общий
 * (`processes/<id>.log`) и по одному на поток (`processes/<id>.stdout.log` /
 * `.stderr.log`). Все три живут и умирают вместе с записью реестра.
 */
function logPathsOf(record: BackgroundRunRecord): string[] {
  const paths: string[] = [];
  if (record.logPath) paths.push(record.logPath);
  paths.push(processStreamLogPath(record.id, 'stdout'));
  paths.push(processStreamLogPath(record.id, 'stderr'));
  return paths;
}

/**
 * Запустить pruner логов фоновых процессов. Возвращает stop-функцию.
 *
 * Удаляются:
 * - логи терминальных прогонов, чья запись старше отсечки (все три файла:
 *   общий и файлы потоков);
 * - логи, на которые больше не ссылается ни одна запись реестра (запись уже
 *   очищена retention-ом — «сиротский» лог).
 */
export function startProcessLogPruner(
  repository: BackgroundRunRepository,
  blobs: BlobStore,
  opts: ProcessLogPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = async (): Promise<void> => {
    try {
      const days = opts.getRetentionDays();
      const cutoff = Number.isFinite(days) && days > 0
        ? Date.now() - days * 24 * 3600_000
        : null;

      const records = await repository.list({ kind: 'process' });
      const referenced = new Set<string>();
      for (const record of records) {
        const paths = logPathsOf(record);
        const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
        const expired = cutoff !== null && Number.isFinite(finishedAt) && finishedAt < cutoff;
        if (record.status !== 'running' && expired) {
          for (const path of paths) await blobs.delete(path);
          continue;
        }
        // Живая (не истёкшая) запись держит **все три** файла: иначе
        // «сиротская» очистка каталога снесла бы файлы потоков живого прогона.
        for (const path of paths) referenced.add(path);
      }

      // «Сиротские» логи: запись реестра уже очищена, а файл остался.
      const entries = await blobs.list(PROCESS_LOG_DIR);
      for (const entry of entries) {
        if (referenced.has(entry.path)) continue;
        await blobs.delete(entry.path);
      }
    } catch (err) {
      console.warn(
        `[ProcessLogPruner] очистка логов фоновых процессов не удалась: ${err instanceof Error ? err.message : String(err)}`,
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
