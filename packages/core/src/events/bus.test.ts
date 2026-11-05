import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, EVENT_JOURNAL_SIZE, INSTANCE_EVENT_CHANNEL } from './bus.js';
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

// «Есть кому подтвердить» (`permission.asked`): per-session подписчики ЛИБО
// user-facing глобальные (UI/WS/SSE). Машинные глобальные подписки (webhooks,
// пайплайны, мост гибрида) подтверждение не обслуживают.
describe('EventBus — hasApprovalListeners', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('без подписчиков — false', () => {
    expect(bus.hasApprovalListeners('s1')).toBe(false);
  });

  it('per-session подписка — true', () => {
    bus.subscribe('s1', vi.fn());
    expect(bus.hasApprovalListeners('s1')).toBe(true);
    // Другая сессия не покрыта.
    expect(bus.hasApprovalListeners('s2')).toBe(false);
  });

  it('user-facing глобальная подписка (UI/WS/SSE) — true для любой сессии', () => {
    bus.subscribeAll(vi.fn(), { userFacing: true });
    expect(bus.hasApprovalListeners('s1')).toBe(true);
    expect(bus.hasApprovalListeners('never-seen')).toBe(true);
  });

  it('машинная глобальная подписка (webhooks/пайплайны) — false', () => {
    bus.subscribeAll(vi.fn());
    expect(bus.hasApprovalListeners('s1')).toBe(false);
  });

  it('subscriberCount не меняется глобальными подписками (прежняя семантика)', () => {
    bus.subscribeAll(vi.fn(), { userFacing: true });
    expect(bus.subscriberCount('s1')).toBe(0);
    expect(bus.hasApprovalListeners('s1')).toBe(true);
  });

  it('отписка user-facing подписчика снимает признак', () => {
    const unsub = bus.subscribeAll(vi.fn(), { userFacing: true });
    unsub();
    expect(bus.hasApprovalListeners('s1')).toBe(false);
  });

  it('машинная и user-facing подписки не перекрывают друг друга', () => {
    const machine = vi.fn();
    const ui = vi.fn();
    const unsubMachine = bus.subscribeAll(machine);
    const unsubUi = bus.subscribeAll(ui, { userFacing: true });
    // Отписка UI не снимает доставку машинному и наоборот.
    unsubUi();
    expect(bus.hasApprovalListeners('s1')).toBe(false);
    bus.publish('s1', 'part.delta', {});
    expect(machine).toHaveBeenCalledTimes(1);
    unsubMachine();
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

  it('eventSeq монотонен в пределах инстанса и начинается с 1', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);

    bus.publish('s1', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});

    const seqs = handler.mock.calls.map((call) => (call[0] as BusEvent).eventSeq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(bus.latestEventSeq('s1')).toBe(3);
  });

  it('нумерация сквозная по сессиям: счётчик не сбрасывается на другой сессии', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('s1', a);
    bus.subscribe('s2', b);

    bus.publish('s1', 'part.delta', {});
    bus.publish('s2', 'part.delta', {});
    bus.publish('s1', 'part.delta', {});

    // Номера глобальные: A=1, B=2, A=3 (не 1/1/2 как при per-session).
    expect((a.mock.calls[0]?.[0] as BusEvent).eventSeq).toBe(1);
    expect((b.mock.calls[0]?.[0] as BusEvent).eventSeq).toBe(2);
    expect((a.mock.calls[1]?.[0] as BusEvent).eventSeq).toBe(3);
    // latestEventSeq — номер последнего события **этой** сессии.
    expect(bus.latestEventSeq('s1')).toBe(3);
    expect(bus.latestEventSeq('s2')).toBe(2);
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

  it('инстансный канал не двигает глобальный счётчик', () => {
    bus.publish('s1', 'part.delta', {});
    bus.publishInstance('pipeline.run.started', { runId: 'r1' });
    bus.publish('s1', 'part.delta', {});

    // Номера сессионных событий идут подряд: инстансное событие номера не
    // получает и счётчик не занимает.
    expect(bus.latestEventSeq('s1')).toBe(2);
  });

  it('явный eventSeq из удалённого источника не уменьшает глобальный счётчик', () => {
    const handler = vi.fn();
    bus.subscribe('s1', handler);

    bus.publish('s1', 'part.delta', {});
    // Явный номер меньше локального — берётся локальный счётчик (+1).
    bus.publish('s1', 'part.delta', {}, { eventSeq: 1 });
    // Явный номер больше локального — счётчик прыгает вперёд.
    bus.publish('s1', 'part.delta', {}, { eventSeq: 50 });
    bus.publish('s1', 'part.delta', {});

    const seqs = handler.mock.calls.map((call) => (call[0] as BusEvent).eventSeq);
    expect(seqs).toEqual([1, 2, 50, 51]);
    expect(bus.latestEventSeq('s1')).toBe(51);
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

    // Номер события глобальный: s1=1, s2=2, s1=3 — догон по `since`
    // возвращает события **всех** сессий после номера, без разрыва.
    expect(bus.journalSince(0)).toHaveLength(3);
    const all = bus.journalSince(1);
    expect(all).toHaveLength(2);
    expect(all.every((e) => (e.eventSeq ?? 0) > 1)).toBe(true);
    // Порядок между сессиями — точный (по глобальному номеру).
    expect(all.map((e) => e.data.n)).toEqual([2, 3]);
  });

  it('journalSince после номера сессии не теряет события других сессий', () => {
    // Регрессия: при per-session нумерации клиентский `since` (максимум по
    // всем сессиям) отсекал события «хвостовой» сессии.
    bus.publish('s1', 'part.delta', { n: 1 });
    bus.publish('s1', 'part.delta', { n: 2 });
    bus.publish('s2', 'part.delta', { n: 3 });

    const after = bus.journalSince(2);
    expect(after).toHaveLength(1);
    expect((after[0] as BusEvent).data.n).toBe(3);
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
