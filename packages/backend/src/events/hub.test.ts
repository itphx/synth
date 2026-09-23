import { describe, it, expect } from 'vitest';
import { EventBus } from '@itphx/synth-core';
import type { SessionManager } from '@itphx/synth-core';
import type { BusEvent } from '@itphx/synth-shared';
import { EventHub, type EventClient } from './hub.js';

function makeHub(existingSessions: string[] = []) {
  const eventBus = new EventBus();
  const sessionManager = {
    listSessions: async () => existingSessions.map((id) => ({ id })),
  } as unknown as SessionManager;
  const hub = new EventHub(eventBus, sessionManager);
  return { eventBus, hub };
}

function makeClient() {
  const received: BusEvent[] = [];
  const client: EventClient = {
    userId: 'u1',
    username: 'u1',
    send: (event: BusEvent) => received.push(event),
  };
  return { client, received };
}

describe('EventHub — автоподписка на дочерние сессии', () => {
  it('подписывает клиента на child из session.created родителя и доставляет его stream.usage', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'session.created', { id: 'child-1', parentId: 'parent' });
    eventBus.publish('child-1', 'stream.usage', { session_id: 'child-1', outputTokens: 42 });

    const usage = received.find((e) => e.type === 'stream.usage');
    expect(usage).toBeDefined();
    expect(usage!.sessionId).toBe('child-1');
    expect(usage!.data.session_id).toBe('child-1');
  });

  it('подписывает клиента на child из child.session.updated родителя', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'child.session.updated', { session: { id: 'child-2' } });
    eventBus.publish('child-2', 'stream.usage', { session_id: 'child-2', outputTokens: 7 });

    expect(received.some((e) => e.type === 'stream.usage' && e.sessionId === 'child-2')).toBe(true);
  });

  it('подписывает клиента на child из child.message.added (child_session_id)', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'child.message.added', { child_session_id: 'child-3' });
    eventBus.publish('child-3', 'stream.usage', { session_id: 'child-3' });

    expect(received.some((e) => e.type === 'stream.usage' && e.sessionId === 'child-3')).toBe(true);
  });

  it('подписывает клиента на child из subagent.resume.started', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('parent', 'subagent.resume.started', { child_session_id: 'child-4' });
    eventBus.publish('child-4', 'stream.usage', { session_id: 'child-4' });

    expect(received.some((e) => e.type === 'stream.usage' && e.sessionId === 'child-4')).toBe(true);
  });

  it('не подписывает клиента на чужую/необъявленную сессию', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);

    eventBus.publish('foreign', 'stream.usage', { session_id: 'foreign' });

    expect(received.some((e) => e.type === 'stream.usage' && e.sessionId === 'foreign')).toBe(false);
  });

  it('не подписывает на сессию, если клиент отписан (unregister)', async () => {
    const { eventBus, hub } = makeHub(['parent']);
    const { client, received } = makeClient();
    await hub.registerClient(client);
    hub.unregisterClient(client);

    eventBus.publish('parent', 'session.created', { id: 'child-5' });
    eventBus.publish('child-5', 'stream.usage', { session_id: 'child-5' });

    expect(received.some((e) => e.type === 'stream.usage')).toBe(false);
  });
});
