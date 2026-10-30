import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, sseEventStream, EVENT_JOURNAL_SIZE, INSTANCE_EVENT_CHANNEL } from './bus.js';
import type { BusEvent } from '@itphx/synth-shared';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('subscribe возвращает функцию отписки', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('s1', handler);
    expect(typeof unsubscribe).toBe('function');
    expect(bus.subscriberCount('s1')).toBe(1);
  });

  it('publish доставляет событие всем подписчикам', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);
    bus.publish('s1', 'part.delta', { content: 'hello' });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as BusEvent;
    expect(event.type).toBe('part.delta');
    expect(event.sessionId).toBe('s1');
    expect(event.data.content).toBe('hello');
    expect(event.timestamp).toBeDefined();
  });

  it('отписка удаляет подписчика', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('s1', handler);
    unsubscribe();
    expect(bus.subscriberCount('s1')).toBe(0);

    bus.publish('s1', 'message.added', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('упавший обработчик не ломает остальных подписчиков', () => {
    const goodHandler = vi.fn();
    const badHandler = vi.fn(() => {
      throw new Error('boom');
    });
    bus.subscribe('s1', badHandler);
    bus.subscribe('s1', goodHandler);

    expect(() => bus.publish('s1', 'part.delta', {})).not.toThrow();
    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('возвращает список активных сессий', () => {
    bus.subscribe('s1', vi.fn());
    bus.subscribe('s2', vi.fn());
    expect(bus.activeSessions()).toEqual(expect.arrayContaining(['s1', 's2']));
  });

  it('subscriberCount для несуществующей сессии возвращает 0', () => {
    expect(bus.subscriberCount('nonexistent')).toBe(0);
  });

  it('publish для сессии без подписчиков не падает', () => {
    expect(() => bus.publish('nonexistent', 'part.delta', {})).not.toThrow();
  });

  it('множественные подписчики одного обработчика — только один вызов (Set уникален)', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);
    bus.subscribe('s1', handler);
    bus.publish('s1', 'part.delta', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('очистка Set подписчиков при отписке последнего', () => {
    const h = vi.fn();
    const unsub1 = bus.subscribe('s1', vi.fn());
    const unsub2 = bus.subscribe('s1', h);
    unsub1();
    unsub2();
    expect(bus.subscriberCount('s1')).toBe(0);
    expect(bus.activeSessions()).not.toContain('s1');
  });

  it('subscribeAll: получает события всех сессий (без привязки к sessionId)', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribeAll(handler);
    expect(typeof unsubscribe).toBe('function');

    bus.publish('s1', 'part.delta', { content: 'a' });
    bus.publish('s2', 'session.updated', { name: 'x' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0].sessionId).toBe('s1');
    expect(handler.mock.calls[1]?.[0].sessionId).toBe('s2');
  });

  it('subscribeAll: отписка останавливает доставку', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribeAll(handler);
    unsubscribe();

    bus.publish('s1', 'part.delta', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('subscribeAll: упавший глобальный обработчик не ломает остальных', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.subscribeAll(bad);
    bus.subscribeAll(good);

    expect(() => bus.publish('s1', 'part.delta', {})).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('publish с глобальным подписчиком не считает событие потерянным', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = vi.fn();
    bus.subscribeAll(handler);

    bus.publish('unknown-session', 'session.updated', {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('session-подписчик и глобальный подписчик оба получают событие (без дублей для одного)', () => {
    const sessionHandler = vi.fn();
    const globalHandler = vi.fn();
    bus.subscribe('s1', sessionHandler);
    bus.subscribeAll(globalHandler);

    bus.publish('s1', 'part.delta', {});

    expect(sessionHandler).toHaveBeenCalledTimes(1);
    expect(globalHandler).toHaveBeenCalledTimes(1);
  });
});

// ADR-118 §4: адресная доставка (`BusEvent.recipient`).
describe('EventBus — адресная доставка (ADR-118 §4)', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('событие с recipient попадает только к получателю', () => {
    const target = vi.fn();
    const other = vi.fn();
    bus.subscribe('s1', target, { userId: 'u1' });
    bus.subscribe('s1', other, { userId: 'u2' });

    bus.publish('s1', 'message.accepted', { messageId: 'm1' }, { recipient: 'u1' });

    expect(target).toHaveBeenCalledTimes(1);
    expect(target.mock.calls[0]?.[0].recipient).toBe('u1');
    expect(other).not.toHaveBeenCalled();
  });

  it('broadcast (без recipient) доходит до всех подписчиков сессии', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('s1', a, { userId: 'u1' });
    bus.subscribe('s1', b, { userId: 'u2' });

    bus.publish('s1', 'queue.state', { pendingCount: 1 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]?.[0].recipient).toBeUndefined();
  });

  it('адресное событие не попадает к подписчику без известного userId (fail-closed)', () => {
    const anon = vi.fn();
    bus.subscribe('s1', anon);

    bus.publish('s1', 'message.accepted', {}, { recipient: 'u1' });

    expect(anon).not.toHaveBeenCalled();
  });

  it('forceBroadcast доставляет адресное событие всем локальным подписчикам (гибрид)', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('s1', a, { userId: 'local' });
    bus.subscribe('s1', b, { userId: 'local' });

    bus.publish('s1', 'message.accepted', {}, { recipient: 'remote-user', forceBroadcast: true });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]?.[0].recipient).toBe('remote-user');
  });

  it('глобальный подписчик получает и адресные события (известное ограничение ADR-118)', () => {
    const global = vi.fn();
    bus.subscribeAll(global);

    bus.publish('s1', 'message.accepted', {}, { recipient: 'u1' });

    expect(global).toHaveBeenCalledTimes(1);
  });
});

// ADR-118 §6: нумерация событий (`eventSeq`) и журнал (догон).
describe('EventBus — eventSeq и журнал событий (ADR-118 §6)', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('eventSeq монотонен в пределах сессии и начинается с 1', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);

    bus.publish('s1', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});

    const seqs = handler.mock.calls.map((call) => (call[0] as BusEvent).eventSeq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(bus.latestEventSeq('s1')).toBe(3);
  });

  it('нумерация различается у разных сессий', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('s1', a);
    bus.subscribe('s2', b);

    bus.publish('s1', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});
    bus.publish('s2', 'part.delta', {});

    expect((a.mock.calls[0]?.[0] as BusEvent).eventSeq).toBe(1);
    expect((a.mock.calls[1]?.[0] as BusEvent).eventSeq).toBe(2);
    expect((b.mock.calls[0]?.[0] as BusEvent).eventSeq).toBe(1);
    expect(bus.latestEventSeq('s2')).toBe(1);
  });

  it('инстансные события не нумеруются и не попадают в журнал сессий', () => {
    const handler = vi.fn();
    bus.subscribe(INSTANCE_EVENT_CHANNEL, handler);

    bus.publishInstance('pipeline.run.started', { runId: 'r1' });

    const event = handler.mock.calls[0]?.[0] as BusEvent;
    expect(event.eventSeq).toBeUndefined();
    expect(bus.latestEventSeq(INSTANCE_EVENT_CHANNEL)).toBe(0);
    expect(bus.journalSince(0)).toHaveLength(0);
  });

  it('since возвращает события строго после указанного номера', () => {
    bus.publish('s1', 'part.delta', { n: 1 });
    bus.publish('s1', 'part.delta', { n: 2 });
    bus.publish('s1', 'part.delta', { n: 3 });

    const after1 = bus.since('s1', 1);
    expect(after1.map((e) => e.data.n)).toEqual([2, 3]);
    expect(after1.every((e) => (e.eventSeq ?? 0) > 1)).toBe(true);

    expect(bus.since('s1', 3)).toHaveLength(0);
    expect(bus.since('s1', 0)).toHaveLength(3);
  });

  it('since для другой сессии не отдаёт чужие события', () => {
    bus.publish('s1', 'part.delta', {});
    bus.publish('s2', 'part.delta', {});

    expect(bus.since('s2', 0)).toHaveLength(1);
    expect((bus.since('s2', 0)[0] as BusEvent).sessionId).toBe('s2');
  });

  it('journalSince отдаёт события всех сессий строго после номера', () => {
    bus.publish('s1', 'part.delta', { n: 1 });
    bus.publish('s2', 'part.delta', { n: 2 });
    bus.publish('s1', 'part.delta', { n: 3 });

    // Номер события монотонен **в пределах сессии**: у s2 своя нумерация,
    // поэтому в глобальном журнале после номера 1 остаётся только событие s1.
    expect(bus.journalSince(0)).toHaveLength(3);
    const all = bus.journalSince(1);
    expect(all).toHaveLength(1);
    expect(all.every((e) => (e.eventSeq ?? 0) > 1)).toBe(true);
  });

  it('журнал ограничен размером кольцевого буфера', () => {
    for (let i = 0; i < EVENT_JOURNAL_SIZE + 25; i += 1) {
      bus.publish('s1', 'part.delta', { i });
    }
    const journal = bus.since('s1', 0);
    expect(journal).toHaveLength(EVENT_JOURNAL_SIZE);
    // Последнее событие в буфере — самое свежее.
    expect((journal[journal.length - 1] as BusEvent).data.i).toBe(EVENT_JOURNAL_SIZE + 24);
  });
});

