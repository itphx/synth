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
 * NUL-санитайзинг (U+0000 несовместим с PostgreSQL — чистим на границе порта).
 */
export function prepareMessageForAppend(session: Session, message: Message): Message {
  const prepared = withMessageDefaults(message);
  prepared.seq = nextSeq(session.messages);
  return stripNullBytesDeep(prepared);
}

/**
 * Сообщение для `updateMessage`: полная замена изменяемых полей; `id`/`seq`/
 * `createdAt` берутся у исходной записи. NUL-санитайзинг — как у append.
 */
export function prepareMessageForUpdate(target: Message, message: Message): Message {
  const prepared = withMessageDefaults(message);
  prepared.id = target.id;
  prepared.seq = target.seq;
  prepared.createdAt = target.createdAt;
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
