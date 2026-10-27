/**
 * ADR-115 §«Токены»: приблизительная оценка стоимости медиа-частей в токенах.
 *
 * Точных токенов по вложениям без токенизатора провайдера не получить, поэтому
 * здесь фиксированные эвристики **для бюджета промпта** (панель статистики и
 * предупреждение о заполненности контекстного окна), а не для биллинга.
 *
 * Значения намеренно консервативные (провайдеры считают изображение примерно
 * как 750–800 токенов, PDF — как несколько страниц текста):
 *  - изображение — 765 токенов;
 *  - PDF (`file` + `application/pdf`) — 1500 токенов;
 *  - аудио — `durationMs / 1000 * 10`, при неизвестной длительности — 200;
 *  - видео — 2000 токенов;
 *  - прочие файлы байтами провайдеру не уходят — 0.
 */

import type { Part } from '@itphx/synth-shared';

/** Оценка токенов одного изображения. */
export const IMAGE_TOKENS_ESTIMATE = 765;
/** Оценка токенов одного PDF-документа. */
export const PDF_TOKENS_ESTIMATE = 1500;
/** Оценка токенов одного видео. */
export const VIDEO_TOKENS_ESTIMATE = 2000;
/** Оценка аудио при неизвестной длительности. */
export const AUDIO_TOKENS_FALLBACK = 200;
/** Токенов аудио на секунду (10/с). */
export const AUDIO_TOKENS_PER_SECOND = 10;

/** MIME-тип медиа-части (если он записан в `data`). */
function partMime(part: Pick<Part, 'type' | 'data'>): string {
  const data = part.data as { mime?: unknown } | undefined;
  return typeof data?.mime === 'string' ? data.mime.toLowerCase() : '';
}

/** Длительность медиа-части в мс (если известна). */
function partDurationMs(part: Pick<Part, 'type' | 'data'>): number {
  const data = part.data as { durationMs?: unknown } | undefined;
  return typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs > 0
    ? data.durationMs
    : 0;
}

/**
 * Оценка токенов одной части сообщения.
 * Текстовые/служебные части — 0 (они считаются по символам отдельно).
 */
export function estimateMediaPartTokens(part: Pick<Part, 'type' | 'data'>): number {
  switch (part.type) {
    case 'image':
      return IMAGE_TOKENS_ESTIMATE;
    case 'video':
      return VIDEO_TOKENS_ESTIMATE;
    case 'audio': {
      const durationMs = partDurationMs(part);
      if (durationMs <= 0) return AUDIO_TOKENS_FALLBACK;
      return Math.ceil((durationMs / 1000) * AUDIO_TOKENS_PER_SECOND);
    }
    case 'file':
      return partMime(part) === 'application/pdf' ? PDF_TOKENS_ESTIMATE : 0;
    default:
      return 0;
  }
}

/** Суммарная оценка токенов медиа-частей сообщения. */
export function estimateMediaTokens(parts: readonly Part[] | undefined): number {
  if (!parts || parts.length === 0) return 0;
  let total = 0;
  for (const part of parts) total += estimateMediaPartTokens(part);
  return total;
}