describe('sseEventStream', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('yields события по мере публикации', async () => {
    const abort = new AbortController();
    const generator = sseEventStream(bus, 's1', abort.signal);

    // Публикуем с задержкой — генератор ждёт в Promise
    setTimeout(() => {
      bus.publish('s1', 'part.delta', { content: 'hello' });
    }, 10);

    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('part.delta');
    expect(first.value.data.content).toBe('hello');

    // Закрываем
    abort.abort();
    const done = await generator.next();
    expect(done.done).toBe(true);
  });

  it('буферизует события в ожидании итерации', async () => {
    const abort = new AbortController();
    const generator = sseEventStream(bus, 's1', abort.signal);

    // Публикуем event пока генератор в Promise-await (после первого next())
    const firstPromise = generator.next();

    // Даём микрозадаче subscribe выполниться
    await new Promise((r) => setTimeout(r, 0));

    bus.publish('s1', 'message.added', { index: 0 });
    bus.publish('s1', 'message.added', { index: 1 });

    const first = await firstPromise;
    expect(first.value.type).toBe('message.added');
    expect(first.value.data.index).toBe(0);

    const second = await generator.next();
    expect(second.value.type).toBe('message.added');
    expect(second.value.data.index).toBe(1);

    abort.abort();
    await generator.next();
  });

  it('AbortSignal обрывает до итерации', async () => {
    const abort = new AbortController();
    abort.abort();
    const generator = sseEventStream(bus, 's1', abort.signal);

    const result = await generator.next();
    expect(result.done).toBe(true);
    expect(bus.subscriberCount('s1')).toBe(0);
  });

  it('AbortSignal обрывает во время ожидания Promise', async () => {
    const abort = new AbortController();
    const generator = sseEventStream(bus, 's1', abort.signal);

    // Запускаем итерацию (subscribe, затем Promise-await)
    const resultPromise = generator.next();

    // Ждём микрозадачу чтобы subscribe выполнился
    await new Promise((r) => setTimeout(r, 0));

    // Абортим пока ждёт Promise
    abort.abort();

    const result = await resultPromise;
    expect(result.done).toBe(true);
    expect(bus.subscriberCount('s1')).toBe(0);
  });

  it('finally отписывает подписчика при обрыве после yield', async () => {
    const abort = new AbortController();
    const generator = sseEventStream(bus, 's1', abort.signal);

    // Запускаем итерацию
    const firstPromise = generator.next();
    await new Promise((r) => setTimeout(r, 0));

    bus.publish('s1', 'part.delta', {});
    await firstPromise;

    // Абортим
    abort.abort();
    const done = await generator.next();
    expect(done.done).toBe(true);
    expect(bus.subscriberCount('s1')).toBe(0);
  });
});
