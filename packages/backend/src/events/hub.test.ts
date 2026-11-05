import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventBus,
  EventBindingStore,
  EventJournalStore,
  EventRouter,
  FileStore,
  RequestSessionService,
  SessionManager,
} from '@itphx/synth-core';
import type { SessionManager as SessionManagerType } from '@itphx/synth-core';
import type { BusEvent, SynthEvent } from '@itphx/synth-shared';
import { EventHub, type EventClient } from './hub.js';

function makeHub(existingSessions: string[] = []) {
  const eventBus = new EventBus();
  const sessionManager = {
    listSessions: async () => existingSessions.map((id) => ({ id })),
  } as unknown as SessionManagerType;
  const hub = new EventHub(eventBus, sessionManager);
  return { eventBus, hub };
}

function makeClient(allSessions = false) {
  const received: BusEvent[] = [];
  const client: EventClient = {
    userId: 'u1',
    username: 'u1',
    allSessions,
    send: (event: BusEvent) => received.push(event),
  };
  return { client, received };
}

describe('EventHub — автоподписка на дочерние сессии', () => {
  it('подписывает клиента на child из session.created родителя и доставляет его step.finished', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'session.created', { id: 'child-1', parentId: 'parent' });
    // ADR-118 §4: `stream.usage` удалён — расход токенов шага несёт `step.finished`.
    eventBus.publish('child-1', 'step.finished', {
      turnId: 'turn-1',
      stepIndex: 0,
      messageId: 'msg-child-1',
      status: 'completed',
      usage: { outputTokens: 42 },
    });

    const step = received.find((e) => e.type === 'step.finished');
    expect(step).toBeDefined();
    expect(step!.sessionId).toBe('child-1');
    expect(step!.data.messageId).toBe('msg-child-1');
    expect(step!.data.usage).toEqual({ outputTokens: 42 });
  });

  it('подписывает клиента на child из child.session.updated родителя', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'child.session.updated', { session: { id: 'child-2' } });
    eventBus.publish('child-2', 'step.finished', {
      turnId: 'turn-2',
      stepIndex: 0,
      messageId: 'msg-child-2',
      status: 'completed',
      usage: { outputTokens: 7 },
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === 'child-2')).toBe(true);
  });

  it('подписывает клиента на child из child.message.added (child_session_id)', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'child.message.added', { child_session_id: 'child-3' });
    eventBus.publish('child-3', 'step.finished', {
      turnId: 'turn-3',
      stepIndex: 0,
      messageId: 'msg-child-3',
      status: 'completed',
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === 'child-3')).toBe(true);
  });

  it('подписывает клиента на child из subagent.resume.started', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'subagent.resume.started', { child_session_id: 'child-4' });
    eventBus.publish('child-4', 'step.finished', {
      turnId: 'turn-4',
      stepIndex: 0,
      messageId: 'msg-child-4',
      status: 'completed',
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === 'child-4')).toBe(true);
  });

  it('не подписывает клиента на чужую/необъявленную сессию', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('foreign', 'step.finished', {
      turnId: 'turn-foreign',
      stepIndex: 0,
      messageId: 'msg-foreign',
      status: 'completed',
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === 'foreign')).toBe(false);
  });

  it('не подписывает на сессию, если клиент отписан (unregister)', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);
    hub.unregisterClient(client);

    eventBus.publish('parent', 'session.created', { id: 'child-5' });
    eventBus.publish('child-5', 'step.finished', {
      turnId: 'turn-5',
      stepIndex: 0,
      messageId: 'msg-child-5',
      status: 'completed',
    });

    expect(received.some((e) => e.type === 'step.finished')).toBe(false);
  });
});

