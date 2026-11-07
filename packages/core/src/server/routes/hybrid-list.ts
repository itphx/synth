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

/** Ключ порядка DTO истории удалённого мира (значение непрозрачного курсора). */
type RemoteMessageKey = (message: Record<string, unknown>, index: number) => number;

/**
 * Ключ порядка страницы удалённой истории: `index` (абсолютная позиция —
 * уникальна) при монотонности, затем `seq` при монотонности, иначе позиция.
 * Возвращает `monotone: false` для позиционного ключа — по нему сортировать
 * нечего (порядок сервера и есть позиция).
 */
function resolveRemoteMessageKey(
  messages: Array<Record<string, unknown>>,
): { keyOf: RemoteMessageKey; monotone: boolean } {
  const numeric = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  /** Значение есть у всех и строго возрастает по массиву. */
  const monotonic = (pick: (message: Record<string, unknown>) => unknown): boolean => {
    for (let i = 0; i < messages.length; i += 1) {
      const value = pick(messages[i]!);
      if (!numeric(value)) return false;
      if (i > 0) {
        const previous = pick(messages[i - 1]!);
        if (!numeric(previous) || value <= previous) return false;
      }
    }
    return true;
  };
  if (messages.length > 0) {
    if (monotonic((message) => message.index)) {
      return { keyOf: (message) => message.index as number, monotone: true };
    }
    if (monotonic((message) => message.seq)) {
      return { keyOf: (message) => message.seq as number, monotone: true };
    }
  }
  return { keyOf: (_message, index) => index, monotone: false };
}

/**
 * Нарезка страницы истории сообщений удалённой сессии.
 *
 * Новый удалённый сервер отдаёт уже готовую страницу вместе с метаданными
 * (`has_more`/`next_before`) — им и доверяем: страницу **не** перефильтровываем
 * по `seq` и **не** пересортировываем (в legacy-сессии `seq` не уникален, и
 * сортировка перемешала бы записи; курсор сервера — тоже непрозрачный).
 *
 * Старый сервер игнорирует `limit`/`before` и отдаёт **всю** историю — тогда
 * страница режется локально по тому же принципу ключа: `index` при
 * монотонности (абсолютная позиция), иначе `seq` при монотонности, иначе
 * позиция. Сортировка по ключу — только если он монотонен. `before` в этом
 * пути пришёл из нашего же `next_before`, поэтому пространство ключей совпадает.
 *
 * - `messages` — DTO сообщений удалённого мира (в порядке сервера);
 * - `limit` — размер страницы;
 * - `before` — исключающий непрозрачный курсор (значение `next_before`);
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
  const hasServerMeta = serverHasMore !== undefined || serverNextBefore !== undefined;
  if (hasServerMeta) {
    // Сервер вернул готовую страницу — берём как есть.
    if (messages.length <= limit) {
      return {
        page: messages,
        hasMore: serverHasMore === true,
        nextBefore: serverNextBefore ?? null,
      };
    }
    // Защитный slice: сервер отдал больше, чем просили. Порядок не меняем,
    // отрезаем хвост (самые новые) и считаем курсор сами. Ключи считаем по
    // полному ответу — у позиционного ключа это абсолютная позиция, а не 0.
    const { keyOf } = resolveRemoteMessageKey(messages);
    const keys = messages.map((message, index) => keyOf(message, index));
    const page = messages.slice(messages.length - limit);
    const pageKeys = keys.slice(messages.length - limit);
    const nextBefore = pageKeys.length > 0 ? Math.min(...pageKeys) : null;
    return { page, hasMore: true, nextBefore };
  }
  const { keyOf, monotone } = resolveRemoteMessageKey(messages);
  const indexed = messages.map((message, index) => ({ message, key: keyOf(message, index) }));
  // Сортируем только по монотонному ключу; позиционный порядок уже верный.
  if (monotone) indexed.sort((a, b) => a.key - b.key);
  const eligible = before === undefined
    ? indexed
    : indexed.filter((entry) => entry.key < before);
  const sliced = eligible.length > limit;
  const page = sliced ? eligible.slice(eligible.length - limit) : eligible;
  const keys = page.map((entry) => entry.key);
  // Локальная нарезка значит «более старые записи точно есть»; курсор —
  // минимальный ключ страницы (первое сообщение после сортировки).
  const nextBefore = sliced && keys.length > 0 ? Math.min(...keys) : null;
  return { page: page.map((entry) => entry.message), hasMore: sliced, nextBefore };
}
