/**
 * Помощники атомарных операций `SessionRepository.mutateMeta`/`mutateHistory`
 * для файловой и in-memory реализаций (ADR-096).
 *
 * PostgreSQL-драйвер использует собственный слой сериализации
 * (`sessions-mapping.ts`), но семантика — общая: мутатор `mutateMeta` не видит
 * историю и child-наборы, а `mutateHistory` нормализует `seq` позиционно.
 */

import type { Message, Session, SessionMeta } from '@itphx/synth-shared';

/**
 * Снимок метаданных сессии: новый объект без `messages`/`checkpoints`/
 * `references`/`stickyNotes`. Вложенные значения (`settings`/`status`/`todos`…)
 * разделяются с исходной сессией — мутатор может как править их по месту, так и
 * заменять целиком.
 */
export function toSessionMeta(session: Session): SessionMeta {
  const {
    messages: _messages,
    checkpoints: _checkpoints,
    references: _references,
    stickyNotes: _stickyNotes,
    ...meta
  } = session;
  return meta;
}

/**
 * Собрать сессию обратно из снимка метаданных: child-наборы берутся из
 * **свежего** `base` (поэтому точечные записи истории не теряются).
 */
export function mergeSessionMeta(base: Session, meta: SessionMeta): Session {
  return {
    ...meta,
    messages: base.messages,
    checkpoints: base.checkpoints,
    references: base.references,
    stickyNotes: base.stickyNotes,
  };
}

/** Максимальный выданный `ord` в истории (`0`, если `ord` ни у кого нет). */
export function maxOrdOf(messages: Message[]): number {
  return messages.reduce((acc, message) => {
    const ord = Number.isFinite(message.ord) ? (message.ord as number) : 0;
    return ord > acc ? ord : acc;
  }, 0);
}

/**
 * `seq` — позиционный (порядок массива истории): нормализация `1..n`.
 * `ord` не трогается: он монотонный и иммутабелен после выдачи (ADR-118 §2).
 */
export function normalizeMessageSeq(messages: Message[]): void {
  messages.forEach((message, index) => {
    message.seq = index + 1;
  });
}

/**
 * Выдать `ord` сообщениям, у которых его нет (`mutateHistory`: добавление
 * мутатором/импортом).
 *
 * `ord` — монотонный счётчик сессии (ADR-118 §2): значения идут подряд, начиная
 * с `max(ord среди сообщений с ord) + 1`, в порядке массива. Ранее выданные
 * `ord` не перенумеровываются; без выдачи новые записи сортировались бы в начало
 * истории (сортировка по `ord`). `seq` нормализуется отдельно —
 * {@link normalizeMessageSeq}.
 *
 * Возвращает число выданных `ord` (0 — менять нечего).
 */
export function assignMissingOrd(messages: Message[]): number {
  let next = maxOrdOf(messages) + 1;
  let assigned = 0;
  for (const message of messages) {
    if (Number.isFinite(message.ord)) continue;
    message.ord = next++;
    assigned++;
  }
  return assigned;
}
