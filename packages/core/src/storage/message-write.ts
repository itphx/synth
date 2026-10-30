/**
 * Подготовка сообщений к **точечной** записи (`SessionRepository.appendMessage`/
 * `updateMessage`) в файловой и in-memory реализациях.
 *
 * Семантика — часть контракта порта (ADR-096), поэтому нормализация вынесена в
 * один модуль: реализации не должны расходиться в дефолтах и NUL-санитайзинге.
 * PostgreSQL-драйвер использует собственный слой сериализации (`messageRow`),
 * но придерживается тех же правил.
 */

import type { Message, Session } from '@itphx/synth-shared';
import { generateId, makeTextPart, nowISO, stripNullBytesDeep } from '@itphx/synth-shared';

/** Следующий `seq` в сессии: `max(seq)+1` (legacy `seq = 0` не мешает). */
function nextSeq(messages: Message[]): number {
  const max = messages.reduce((acc, message) => {
    const seq = Number.isFinite(message.seq) ? message.seq : 0;
    return seq > acc ? seq : acc;
  }, 0);
  return max + 1;
}

/**
 * ADR-118 §2 / §«Порядок и идемпотентность»: следующий `ord` — **монотонный**
 * счётчик сессии (`max(ord)+1` по полю `ord`).
 *
 * Отличие от `nextSeq`: `seq` — позиционный (порядок в массиве истории,
 * перенумеровывается при вставке/удалении), `ord` — монотонный: ранее
 * выданные значения **не перенумеровываются**, поэтому новое сообщение всегда
 * получает большее `ord`, даже если вставлено в середину истории. Legacy-записи
 * без `ord` дают 0 — как и legacy `seq = 0`.
 */
export function nextOrd(messages: Message[]): number {
  const max = messages.reduce((acc, message) => {
    const ord = Number.isFinite(message.ord) ? (message.ord as number) : 0;
    return ord > acc ? ord : acc;
  }, 0);
  return max + 1;
}

/** Обязательные поля сообщения: безопасные дефолты (как в `messageRow` PG-драйвера). */
function withMessageDefaults(message: Message): Message {
  return {
    ...message,
    id: message.id || generateId(),
    origin: message.origin || 'local',
    parts: message.parts && message.parts.length > 0
      ? message.parts
      : [makeTextPart(message.content ?? '')],
    createdAt: message.createdAt || nowISO(),
  };
}

/**
 * Сообщение для `appendMessage`: дефолты обязательных полей, `seq = max+1`,
 * `ord = max(ord)+1` (ADR-118), NUL-санитайзинг (U+0000 несовместим с
 * PostgreSQL — чистим на границе порта).
 *
 * `ord` — монотонный счётчик сессии, выдаётся портом в момент материализации
 * записи в историю. Уже выданный `ord` (если его проставил вызывающий) не
 * перетирается: ранее выданные значения не перенумеровываются.
 */
export function prepareMessageForAppend(session: Session, message: Message): Message {
  const prepared = withMessageDefaults(message);
  prepared.seq = nextSeq(session.messages);
  if (!Number.isFinite(prepared.ord)) {
    prepared.ord = nextOrd(session.messages);
  }
  return stripNullBytesDeep(prepared);
}

/**
 * Сообщение для `updateMessage`: полная замена изменяемых полей; `id`/`seq`/
 * `createdAt`/`ord` берутся у исходной записи. NUL-санитайзинг — как у append.
 *
 * ADR-118: `ord` **иммутабелен после выдачи** — уже выданное значение
 * сохраняется (как `id`/`seq`/`createdAt`), обновление его не перебивает. Для
 * записи, которой `ord` ещё не выдан (legacy-строка), принимается значение из
 * обновления — так проставляет `ord` миграция данных (паритет с
 * PostgreSQL-драйвером: `COALESCE(messages.ord, …)`).
 */
export function prepareMessageForUpdate(target: Message, message: Message): Message {
  const prepared = withMessageDefaults(message);
  prepared.id = target.id;
  prepared.seq = target.seq;
  prepared.createdAt = target.createdAt;
  prepared.ord = Number.isFinite(target.ord)
    ? (target.ord as number)
    : (Number.isFinite(prepared.ord) ? prepared.ord : undefined);
  return stripNullBytesDeep(prepared);
}

/**
 * Индекс цели `updateMessage`: сначала по `seq` (уникален в сессии), затем
 * fallback по `id`. `-1` — сообщение не найдено.
 */
export function findMessageIndex(messages: Message[], message: Message): number {
  if (Number.isFinite(message.seq)) {
    const bySeq = messages.findIndex((candidate) => candidate.seq === message.seq);
    if (bySeq >= 0) return bySeq;
  }
  if (message.id) {
    return messages.findIndex((candidate) => candidate.id === message.id);
  }
  return -1;
}
