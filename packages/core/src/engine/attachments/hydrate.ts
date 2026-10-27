/**
 * ADR-115 §«Провайдеры и gateway»: гидратация вложений сообщений.
 *
 * В истории сессии вложение — это **ссылка** на blob (`part.data.blobPath`),
 * байтов в сообщении нет (том, ADR-116). Провайдеру же нужны сами байты в
 * base64, поэтому прямо перед сборкой запроса ссылки превращаются в
 * `LLMAttachment[]` (`mime` + `name?` + `base64`).
 *
 * Правила:
 *  - сообщения сопоставляются с исходной историей **по индексу** (порядок
 *    тот же, что отфильтровал `sessionMessagesToLlm`);
 *  - вложения, модальность которых модель не принимает, не отправляются;
 *  - суммарный объём base64 ограничен (`MAX_ATTACHMENT_BASE64_BYTES`): при
 *    превышении отбрасываются **самые старые** вложения (с начала истории), а
 *    на сообщении остаётся пометка в `debug` — промпт не ломается;
 *  - ошибка чтения объекта → вложение пропускается (в `content` уже есть
 *    плейсхолдер `[image: …]`), ход не падает;
 *  - входные `messages` не мутируются — возвращаются новые объекты.
 */

import type { Readable } from 'node:stream';
import {
  attachmentsConfigSchema,
  MessageRole,
  type AttachmentModality,
  type MediaPartData,
  type Message,
} from '@itphx/synth-shared';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import {
  attachmentModalityOf,
  type LLMAttachment,
  type LLMMessage,
} from '../../providers/base.js';
import { AttachmentService } from './service.js';

/** Предел суммарного base64-объёма вложений в одном запросе (20 МиБ). */
export const MAX_ATTACHMENT_BASE64_BYTES = 20 * 1024 * 1024;

/** Метаданные вложения, нужные гидратации (без байтов). */
export interface HydrateAttachmentMeta {
  mime: string;
  size: number;
  sha256: string;
  name?: string;
}

/** Порты чтения вложений (в продакшне — поверх `AttachmentService`). */
export interface HydrateDeps {
  resolve(blobPath: string): Promise<HydrateAttachmentMeta | null>;
  read(blobPath: string): Promise<Buffer | null>;
}

/** Опции гидратации. */
export interface HydrateOptions {
  /**
   * Модальности модели (`resolveModelModalities`). Не задано — без фильтра
   * (отправляются все поддержанные типы).
   */
  modalities?: readonly AttachmentModality[];
  /** Предел суммарного base64 (по умолчанию `MAX_ATTACHMENT_BASE64_BYTES`). */
  maxTotalBase64Bytes?: number;
  /** Лог предупреждений (по умолчанию — молча). */
  log?: (message: string) => void;
}

/** Медиа-типы частей сообщения (только они несут вложение). */
const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'file']);

/** Вложение, отброшенное по лимиту объёма (пометка в `debug`). */
interface DroppedAttachment {
  mime: string;
  name?: string;
  sizeBytes: number;
  reason: 'limit';
}

/** Ссылка на вложение в истории сообщения. */
interface MediaPartRef {
  blobPath: string;
  mime: string;
  name?: string;
}

/**
 * Сообщения, которые `sessionMessagesToLlm` отдаёт модели (зеркало его
 * фильтра): по одному `LLMMessage` на каждое такое сообщение.
 */
function includedSourceMessages(source: readonly Message[]): Message[] {
  return source.filter((message) => {
    if (message.disabled || message.hidden) return false;
    if (message.role === MessageRole.INFO) return false;
    if (message.role === MessageRole.ASSISTANT && message.metadata?.status === 'error') return false;
    return true;
  });
}

/** Ссылки на вложения в частях сообщения (в порядке частей). */
function mediaPartRefs(message: Message): MediaPartRef[] {
  const parts = message.parts ?? [];
  const refs: MediaPartRef[] = [];
  for (const part of parts) {
    if (!MEDIA_PART_TYPES.has(part.type)) continue;
    const data = part.data as Partial<MediaPartData> | undefined;
    if (!data || typeof data.blobPath !== 'string' || typeof data.mime !== 'string') continue;
    refs.push({
      blobPath: data.blobPath,
      mime: data.mime,
      ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
    });
  }
  return refs;
}

/** Вложение проходит ли фильтр модальностей модели. */
function isModalityAllowed(mime: string, modalities: readonly AttachmentModality[] | undefined): boolean {
  const modality = attachmentModalityOf(mime);
  if (modality === null || modality === 'text') return false;
  if (!modalities) return true;
  return modalities.includes(modality);
}

/** Поток в буфер (порт `readStream` отдаёт `Readable`). */
async function readStreamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Гидратация вложений в истории запроса.
 *
 * @param messages уже собранные LLM-сообщения (`sessionMessagesToLlm`)
 * @param source   сообщения сессии в том же порядке (до маппинга)
 * @param deps     порты чтения blob-объектов
 * @param options  модальности модели и предел объёма
 */