describe('EventHub — доставка сессий, созданных после подключения (ADR-089)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-hub-materialized-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeEvent = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
    id: 'evt_1',
    source: 'telegram',
    type: 'message',
    payload: { text: 'hi' },
    identity: {},
    dedupKey: `dedup-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    ...overrides,
  });

  /** Funnel, связанный с хабом так же, как в backend `app.ts`. */
  function wire() {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const hub = new EventHub(eventBus, sessionManager);
    const bindingStore = new EventBindingStore({ dataDir: tmpDir });
    const journal = new EventJournalStore({ dataDir: tmpDir });
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const service = new RequestSessionService({
      sessionManager,
      eventRouter: router,
      bindingStore,
      config: { defaultEphemeralTtl: '24h' },
      deliver: async () => {},
      onSessionMaterialized: (session) => {
        const owner = session.ownerId || session.userId;
        if (owner) void hub.subscribeToSession(owner, session.id);
      },
    });
    return { eventBus, hub, service };
  }

  it('клиент, подключённый до создания сессии, получает её события (владелец)', async () => {
    const { eventBus, hub, service } = wire();
    const { client, received } = makeClient();
    await hub.registerClient(client);

    const { session } = await service.handleEvent(
      makeEvent({ identity: { chatKey: 'chat:telegram:new' } }),
      { ownerId: 'u1' },
    );
    expect(session).not.toBeNull();

    eventBus.publish(session!.id, 'step.finished', {
      turnId: 'turn-mat-1',
      stepIndex: 0,
      messageId: 'msg-mat-1',
      status: 'completed',
      usage: { outputTokens: 5 },
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === session!.id)).toBe(true);
  });

  it('чужая сессия (другой владелец) не доставляется клиенту', async () => {
    const { eventBus, hub, service } = wire();
    const { client, received } = makeClient();
    await hub.registerClient(client);

    const { session } = await service.handleEvent(
      makeEvent({ identity: { chatKey: 'chat:telegram:foreign' } }),
      { ownerId: 'u2' },
    );
    expect(session).not.toBeNull();

    eventBus.publish(session!.id, 'step.finished', {
      turnId: 'turn-foreign-owner',
      stepIndex: 0,
      messageId: 'msg-foreign-owner',
      status: 'completed',
    });

    expect(received.some((e) => e.sessionId === session!.id)).toBe(false);
  });
});

// ADR-052 (этап IV) / ADR-089: машинные watcher'ы (service-key) и роли сквозного
// обзора подписываются на глобальный поток `eventBus.subscribeAll`, а не по
// владельцу сессий. Раньше синтетический пользователь `service:<keyId>` не владел
// сессиями → подписок 0 → ответы агента не доходили до шлюза.
describe('EventHub — watch-all клиенты (ADR-052/ADR-089)', () => {
  it('all-клиент получает события чужой сессии без явной подписки', async () => {
    const { eventBus, hub } = makeHub([]);
    const { client, received } = makeClient(true);
    await hub.registerClient(client);

    eventBus.publish('foreign', 'step.finished', {
      turnId: 'turn-watch',
      stepIndex: 0,
      messageId: 'msg-watch',
      status: 'completed',
      usage: { outputTokens: 1 },
    });

    expect(received.some((e) => e.type === 'step.finished' && e.sessionId === 'foreign')).toBe(true);
  });

  it('обычный клиент чужую сессию не получает (контроль)', async () => {
    const { eventBus, hub } = makeHub([]);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('foreign', 'step.finished', {
      turnId: 'turn-control',
      stepIndex: 0,
      messageId: 'msg-control',
      status: 'completed',
    });

    expect(received.some((e) => e.sessionId === 'foreign')).toBe(false);
  });

  it('all-клиент не дублирует события своей сессии', async () => {
    const { eventBus, hub } = makeHub(['mine']);
    const { client, received } = makeClient(true);
    await hub.registerClient(client);

    // `stream.done` удалён (ADR-118 §4): финал хода — `turn.finished`.
    eventBus.publish('mine', 'turn.finished', { turnId: 'turn-mine', status: 'completed' });

    expect(received.filter((e) => e.sessionId === 'mine').length).toBe(1);
  });

  it('unregisterClient снимает глобальную подписку (повторные события не текут)', async () => {
    const { eventBus, hub } = makeHub([]);
    const { client, received } = makeClient(true);
    await hub.registerClient(client);
    hub.unregisterClient(client);

    eventBus.publish('foreign', 'step.finished', {
      turnId: 'turn-unregistered',
      stepIndex: 0,
      messageId: 'msg-unregistered',
      status: 'completed',
    });

    expect(received.length).toBe(0);
  });

  // Регресс «no connected user to approve»: watch-all клиент (ADMIN/LEAD,
  // service-key) подписан только глобально — `subscriberCount` для сессии у
  // него 0, но подтвердить запрос он может.
  it('all-клиент делает hasApprovalListeners(session)=true', async () => {
    const { eventBus, hub } = makeHub([]);
    const { client } = makeClient(true);
    await hub.registerClient(client);

    expect(eventBus.subscriberCount('foreign')).toBe(0);
    expect(eventBus.hasApprovalListeners('foreign')).toBe(true);

    hub.unregisterClient(client);
    expect(eventBus.hasApprovalListeners('foreign')).toBe(false);
  });

  it('обычный клиент подтверждает запрос своей сессии (per-session)', async () => {
    const { eventBus, hub } = makeHub(['mine']);
    const { client } = makeClient();
    await hub.registerClient(client);

    expect(eventBus.hasApprovalListeners('mine')).toBe(true);
    expect(eventBus.hasApprovalListeners('foreign')).toBe(false);
  });
});
