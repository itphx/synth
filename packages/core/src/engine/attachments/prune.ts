/**
 * GC вложений (ADR-115 §«Хранение», ADR-116).
 *
 * ## Что чистим
 *
 *  1. **Осиротевшие объекты** — content-addressed объекты делятся между
 *     сообщениями (`дедуп`), поэтому удалять их по «возрасту» нельзя: живой
 *     объект может быть старым. Критерий — **нет ссылок** (`blob_refs`,
 *     `countRefs === 0`) **и** объект старше `gcDays`. Ссылки снимаются при
 *     удалении сообщения/сессии; у объекта, чьё сообщение удалено, ссылок не
 *     остаётся — он уходит после TTL. Sidecar (`<sha>.json`) удаляется вместе
 *     с объектом.
 *  2. **Кэши обработки** — `attachments/.thumbs/` (миниатюры) и
 *     `attachments/.derived/` (производные объекты/кэш aux-вызовов, включая
 *     сжатые копии). Это **регенерируемые** производные: ссылок `blob_refs` у
 *     них нет, но удалять их как сироты нельзя — иначе кэш растёт бесконечно.
 *     Чистим по `gcDays` (mtime файла), без проверки ссылок; `gcDays <= 0` —
 *     кэши не трогаем (срок не задан — не выбрасываем).
 *  3. **Временные объекты незавершённых загрузок** — `attachments/.uploads/`
 *     (chunked-протокол, ADR-115 §B2a). Это temp незавершённой загрузки: срок
 *     у него **свой** (`UPLOAD_SESSION_TTL_MS`, 1 ч) и он **не зависит** от
 *     `gcDays` — иначе при `gcDays = 0` незакрытые загрузки копились бы
 *     бесконечно. Сессия загрузки живёт в памяти процесса; после её смерти
 *     объект осиротеет, но ленивая уборка (`UploadSessionStore.pruneExpired`)
 *     срабатывает только при активности протокола.
 *
 * Ошибки логируются и не роняют процесс; таймер `unref` — процесс не держим
 * (паттерн `startEventJournalPruner`).
 */

import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import {
  getAttachmentMetricsHook,
  type AttachmentMetricsHooks,
} from '../../metrics/collectors/attachments.js';
import { ATTACHMENT_DIR, ATTACHMENT_SIDECAR_SUFFIX, ATTACHMENT_UPLOAD_DIR } from './service.js';
import { DERIVE_CACHE_DIR } from './derive.js';
import { THUMBNAIL_DIR } from './thumbnails.js';
import { UPLOAD_SESSION_TTL_MS } from './uploads.js';

/**
 * Служебные подкаталоги **кэшей** (производные объекты и миниатюры).
 *
 * У них нет `blob_refs`: удалять их как сироты нельзя, но и копить вечно —
 * тоже нельзя. Чистим по `gcDays` (mtime), регенерируются автоматически.
 */
const CACHE_SUBDIRS = [`${THUMBNAIL_DIR}/`, `${DERIVE_CACHE_DIR}/`] as const;

/** Префикс временных объектов chunked-загрузок (`attachments/.uploads/`). */
const UPLOAD_PREFIX = `${ATTACHMENT_UPLOAD_DIR}/`;

export interface AttachmentPrunerOptions {
  blobs: BlobStore;
  blobRefs: BlobRefRepository;
  /** Срок хранения осиротевших объектов и кэшей, дней (`<= 0` — без ограничения). */
  gcDays: number | (() => number);
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
  /** Лог предупреждений (по умолчанию `console.warn`). */
  log?: (message: string) => void;
  /** Источник времени (тесты); по умолчанию `Date.now`. */
  now?: () => number;
  /**
   * ADR-094: метрики вложений (`synth_attachment_gc_removed_total`). Не задан —
   * модульный sink (`getAttachmentMetricsHook`); выключенные метрики — no-op.
   */
  metrics?: AttachmentMetricsHooks;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/** Удалить объект старше отсечки; `true` — удалён. */
async function removeOlderThan(
  blobs: BlobStore,
  path: string,
  cutoff: number,
): Promise<boolean> {
  const stat = await blobs.stat(path);
  if (!stat || stat.mtimeMs >= cutoff) return false;
  await blobs.delete(path);
  return true;
}

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
      // `<= 0` — без ограничения: объекты и кэши не чистим по сроку.
      const gcCutoff =
        Number.isFinite(days) && days > 0 ? now() - days * 24 * 3600_000 : null;
      // Временные объекты загрузок — свой TTL (1 ч), независимо от `gcDays`.
      const uploadCutoff = now() - UPLOAD_SESSION_TTL_MS;

      const entries = await opts.blobs.list(ATTACHMENT_DIR);
      let removed = 0;
      for (const entry of entries) {
        try {
          // 1. Временные объекты chunked-загрузок: temp незавершённой
          //    загрузки, TTL 1 ч (не `gcDays`), ссылок нет.
          if (entry.path.startsWith(UPLOAD_PREFIX)) {
            if (await removeOlderThan(opts.blobs, entry.path, uploadCutoff)) removed++;
            continue;
          }
          // 2. Кэши обработки (`.thumbs`, `.derived`): регенерируемые, чистим
          //    по `gcDays` (mtime) без проверки ссылок.
          if (CACHE_SUBDIRS.some((prefix) => entry.path.startsWith(prefix))) {
            if (gcCutoff === null) continue;
            if (await removeOlderThan(opts.blobs, entry.path, gcCutoff)) removed++;
            continue;
          }
          // 3. Sidecar — не объект: удаляется вместе со своим объектом.
          if (entry.path.endsWith(ATTACHMENT_SIDECAR_SUFFIX)) continue;
          // 4. Обычный объект: сирота (нет ссылок) И старше `gcDays`.
          if (gcCutoff === null) continue;
          const refs = await opts.blobRefs.countRefs(entry.path);
          if (refs > 0) continue;
          const stat = await opts.blobs.stat(entry.path);
          if (!stat || stat.mtimeMs >= gcCutoff) continue;
          await opts.blobs.delete(entry.path);
          await opts.blobs.delete(`${entry.path}${ATTACHMENT_SIDECAR_SUFFIX}`);
          removed++;
        } catch (err) {
          // Один битый объект не должен останавливать уборку остальных.
          log(
            `[AttachmentPruner] объект не обработан (${entry.path}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // ADR-094: счётчик удалённых GC объектов (ошибка метрик не ломает GC).
      if (removed > 0) {
        try {
          (opts.metrics ?? getAttachmentMetricsHook())?.onGcRemoved(removed);
        } catch (err) {
          log(
            `[AttachmentPruner] метрика GC не записана: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
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
