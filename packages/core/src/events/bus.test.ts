import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, sseEventStream } from './bus.js';
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
    bus.publish('s1', 'stream.chunk', { content: 'hello' });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as BusEvent;
    expect(event.type).toBe('stream.chunk');
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

    expect(() => bus.publish('s1', 'stream.chunk', {})).not.toThrow();
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
    expect(() => bus.publish('nonexistent', 'stream.chunk', {})).not.toThrow();
  });

  it('множественные подписчики одного обработчика — только один вызов (Set уникален)', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);
    bus.subscribe('s1', handler);
    bus.publish('s1', 'stream.chunk', {});
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

    bus.publish('s1', 'stream.chunk', { content: 'a' });
    bus.publish('s2', 'session.updated', { name: 'x' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0].sessionId).toBe('s1');
    expect(handler.mock.calls[1]?.[0].sessionId).toBe('s2');
  });

  it('subscribeAll: отписка останавливает доставку', () => {
    const handler = vi.fn();
    const unsubscribe = bus.subscribeAll(handler);
    unsubscribe();

    bus.publish('s1', 'stream.chunk', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('subscribeAll: упавший глобальный обработчик не ломает остальных', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.subscribeAll(bad);
    bus.subscribeAll(good);

    expect(() => bus.publish('s1', 'stream.chunk', {})).not.toThrow();
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

    bus.publish('s1', 'stream.chunk', {});

    expect(sessionHandler).toHaveBeenCalledTimes(1);
    expect(globalHandler).toHaveBeenCalledTimes(1);
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
      bus.publish('s1', 'stream.chunk', { content: 'hello' });
    }, 10);

    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('stream.chunk');
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

    bus.publish('s1', 'stream.chunk', {});
    await firstPromise;

    // Абортим
    abort.abort();
    const done = await generator.next();
    expect(done.done).toBe(true);
    expect(bus.subscriberCount('s1')).toBe(0);
  });
});
