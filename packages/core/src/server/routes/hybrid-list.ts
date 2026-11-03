// Общие помощники гибридного merge-списков (локальный core + удалённый backend).
//
// Сквозная пагинация списка в гибриде: оба мира приводятся к общей форме,
// объединяются и сортируются **до** нарезки страницы — иначе порядок «новые
// сверху» ломался бы на границе миров, а курсор `next_offset` нельзя было бы
// выдать корректно.
//
// Форма записи merged-списка:
// - `origin` — источник (`local`/`remote`); удалённые id уже с префиксом
//   `remote:` (см. `remote/aggregate.ts`);
// - `time` — время записи (epoch ms) для сортировки: `updated_at` → `created_at`;
// - `value` — полезная нагрузка (локальная сущность или DTO удалённого мира).

import { toRemote } from '../../remote/aggregate.js';
import type { Origin } from '../../remote/types.js';

/** Запись объединённого списка миров. */
export interface HybridListEntry<T> {
  /** Мир-источник записи. */
  origin: Origin;
  /** id записи в merged-виде (удалённый — с префиксом `remote:`). */
  id: string;
  /** Время записи (epoch ms) — ключ сортировки. */
  time: number;
  /** Полезная нагрузка: локальная сущность или DTO удалённого мира. */
  value: T;
}

/** Epoch ms из ISO-строки (или числа); неразборное значение → 0. */
export function parseTimeMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Время DTO записи: `updated_at` → `created_at` → 0.
 * Поле времени может отсутствовать (старый сервер) — тогда запись уходит в конец.
 */
export function dtoTime(dto: Record<string, unknown>): number {
  return parseTimeMs(dto.updated_at) || parseTimeMs(dto.created_at);
}

/**
 * Локальные записи → записи merged-списка (`origin: 'local'`, id как есть).
 * Время берётся из полей сущности (`updatedAt`/`createdAt`).
 */
export function localEntries<T extends { id: string; updatedAt?: string; createdAt?: string }>(
  items: T[],
): HybridListEntry<T>[] {
  return items.map((item) => ({
    origin: 'local' as const,
    id: String(item.id),
    time: parseTimeMs(item.updatedAt) || parseTimeMs(item.createdAt),
    value: item,
  }));
}

/**
 * DTO удалённого мира → записи merged-списка (`origin: 'remote'`, id и
 * вложенные ссылки с префиксом `remote:`).
 */
export function remoteEntries(
  items: Array<Record<string, unknown>>,
): HybridListEntry<Record<string, unknown>>[] {
  return items.map((item) => {
    const value = toRemote(item);
    return {
      origin: 'remote' as const,
      id: String(value.id ?? ''),
      time: dtoTime(value),
      value,
    };
  });
}

/**
 * Стабильная сортировка merged-списка: новые сверху (по времени записи), при
 * равенстве времени — `origin` (`local` раньше `remote`), затем `id`.
 *
 * Порядок детерминирован: одинаковые по времени записи не «прыгают» между
 * страницами (курсор `offset` по merged-списку остаётся корректным).
 */
export function sortHybridList<T>(entries: HybridListEntry<T>[]): HybridListEntry<T>[] {
  return [...entries].sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    if (a.origin !== b.origin) return a.origin === 'local' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Нарезка страницы истории сообщений удалённой сессии.
 *
 * Старый удалённый сервер игнорирует `limit`/`before` и отдаёт **всю**
 * историю — тогда нарезка делается здесь, локально. Новый сервер отдаёт уже
 * готовую страницу: его `has_more`/`next_before` достовернее локальных
 * (сервер знает про более старые сообщения за пределами выборки), поэтому
 * при отсутствии локальной нарезки берутся именно они.
 *
 * - `messages` — DTO сообщений удалённого мира (в порядке сервера);
 * - `limit` — размер страницы;
 * - `before` — исключающий курсор по `seq` (сообщения строго старше);
 * - `serverHasMore`/`serverNextBefore` — метаданные удалённого сервера.
 *
 * Возвращает страницу в порядке сервера + признак «есть более старые» и
 * курсор следующей страницы.
 */
export function sliceRemoteMessages(
  messages: Array<Record<string, unknown>>,
  limit: number,
  before: number | undefined,
  serverHasMore: boolean | undefined,
  serverNextBefore: number | null | undefined,
): { page: Array<Record<string, unknown>>; hasMore: boolean; nextBefore: number | null } {
  // `seq` — позиционный порядок истории; `index` — запасной признак.
  const seqOf = (m: Record<string, unknown>, fallback: number): number => {
    if (typeof m.seq === 'number' && Number.isFinite(m.seq)) return m.seq;
    if (typeof m.index === 'number' && Number.isFinite(m.index)) return m.index;
    return fallback;
  };
  const indexed = messages.map((m, i) => ({ m, seq: seqOf(m, i) }));
  // Страховка от неотсортированного ответа: порядок — по возрастанию seq.
  indexed.sort((a, b) => a.seq - b.seq);
  const eligible = before === undefined
    ? indexed
    : indexed.filter((entry) => entry.seq < before);
  // Сколько сообщений отброшено локальным фильтром `before` — если что-то
  // отброшено, сервер параметр проигнорировал и его курсор ненадёжен.
  const filteredOut = indexed.length - eligible.length;
  const sliced = eligible.length > limit;
  const page = sliced ? eligible.slice(eligible.length - limit) : eligible;
  const minSeq = page.length > 0 ? page[0]!.seq : null;
  if (sliced) {
    // Локальная нарезка (сервер параметры проигнорировал) — «есть ещё» и
    // курсор считаем сами: более старые записи точно есть.
    return { page: page.map((entry) => entry.m), hasMore: true, nextBefore: minSeq };
  }
  // Страницу сервер собрал сам — признак «есть ещё» берём его (сервер знает
  // про более старые сообщения), а курсор — свой, если `before` пришлось
  // применить локально (иначе серверный курсор указывал бы на уже отданное).
  const hasMore = serverHasMore === true;
  const nextBefore = hasMore
    ? (filteredOut > 0 && minSeq !== null
      ? minSeq
      : (typeof serverNextBefore === 'number' ? serverNextBefore : minSeq))
    : null;
  return { page: page.map((entry) => entry.m), hasMore, nextBefore };
}
