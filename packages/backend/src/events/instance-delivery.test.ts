/**
 * Решение владельца (вариант A): инстансный канал шины (`INSTANCE_EVENT_CHANNEL`,
 * ADR-101/ADR-118) в managed-режиме доставляется **всем** аутентифицированным
 * клиентам, но обычный `USER` видит только «пользовательские» типы
 * (`instance-events.ts`), а административные — нет.
 *
 * Матрица (этот файл):
 *  - `USER` × `agents.updated` (пользовательское) → доставлено;
 *  - `USER` × не-пользовательский тип → **не** доставлено;
 *  - `ADMIN`/`LEAD`/`service:*` (watch-all) × оба типа → доставлено (как раньше);
 *  - `USER` × событие **чужой сессии** → не доставлено (изоляция сессий цела).
 *
 * Регресс-детектор: если кто-то снова сузит инстансный канал до watch-all,
 * падают тесты «подписка обычного клиента на инстансный канал есть» и «USER
 * получает пользовательское событие».
 *
 * Транспортные срезы (реальные WS и SSE через backend-приложение) —
 * `src/app/instance-events-transport.test.ts`; здесь — сам `EventHub`.
 */
import { describe, it, expect } from 'vitest';
import { EventBus, INSTANCE_EVENT_CHANNEL } from '@itphx/synth-core';
import type { SessionManager } from '@itphx/synth-core';
import type { BusEvent, EventType } from '@itphx/synth-shared';
import { EventHub, type EventClient } from './hub.js';
import { USER_FACING_INSTANCE_EVENTS } from './instance-events.js';

/**
 * Не-пользовательский инстансный тип. Административные события (`maintenance.*`,
 * `packs.*`, аудит) пока не входят в `EventType`, поэтому берём валидный тип
 * шины, которого нет в списке «пользовательских»: этого достаточно — правило
 * fail-closed по списку, а не по конкретному имени.
 */
const ADMIN_ONLY_TYPE: EventType = 'event.received';

/** Пользовательский тип-представитель (реестр агентов). */
const USER_FACING_TYPE: EventType = 'agents.updated';

function makeHub(existingSessions: string[] = []) {
  const eventBus = new EventBus();
  const sessionManager = {
    listSessions: async () => existingSessions.map((id) => ({ id })),
  } as unknown as SessionManager;
  return { eventBus, hub: new EventHub(eventBus, sessionManager) };
}

function makeClient(userId = 'u1', allSessions = false) {
  const received: BusEvent[] = [];
  const client: EventClient = {
    userId,
    username: userId,
    allSessions,
    send: (event: BusEvent) => received.push(event),
  };
  return { client, received };
}

describe('EventHub — инстансный канал: подписка обычного клиента (вариант A)', () => {
  it('подписка обычного клиента на инстансный канал есть (не только watch-all)', async () => {
    const { eventBus, hub } = makeHub();
    const { client } = makeClient();

    expect(eventBus.subscriberCount(INSTANCE_EVENT_CHANNEL)).toBe(0);
    await hub.registerClient(client);
    expect(eventBus.subscriberCount(INSTANCE_EVENT_CHANNEL)).toBe(1);

    hub.unregisterClient(client);
    expect(eventBus.subscriberCount(INSTANCE_EVENT_CHANNEL)).toBe(0);
  });

  it('пересчёт подписок (resync) не снимает подписку на инстансный канал', async () => {
    const { eventBus, hub } = makeHub(['mine']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    await hub.resyncClient(client);
    await hub.resyncAllClients();

    eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'admin' });
    expect(received.some((e) => e.type === USER_FACING_TYPE)).toBe(true);
  });
});

