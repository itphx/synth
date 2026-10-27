/**
 * ADR-115: части сообщения для **live-события** (`message.added`,
 * `message.injected`).
 *
 * Зачем отдельный снимок: событие уходит в UI по шине/WS, и его размер важен —
 * байтов в частях нет (медиа-часть несёт только ссылку на blob), но текст
 * сообщения дублируется целиком. Поэтому строковые `data` обрезаются до того же
 * лимита, что и `content` события (500 символов), а медиа-части (объекты
 * `MediaPartData`) отдаются как есть — без них UI не покажет миниатюру до
 * перезагрузки страницы.
 */
import type { Part } from '@itphx/synth-shared';

/** Часть сообщения в payload live-события. */
export interface EventPartSnapshot {
  id: string;
  type: string;
  data: unknown;
}

/** Лимит строковой части по умолчанию — как у `content` в событии. */
export const DEFAULT_EVENT_PART_TEXT_LIMIT = 500;

/**
 * Обрезать строковое поле объекта (`tool_result`-подобные данные): сам объект
 * отдаётся поверхностной копией, вход не мутируется.
 */
function snapshotObjectData(data: Record<string, unknown>, limit: number): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...data };
  const content = copy.content;
  if (typeof content === 'string' && content.length > limit) {
    copy.content = content.slice(0, limit);
  }
  return copy;
}

/**
 * Части сообщения для live-события: медиа-части как есть, строковые — с лимитом.
 *
 * @param parts части сообщения (`Message.parts`)
 * @param opts.textLimit лимит символов для строковых данных (по умолчанию 500)
 * @returns `undefined`, если частей нет; иначе — массив снимков (вход не мутируется)
 */
export function snapshotPartsForEvent(
  parts: readonly Part[] | undefined,
  opts?: { textLimit?: number },
): EventPartSnapshot[] | undefined {
  if (!parts || parts.length === 0) return undefined;

  const rawLimit = opts?.textLimit ?? DEFAULT_EVENT_PART_TEXT_LIMIT;
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.trunc(rawLimit)) : DEFAULT_EVENT_PART_TEXT_LIMIT;

  const snapshots: EventPartSnapshot[] = [];
  for (const part of parts) {
    // Части без id/type бессмысленны в событии — UI не сможет их отрисовать.
    if (!part || typeof part.id !== 'string' || !part.id) continue;
    if (typeof part.type !== 'string' || !part.type) continue;

    let data: unknown = part.data;
    if (typeof data === 'string') {
      if (data.length > limit) data = data.slice(0, limit);
    } else if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Объект — медиа-часть (`MediaPartData`) или `tool_result`: отдаём
      // поверхностной копией (массивы — не наш формат, оставляем как есть).
      data = snapshotObjectData(data as Record<string, unknown>, limit);
    }

    snapshots.push({ id: part.id, type: part.type, data });
  }

  return snapshots.length > 0 ? snapshots : undefined;
}
