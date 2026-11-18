/**
 * Retention-очистка логов фоновых процессов (PROP-097).
 *
 * Логи процессов живут в blob-хранилище (`processes/<runId>.log`), а записи
 * прогона — в реестре фоновых прогонов. Обе сущности чистим по одному сроку
 * (`background.retentionDays`), но по отдельности: лог удаляется, когда его
 * запись реестра устарела, а запись — когда лог уже не нужен.
 *
 * Отдельный класс — **живые** логи foreground-команд (`processes/live/…`,
 * ADR-113 §detach): до перевода в фон записи реестра у них нет, поэтому
 * «сиротское» правило каталога прогонов к ним неприменимо — оно снесло бы лог
 * идущей команды. Их правило: не упомянут ни одной живой записью **и** старше
 * `LIVE_LOG_ORPHAN_TTL_MS`.
 *
 * По образцу `engine/background/prune.ts`: prune сразу при старте и далее
 * каждые `intervalMs` (по умолчанию 6 ч; таймер `unref` — процесс не держим).
 * Ошибки логируются `console.warn` и не роняют процесс.
 */
import type { BackgroundRunRecord } from '@itphx/synth-shared';
import type { BackgroundRunRepository } from '../../storage/ports/background-run-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { PROCESS_LOG_DIR, processStreamLogPath } from '../background/service.js';
import { LIVE_LOG_DIR, LIVE_LOG_ORPHAN_TTL_MS } from './types.js';

export interface ProcessLogPrunerOptions {
  /** Текущий срок хранения в днях (`<= 0` — по сроку не чистим). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
  /**
   * Срок жизни «сиротского» live-лога, мс (по умолчанию час).
   *
   * Нужен тестам и тонкой настройке: процесс мог упасть, не удалив лог, но
   * молодой файл может принадлежать идущей команде.
   */
  liveLogTtlMs?: number;
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
 *   очищена retention-ом — «сиротский» лог);
 * - «сиротские» **живые** логи (`processes/live/…`): не упомянуты ни одной
 *   живой/неистёкшей записью **и** старше `liveLogTtlMs` (молодой файл может
 *   принадлежать идущей foreground-команде — записи реестра у неё ещё нет).
 */
export function startProcessLogPruner(
  repository: BackgroundRunRepository,
  blobs: BlobStore,
  opts: ProcessLogPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const liveLogTtlMs = opts.liveLogTtlMs ?? LIVE_LOG_ORPHAN_TTL_MS;
  /** Префикс каталога живых логов (пути внутри него — отдельный класс). */
  const livePrefix = `${LIVE_LOG_DIR}/`;

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
        // Переведённый в фон прогон держит и свой live-лог (`record.logPath`).
        for (const path of paths) referenced.add(path);
      }

      // «Сиротские» логи прогонов: запись реестра уже очищена, а файл остался.
      // Живые логи — отдельный класс (ниже): у идущей команды записи может не
      // быть вовсе.
      const entries = await blobs.list(PROCESS_LOG_DIR);
      for (const entry of entries) {
        if (entry.path.startsWith(livePrefix)) continue;
        if (referenced.has(entry.path)) continue;
        await blobs.delete(entry.path);
      }

      // Живые логи: только «сироты по сроку». Ссылка записи реестра (прогон
      // переведён в фон) защищает файл безусловно; иначе — удаляем, если файл
      // старше `liveLogTtlMs` (процесс мог упасть, не удалив лог).
      const now = Date.now();
      const liveEntries = await blobs.list(LIVE_LOG_DIR);
      for (const entry of liveEntries) {
        if (entry.path === LIVE_LOG_DIR) continue;
        if (referenced.has(entry.path)) continue;
        const stat = await blobs.stat(entry.path);
        if (!stat) continue;
        if (now - stat.mtimeMs < liveLogTtlMs) continue;
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
