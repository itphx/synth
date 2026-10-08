import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SynthEvent } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { HookBus } from '../hooks/hook-bus.js';
import { EventRouter } from './event-router.js';
import { RequestSessionService, eventToMessageText } from './request-session.js';
import type { EventDelivery } from './types.js';

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'telegram',
  type: 'message',
  payload: { text: 'hi' },
  identity: {},
  dedupKey: 'dedup-1',
  ts: new Date().toISOString(),
  ...overrides,
});

describe('RequestSessionService (AD-089)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let bindingStore: EventBindingStore;
  let journal: EventJournalStore;
  let hooks: HookBus;
  let deliver: Mock<EventDelivery>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-request-session-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
    hooks = new HookBus();
    deliver = vi.fn<EventDelivery>(async () => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const service = (router?: EventRouter) => new RequestSessionService({
    sessionManager,
    eventRouter: router ?? new EventRouter({ bindingStore, journal, hooks, config: { defaultEphemeralTtl: '24h' } }),
    hooks,
    config: { defaultEphemeralTtl: '24h' },
    deliver,
  });

  it('request explicit создаёт сессию без expiresAt и доставки', async () => {
    const created = await service().request({
      initiator: 'user',
      intent: 'explicit',
      title: 'Explicit session',
      projectId: 'p1',
    });
    expect(created).not.toBeNull();
    expect(created?.title).toBe('Explicit session');
    expect(created?.projectId).toBe('p1');
    expect(created?.expiresAt).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('request explicit с mode=ephemeral ставит expiresAt по TTL', async () => {
    const before = Date.now();
    const created = await service().request({
      initiator: 'user',
      intent: 'explicit',
      mode: 'ephemeral',
      ttl: '1h',
    });
    expect(created?.expiresAt).toBeDefined();
    const expires = Date.parse(created!.expiresAt!);
    expect(expires).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(expires).toBeLessThanOrEqual(before + 61 * 60_000);
  });

  it('request explicit прокидывает sessionOrigin и parentId', async () => {
    const created = await service().request({
      initiator: 'agent',
      intent: 'explicit',
      sessionOrigin: 'subagent',
      parentId: 'parent-1',
    });
    expect(created?.sessionOrigin).toBe('subagent');
    expect(created?.parentId).toBe('parent-1');
  });

  it('handleEvent bound → deliver(run) в привязанную сессию', async () => {
    const target = await sessionManager.createSession({ title: 'Bound' });
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: target.id });

    const e = event({ identity: { chatKey: 'chat:telegram:1' } });
    const { decision, session } = await service().handleEvent(e);

    expect(decision).toEqual({ kind: 'bound', sessionId: target.id });
    expect(session?.id).toBe(target.id);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run');
  });

  it('handleEvent ephemeral → создаёт сессию с TTL/agentRole и deliver(run)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      mode: 'ephemeral',
      agentTemplate: 'agent-x',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:1' } });
    const { decision, session } = await service().handleEvent(e);

    expect(decision.kind).toBe('ephemeral');
    expect(session).not.toBeNull();
    expect(session?.expiresAt).toBeDefined();
    expect(session?.settings.agentRole).toBe('agent-x');
    expect(deliver).toHaveBeenCalledWith(session!.id, e, 'run');
  });

  it('handleEvent queue → deliver(defer) владельцу, процессор не стартует', async () => {
    const owner = await sessionManager.createSession({ title: 'Owner' });
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'queue', sessionId: owner.id });

    const e = event({ identity: { chatKey: 'chat:telegram:1' } });
    const { decision, session } = await service().handleEvent(e);

    expect(decision).toEqual({ kind: 'queue', owner: owner.id, reason: 'binding' });
    expect(session?.id).toBe(owner.id);
    expect(deliver).toHaveBeenCalledWith(owner.id, e, 'defer');
  });

  it('handleEvent drop → сессия null, доставки нет', async () => {
    const e = event();
    const { decision, session } = await service().handleEvent(e);

    expect(decision).toEqual({ kind: 'drop', reason: 'no_route', audited: true });
    expect(session).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('external_event hook block:true → drop без материализации', async () => {
    hooks.on('external_event', () => ({ block: true, reason: 'blocked by hook' }));

    const created = await sessionManager.createSession({ title: 'Blocked' });
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: created.id });

    const e = event({ identity: { chatKey: 'chat:telegram:1' } });
    const { decision, session } = await service().handleEvent(e);

    expect(decision).toEqual({ kind: 'drop', reason: 'blocked by hook', audited: true });
    expect(session).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('handleEvent пишет решение в журнал', async () => {
    const e = event({ dedupKey: 'k-journal' });
    await service().handleEvent(e);

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.id).toBe(e.id);
    expect(entries[0]?.decision).toEqual({ kind: 'drop', reason: 'no_route', audited: true });
  });

  it('ошибка материализации не пробрасывается: record с error, session null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badRouter = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    badRouter.registerRuleProvider({
      name: 'bad-ttl',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: '', ttl: 'not-a-duration' }),
    });

    const e = event({ dedupKey: 'k-error' });
    const { decision, session } = await service(badRouter).handleEvent(e);

    expect(decision.kind).toBe('ephemeral');
    expect(session).toBeNull();
    const entries = await journal.list();
    expect(entries[0]?.error).toBeDefined();
  });

  it('eventToMessageText: text-поле, JSON-fallback и пустой payload', () => {
    expect(eventToMessageText(event({ payload: { text: 'hello' } }))).toBe('hello');
    expect(eventToMessageText(event({ payload: { a: 1 } }))).toBe('{"a":1}');
    expect(eventToMessageText(event({ payload: 'plain' }))).toBe('"plain"');
    expect(eventToMessageText(event({ payload: undefined }))).toBe('');
  });
});