describe('EventHub — матрица доставки инстансных событий', () => {
  it('USER получает все пользовательские типы (реестры и прогоны пайплайнов)', async () => {
    const { eventBus, hub } = makeHub();
    const { client, received } = makeClient();
    await hub.registerClient(client);

    for (const type of USER_FACING_INSTANCE_EVENTS) {
      eventBus.publishInstance(type, { action: 'probe' });
    }

    const delivered = received.filter((e) => e.sessionId === INSTANCE_EVENT_CHANNEL).map((e) => e.type);
    expect(delivered.sort()).toEqual([...USER_FACING_INSTANCE_EVENTS].sort());
  });

  it('USER не получает не-пользовательские (административные) инстансные события', async () => {
    const { eventBus, hub } = makeHub();
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });

    expect(received.some((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(false);
    expect(received.length).toBe(0);
  });

  it('ADMIN/LEAD/service-ключ (watch-all) получают и пользовательские, и административные', async () => {
    for (const actor of ['admin', 'lead', 'service:key-1']) {
      const { eventBus, hub } = makeHub();
      const { client, received } = makeClient(actor, true);
      await hub.registerClient(client);

      eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'admin' });
      eventBus.publishInstance(ADMIN_ONLY_TYPE, { note: 'admin-only' });

      const types = received.filter((e) => e.sessionId === INSTANCE_EVENT_CHANNEL).map((e) => e.type);
      expect(types, `watch-all ${actor}`).toEqual([USER_FACING_TYPE, ADMIN_ONLY_TYPE]);
      hub.unregisterClient(client);
    }
  });

  it('watch-all клиент не получает инстансное событие дважды', async () => {
    const { eventBus, hub } = makeHub();
    const { client, received } = makeClient('admin', true);
    await hub.registerClient(client);

    eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'admin' });

    expect(received.filter((e) => e.type === USER_FACING_TYPE).length).toBe(1);
  });

  it('USER по-прежнему не получает событие чужой сессии (изоляция сессий)', async () => {
    const { eventBus, hub } = makeHub(['mine']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('foreign', 'turn.finished', { turnId: 'turn-foreign', status: 'completed' });
    eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'admin' });

    expect(received.some((e) => e.sessionId === 'foreign')).toBe(false);
    // Контроль: инстансное (пользовательское) событие при этом доставлено.
    expect(received.some((e) => e.sessionId === INSTANCE_EVENT_CHANNEL)).toBe(true);
  });

  it('unregister снимает и подписку на инстансный канал', async () => {
    const { eventBus, hub } = makeHub();
    const { client, received } = makeClient();
    await hub.registerClient(client);
    hub.unregisterClient(client);

    eventBus.publishInstance(USER_FACING_TYPE, { action: 'save', id: 'admin' });

    expect(received.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Источник истины — один: список «пользовательских» типов. Расширение состава
// (осознанное) обязано сопровождаться правкой списка, а не «тихой» доставкой
// нового типа всем: неизвестный тип к USER не идёт (fail-closed).
// ---------------------------------------------------------------------------

describe('Пользовательские инстансные события — состав списка', () => {
  it('реестры инстанса и прогоны пайплайнов', () => {
    expect([...USER_FACING_INSTANCE_EVENTS].sort()).toEqual([
      'agents.updated',
      'mcp.updated',
      'models.updated',
      'pipeline.completed',
      'pipeline.run.awaiting_human',
      'pipeline.run.failed',
      'pipeline.run.finished',
      'pipeline.run.node_finished',
      'pipeline.run.node_started',
      'pipeline.run.started',
      'skills.updated',
    ]);
  });

  it('административные типы в список не входят', () => {
    expect(USER_FACING_INSTANCE_EVENTS.has(ADMIN_ONLY_TYPE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Догон журнала (`?since` / `Last-Event-ID`) — та же граница доступа, что у живой
// доставки: полный журнал видит только watch-all клиент.
// ---------------------------------------------------------------------------

describe('EventHub — догон журнала: граница по видимым сессиям', () => {
  it('USER без видимых сессий получает пустой догон, а не журнал всех сессий', async () => {
    // До фикса клиент без per-session подписок получал `journalSince` — журнал
    // **всех** сессий: утечка чужих кадров (текст ответа, снимок реплики).
    const { eventBus, hub } = makeHub([]);
    const { client } = makeClient('new-user');
    await hub.registerClient(client);

    eventBus.publish('foreign-session', 'part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: 'чужой текст' });

    expect(hub.replayForClient(client, 0)).toEqual([]);
  });

  it('watch-all клиент получает полный журнал (поведение прежнее)', async () => {
    const { eventBus, hub } = makeHub([]);
    const { client } = makeClient('service:key', true);
    await hub.registerClient(client);

    eventBus.publish('foreign-session', 'part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: 'текст' });

    const replay = hub.replayForClient(client, 0);
    expect(replay.length).toBe(1);
    expect(replay[0]?.sessionId).toBe('foreign-session');
  });

  it('USER с видимыми сессиями получает только их журнал', async () => {
    const { eventBus, hub } = makeHub(['own-session']);
    const { client } = makeClient('u1');
    await hub.registerClient(client);

    eventBus.publish('own-session', 'part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: 'свой' });
    eventBus.publish('foreign-session', 'part.delta', { messageId: 'm2', partId: 'p2', field: 'text', delta: 'чужой' });

    const replay = hub.replayForClient(client, 0);
    expect(replay.map((e) => e.sessionId)).toEqual(['own-session']);
  });
});