export async function hydrateMessageAttachments(
  messages: LLMMessage[],
  source: readonly Message[],
  deps: HydrateDeps,
  options: HydrateOptions = {},
): Promise<LLMMessage[]> {
  const included = includedSourceMessages(source);
  const maxTotal = options.maxTotalBase64Bytes ?? MAX_ATTACHMENT_BASE64_BYTES;

  // 1. Читаем все допустимые вложения в хронологическом порядке.
  const candidates: Array<{ messageIndex: number; attachment: LLMAttachment; sizeBytes: number }> = [];
  const limit = Math.min(messages.length, included.length);
  for (let index = 0; index < limit; index++) {
    const refs = mediaPartRefs(included[index]!);
    if (refs.length === 0) continue;

    for (const ref of refs) {
      if (!isModalityAllowed(ref.mime, options.modalities)) continue;
      try {
        const meta = await deps.resolve(ref.blobPath);
        if (!meta) continue;
        if (!isModalityAllowed(meta.mime, options.modalities)) continue;
        const bytes = await deps.read(ref.blobPath);
        if (!bytes) continue;
        candidates.push({
          messageIndex: index,
          attachment: {
            mime: meta.mime,
            ...(meta.name ?? ref.name ? { name: meta.name ?? ref.name } : {}),
            base64: bytes.toString('base64'),
          },
          sizeBytes: meta.size > 0 ? meta.size : bytes.length,
        });
      } catch (err) {
        // Битый объект не должен ломать ход: плейсхолдер в `content` уже есть.
        options.log?.(
          `[attachments] не удалось прочитать вложение ${ref.blobPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (candidates.length === 0) return messages;

  // 2. Лимит объёма: отбрасываем самые старые вложения (с начала истории).
  const totalBase64 = candidates.reduce((sum, item) => sum + item.attachment.base64.length, 0);
  let droppedCount = 0;
  if (totalBase64 > maxTotal) {
    let remaining = totalBase64;
    while (droppedCount < candidates.length && remaining > maxTotal) {
      remaining -= candidates[droppedCount]!.attachment.base64.length;
      droppedCount += 1;
    }
  }

  // 3. Сборка результата без мутации входа.
  const attachmentsByMessage = new Map<number, LLMAttachment[]>();
  const droppedByMessage = new Map<number, DroppedAttachment[]>();

  candidates.forEach((candidate, position) => {
    if (position < droppedCount) {
      const list = droppedByMessage.get(candidate.messageIndex) ?? [];
      list.push({
        mime: candidate.attachment.mime,
        ...(candidate.attachment.name ? { name: candidate.attachment.name } : {}),
        sizeBytes: candidate.sizeBytes,
        reason: 'limit',
      });
      droppedByMessage.set(candidate.messageIndex, list);
      return;
    }
    const list = attachmentsByMessage.get(candidate.messageIndex) ?? [];
    list.push(candidate.attachment);
    attachmentsByMessage.set(candidate.messageIndex, list);
  });

  return messages.map((message, index) => {
    const attachments = attachmentsByMessage.get(index);
    const dropped = droppedByMessage.get(index);
    if ((!attachments || attachments.length === 0) && (!dropped || dropped.length === 0)) {
      return message;
    }

    const next: LLMMessage = { ...message };
    if (attachments && attachments.length > 0) next.attachments = attachments;
    if (dropped && dropped.length > 0) {
      const previous = Array.isArray(message.debug?.attachmentsDropped)
        ? (message.debug!.attachmentsDropped as DroppedAttachment[])
        : [];
      next.debug = {
        ...(message.debug ?? {}),
        attachmentsDropped: [...previous, ...dropped],
      };
    }
    return next;
  });
}

/**
 * `HydrateDeps` поверх порта blob-хранилища.
 *
 * Переиспользует `AttachmentService` (единственная точка чтения объектов
 * вложений: containment `attachments/`, sidecar-метаданные, фоллбек по сигнатуре).
 * Конфиг сервиса для чтения не используется — берутся дефолты схемы.
 */
export function createHydrateDeps(blobs: BlobStore): HydrateDeps {
  const service = new AttachmentService({
    blobs,
    config: attachmentsConfigSchema.parse({}),
  });
  return {
    resolve: async (blobPath) => {
      try {
        const resolved = await service.resolve(blobPath);
        if (!resolved) return null;
        return {
          mime: resolved.mime,
          size: resolved.size,
          sha256: resolved.sha256,
          ...(resolved.name ? { name: resolved.name } : {}),
        };
      } catch {
        return null;
      }
    },
    read: async (blobPath) => {
      try {
        const stream = await service.read(blobPath);
        if (!stream) return null;
        return await readStreamToBuffer(stream);
      } catch {
        return null;
      }
    },
  };
}
