/**
 * GC осиротевших вложений (ADR-115 §«Хранение», ADR-116).
 *
 * Объект вложений content-addressed и разделяется между сообщениями (`дедуп`),
 * поэтому удалять его по «возрасту» нельзя: живой объект может быть старым.
 * Критерий — **нет ссылок** (`blob_refs`, `countRefs === 0`) **и** объект старше
 * `gcDays`. Ссылки снимаются при удалении сообщения/сессии; у объекта, чьё
 * сообщение удалено, ссылок не остаётся — он уходит после TTL.
 *
 * Sidecar (`<sha>.json`) удаляется вместе с объектом. Ошибки логируются и не
 * роняют процесс; таймер `unref` — процесс не держим (паттерн
 * `startEventJournalPruner`).
 */

import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { ATTACHMENT_DIR, ATTACHMENT_SIDECAR_SUFFIX } from './service.js';

export interface AttachmentPrunerOptions {
  blobs: BlobStore;
  blobRefs: BlobRefRepository;
  /** Срок хранения осиротевших объектов, дней (`<= 0` — без ограничения). */
  gcDays: number | (() => number);
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
  /** Лог предупреждений (по умолчанию `console.warn`). */
  log?: (message: string) => void;
  /** Источник времени (тесты); по умолчанию `Date.now`. */
  now?: () => number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * Запустить GC вложений: сразу при старте и далее каждые `intervalMs`.
 * Возвращает stop-функцию.
 */
export function startAttachmentPruner(opts: AttachmentPrunerOptions): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = opts.log ?? ((message) => console.warn(message));
  const now = opts.now ?? Date.now;

  const run = async (): Promise<void> => {
    try {
      const days = typeof opts.gcDays === 'function' ? opts.gcDays() : opts.gcDays;
      // `<= 0` — без ограничения: объекты не чистим по сроку.
      if (!Number.isFinite(days) || days <= 0) return;
      const cutoff = now() - days * 24 * 3600_000;

      const entries = await opts.blobs.list(ATTACHMENT_DIR);
      for (const entry of entries) {
        // Sidecar — не объект: удаляется вместе со своим объектом.
        if (entry.path.endsWith(ATTACHMENT_SIDECAR_SUFFIX)) continue;
        const refs = await opts.blobRefs.countRefs(entry.path);
        if (refs > 0) continue;
        const stat = await opts.blobs.stat(entry.path);
        if (!stat || stat.mtimeMs >= cutoff) continue;
        await opts.blobs.delete(entry.path);
        await opts.blobs.delete(`${entry.path}${ATTACHMENT_SIDECAR_SUFFIX}`);
      }
    } catch (err) {
      log(`[AttachmentPruner] GC вложений не удался: ${err instanceof Error ? err.message : String(err)}`);
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
