import { describe, it, expect } from 'vitest';
import { nextOrd, prepareMessageForAppend, prepareMessageForUpdate } from './message-write.js';
import { makeMessage, makeSession } from './contract/helpers.js';

describe('message-write — `ord` (ADR-118 §2, «Порядок и идемпотентность»)', () => {
  it('ord монотонен при последовательных добавлениях', () => {
    const session = makeSession();

    const first = prepareMessageForAppend(session, makeMessage('first'));
    expect(first.ord).toBe(1);
    session.messages.push(first);

    const second = prepareMessageForAppend(session, makeMessage('second'));
    expect(second.ord).toBe(2);
    session.messages.push(second);

    const third = prepareMessageForAppend(session, makeMessage('third'));
    expect(third.ord).toBe(3);
  });

  it('ord не перенумеровывается при вставке в середину истории', () => {
    const session = makeSession();
    const first = prepareMessageForAppend(session, makeMessage('first'));
    session.messages.push(first);
    const second = prepareMessageForAppend(session, makeMessage('second'));
    session.messages.push(second);
    const third = prepareMessageForAppend(session, makeMessage('third'));
    session.messages.push(third);

    // Материализация сообщения, вставленного в середину (например, реплика
    // пользователя, применённая посреди хода): `ord` выдаётся по max+1 и не
    // сдвигает нумерацию уже записанных сообщений.
    const inserted = prepareMessageForAppend(session, makeMessage('inserted'));
    expect(inserted.ord).toBe(4);
    session.messages.splice(1, 0, inserted);

    // Позиция в массиве — 2, порядок записи — 4: `seq` позиционный, `ord` —
    // монотонный.
    expect(session.messages.map((m) => m.ord)).toEqual([1, 4, 2, 3]);
    expect(session.messages.map((m) => m.content)).toEqual(['first', 'inserted', 'second', 'third']);

    // Следующее сообщение продолжает счётчик, а не «перенумеровывает» историю.
    const next = prepareMessageForAppend(session, makeMessage('next'));
    expect(next.ord).toBe(5);
  });

  it('уже проставленный ord не перетирается', () => {
    const session = makeSession();
    const prepared = prepareMessageForAppend(session, { ...makeMessage('pre-assigned'), ord: 42 });
    expect(prepared.ord).toBe(42);

    // Счётчик сессии продолжается от максимума (включая выданное значение).
    session.messages.push(prepared);
    expect(nextOrd(session.messages)).toBe(43);
  });

  it('legacy-сообщения без ord: первое добавление получает ord = 1', () => {
    const session = makeSession({
      messages: [{ ...makeMessage('legacy'), seq: 1 }],
    });
    expect(session.messages[0]!.ord).toBeUndefined();

    const appended = prepareMessageForAppend(session, makeMessage('new'));
    expect(appended.ord).toBe(1);
  });

  it('prepareMessageForUpdate сохраняет исходный ord цели', () => {
    const target = { ...makeMessage('target'), seq: 3, ord: 7 };
    const updated = prepareMessageForUpdate(target, {
      ...makeMessage('updated'),
      seq: 99,
      ord: 1,
      createdAt: '2030-01-01T00:00:00.000Z',
    });

    // `ord` иммутабелен после выдачи — обновление его не перебивает.
    expect(updated.ord).toBe(7);
    expect(updated.seq).toBe(3);
    expect(updated.createdAt).toBe(target.createdAt);
  });

  it('prepareMessageForUpdate legacy-сообщения (без ord) принимает ord из обновления', () => {
    // Записи до ADR-118 `ord` не имеют — обновление может его проставить
    // (так работает миграция данных; паритет с PostgreSQL: COALESCE).
    const target = { ...makeMessage('legacy'), seq: 1 };
    const updated = prepareMessageForUpdate(target, { ...makeMessage('updated'), ord: 5 });
    expect(updated.ord).toBe(5);

    // Без ord в обновлении — поле остаётся незаданным (дефолтов не выдумываем).
    const untouched = prepareMessageForUpdate(target, makeMessage('updated'));
    expect(untouched.ord).toBeUndefined();
  });
});
