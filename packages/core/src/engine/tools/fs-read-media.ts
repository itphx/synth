/**
 * ADR-115: приём изображения/PDF в `read_file` как вложения текущего хода.
 *
 * ## Зачем
 *
 * `read_file` читает файл как UTF-8: картинку или PDF так не прочитать. Раньше
 * тул отказывал с подсказкой «используй `attach_workspace_file`» — модель
 * тратила лишний шаг (часто цикл: привязать → отброшено → привязать). По
 * образцу opencode бинарный файл-картинка отдаётся **в текущий ход**: тул
 * возвращает ссылку (`ToolResult.attachments`), оркестратор вставляет
 * медиа-часть в `currentMessages` следующей итерации того же хода
 * (`_injectToolAttachments`, ADR-115 §«Медиа из инструментов»).
 *
 * ## Границы
 *
 * - **Только image/* и application/pdf.** SVG сервис вложений запрещает
 *   всегда (XSS) — он остаётся текстом (файл читается как раньше). Прочие
 *   бинари (аудио/видео/архивы) — прежнее поведение: отказ с подсказкой.
 * - **Байты — только через `AttachmentService.upload`** (ADR-115): MIME по
 *   сигнатуре, лимиты `attachments.*` и allowlist — в сервисе; второй политики
 *   лимитов здесь не заводим.
 * - **Отказ — не падение.** Вложения выключены (или сервиса нет) → прежняя
 *   ошибка `read_file` с подсказкой; превышение лимита и запрещённый MIME →
 *   понятная ошибка с причиной (`attach.tool.too_large` /
 *   `attach.tool.unsupported_mime`).
 * - **Containment — как у `read_file`**: периметр определяет permission-слой
 *   (`external_directory`), сам тул путей не ужесточает.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  attachmentsConfigSchema,
  type AttachmentsConfig,
  type ToolAttachmentRef,
  type ToolContext,
} from '@itphx/synth-shared';
import { AttachmentError, type AttachmentService } from '../attachments/service.js';

/**
 * Зависимости из `ToolContext.extra` (упаковка — оркестратор, тот же объект,
 * что у `attach_workspace_file`/`send_attachment`/`web_fetch`).
 *
 * - `attachmentService` — сервис вложений (ADR-115): единственная точка записи
 *   байтов. Не задан — приём недоступен (прежнее поведение `read_file`).
 * - `attachmentsConfig` — live-конфиг `attachments.*` (резолвер): ранние
 *   проверки (`enabled`, `maxBytesPerFile`) **до** чтения файла. Не задан —
 *   дефолты схемы (как у сервиса без runtime-настроек).
 */
export interface ReadFileMediaExtra {
  attachmentService?: AttachmentService;
  attachmentsConfig?: () => AttachmentsConfig;
}

/**
 * MIME, который `read_file` умеет отдать модели как вложение.
 *
 * SVG исключён: сервис вложений запрещает его всегда (XSS при инлайн-выдаче),
 * а файл остаётся текстом — прежнее поведение.
 */
export function isIngestibleMediaMime(mime: string): boolean {
  if (mime === 'image/svg+xml') return false;
  if (mime.startsWith('image/')) return true;
  return mime === 'application/pdf';
}

/** Итог приёма медиа-файла: ссылка (успех) или причина отказа. */
export type MediaIngestOutcome =
  | {
      kind: 'attached';
      ref: ToolAttachmentRef;
      mime: string;
      size: number;
      name?: string;
    }
  | { kind: 'refused'; reason: 'disabled' | 'unreadable' }
  | { kind: 'refused'; reason: 'too_large'; limit: number }
  | { kind: 'refused'; reason: 'unsupported_mime'; detail: string };

/**
 * Загрузить медиа-файл в blob-хранилище и вернуть ссылку для текущего хода.
 *
 * Порядок: сервис → мастер-выключатель → размер по `stat` (до чтения) →
 * чтение байтов → `AttachmentService.upload` (повторно проверяет размер, MIME
 * по сигнатуре, модальности и allowlist). Отказ сервиса — не исключение, а
 * причина (`AttachmentError`).
 */
export async function ingestMediaFile(args: {
  ctx: ToolContext;
  /** Абсолютный путь файла (уже разрешённый и проверенный на периметр). */
  resolvedPath: string;
  /** Размер файла по `stat` (байт). */
  size: number;
}): Promise<MediaIngestOutcome> {
  const extra = args.ctx.extra as ReadFileMediaExtra | undefined;
  const service = extra?.attachmentService;
  // Сервиса нет — приём недоступен: прежнее поведение `read_file`.
  if (!service) return { kind: 'refused', reason: 'disabled' };
  const config = extra?.attachmentsConfig?.() ?? attachmentsConfigSchema.parse({});
  if (!config.enabled) return { kind: 'refused', reason: 'disabled' };
  // Размер — по `stat`, до чтения: гигабайтный файл в память не тянем.
  if (args.size > config.maxBytesPerFile) {
    return { kind: 'refused', reason: 'too_large', limit: config.maxBytesPerFile };
  }

  const name = basename(args.resolvedPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(args.resolvedPath);
  } catch {
    // Файл прочитан не удалось (удалили/нет прав) — приём не состоялся.
    return { kind: 'refused', reason: 'unreadable' };
  }

  try {
    const meta = await service.upload({ sessionId: args.ctx.sessionId, bytes, name });
    const ref: ToolAttachmentRef = {
      blobPath: meta.blobPath,
      sha256: meta.sha256,
      mime: meta.mime,
      size: meta.size,
      ...(meta.name ? { name: meta.name } : {}),
    };
    return { kind: 'attached', ref, mime: meta.mime, size: meta.size, ...(meta.name ? { name: meta.name } : {}) };
  } catch (err) {
    if (err instanceof AttachmentError) {
      if (err.code === 'attachments_disabled') return { kind: 'refused', reason: 'disabled' };
      if (err.code === 'too_large') {
        return { kind: 'refused', reason: 'too_large', limit: config.maxBytesPerFile };
      }
      return { kind: 'refused', reason: 'unsupported_mime', detail: err.message };
    }
    throw err;
  }
}
