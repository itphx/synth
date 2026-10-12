import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBinding, SynthEvent } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { HookBus } from '../hooks/hook-bus.js';
import { EventRouter } from './event-router.js';
import { RequestSessionService, eventToMessage, eventToMessageText } from './request-session.js';
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

  const service = (
    router?: EventRouter,
    overrides?: {
      resolveAgentTemplate?: (template: string) => string | null;
      unknownAgentTemplate?: 'drop' | 'default-agent';
    },
  ) => new RequestSessionService({
    sessionManager,
    eventRouter: router ?? new EventRouter({ bindingStore, journal, hooks, config: { defaultEphemeralTtl: '24h' } }),
    bindingStore,
    hooks,
    config: {
      defaultEphemeralTtl: '24h',
      ...(overrides?.unknownAgentTemplate ? { unknownAgentTemplate: overrides.unknownAgentTemplate } : {}),
    },
    deliver,
    ...(overrides?.resolveAgentTemplate ? { resolveAgentTemplate: overrides.resolveAgentTemplate } : {}),
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

  it('handleEvent opts.binding форсирует привязку независимо от identity', async () => {
    const target = await sessionManager.createSession({ title: 'Bound' });
    const forced: EventBinding = {
      id: 'bnd_forced',
      source: 'telegram',
      chatKey: 'chat:forced',
      mode: 'bound',
      sessionId: target.id,
    };

    const e = event({ identity: {} });
    const { decision, session } = await service().handleEvent(e, { binding: forced });

    expect(decision).toEqual({ kind: 'bound', sessionId: target.id });
    expect(session?.id).toBe(target.id);
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

  it('handleEvent ephemeral с резолвером: валидный шаблон → settings.agentRole', async () => {
    const badRouter = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    badRouter.registerRuleProvider({
      name: 'ephemeral-valid',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: 'agent-x', ttl: '1h' }),
    });

    const e = event({ dedupKey: 'k-valid' });
    const { session } = await service(badRouter, {
      resolveAgentTemplate: (t) => (t === 'agent-x' ? 'agent-x' : null),
    }).handleEvent(e);

    expect(session).not.toBeNull();
    expect(session?.settings.agentRole).toBe('agent-x');
  });

  it('handleEvent ephemeral: неизвестный шаблон при drop → нет сессии, error agent_not_found', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badRouter = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    badRouter.registerRuleProvider({
      name: 'ephemeral-ghost',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: 'ghost', ttl: '1h' }),
    });

    const e = event({ dedupKey: 'k-ghost' });
    const { decision, session } = await service(badRouter, {
      resolveAgentTemplate: () => null,
      unknownAgentTemplate: 'drop',
    }).handleEvent(e);

    expect(decision.kind).toBe('ephemeral');
    expect(session).toBeNull();
    const entries = await journal.list();
    expect(entries[0]?.error).toContain('agent_not_found');
  });

  it('handleEvent ephemeral: неизвестный шаблон при default-agent → сессия без agentRole', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-default',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: 'ghost', ttl: '1h' }),
    });

    const e = event({ dedupKey: 'k-default' });
    const { session } = await service(router, {
      resolveAgentTemplate: () => null,
      unknownAgentTemplate: 'default-agent',
    }).handleEvent(e);

    expect(session).not.toBeNull();
    expect(session?.settings.agentRole).toBeUndefined();
  });

  it('handleEvent ephemeral: project из RouteDecision доезжает до сессии', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-project',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: '', ttl: '1h', project: 'proj-42' }),
    });

    const { session } = await service(router).handleEvent(event({ dedupKey: 'k-project' }));
    expect(session?.projectId).toBe('proj-42');
  });

  it('handleEvent auto-bind: создаёт постоянную сессию и EventBinding mode=bound', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true, autoBindAgentTemplate: 'agent-x' },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:1' }, dedupKey: 'k-bind-1' });
    const { decision, session } = await service(router, { resolveAgentTemplate: (t) => t }).handleEvent(e);

    expect(decision).toMatchObject({ kind: 'bind', signals: ['auto-bind'] });
    expect(session).not.toBeNull();
    // Постоянная сессия — без expiresAt (в отличие от ephemeral).
    expect(session?.expiresAt).toBeUndefined();
    expect(session?.settings.agentRole).toBe('agent-x');
    expect(deliver).toHaveBeenCalledWith(session!.id, e, 'run');

    const binding = await bindingStore.findByKey({ source: 'telegram', chatKey: 'chat:telegram:1' });
    expect(binding).toMatchObject({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      mode: 'bound',
      sessionId: session!.id,
      agentTemplate: 'agent-x',
    });
  });

  it('handleEvent auto-bind: повторное событие того же чата → та же сессия', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h', autoBind: true } });
    const first = await service(router).handleEvent(
      event({ identity: { chatKey: 'chat:telegram:9' }, dedupKey: 'k-bind-a' }),
    );
    const second = await service(router).handleEvent(
      event({ id: 'evt_2', identity: { chatKey: 'chat:telegram:9' }, dedupKey: 'k-bind-b' }),
    );

    // Второй раз привязка уже есть → явный binding ведёт в ту же сессию.
    expect(second.decision).toEqual({ kind: 'bound', sessionId: first.session!.id });
    expect(second.session?.id).toBe(first.session!.id);
    expect(await bindingStore.list()).toHaveLength(1);
  });

  it('handleEvent auto-bind: существующая привязка (гонка) → переиспользует сессию', async () => {
    const existingSession = await sessionManager.createSession({ title: 'Existing' });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:7',
      mode: 'bound',
      sessionId: existingSession.id,
    });
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h', autoBind: true } });
    // Форсированная привязка без sessionId: явный поиск в store пропускается, решение
    // падает в auto-bind-фоллбек → материализация находит уже существующую привязку.
    const forced: EventBinding = {
      id: 'bnd_race',
      source: 'telegram',
      chatKey: 'chat:telegram:7',
      mode: 'bound',
    };
    const e = event({ identity: { chatKey: 'chat:telegram:7' }, dedupKey: 'k-race' });
    const { decision, session } = await service(router).handleEvent(e, { binding: forced });

    expect(decision.kind).toBe('bind');
    expect(session?.id).toBe(existingSession.id);
    expect(deliver).toHaveBeenCalledWith(existingSession.id, e, 'run');
    // Новая привязка не создана.
    expect(await bindingStore.list()).toHaveLength(1);
  });

  it('request explicit: неизвестный шаблон при drop → ошибка agent_not_found', async () => {
    await expect(
      service(undefined, {
        resolveAgentTemplate: () => null,
        unknownAgentTemplate: 'drop',
      }).request({ initiator: 'user', intent: 'explicit', agentTemplate: 'ghost' }),
    ).rejects.toThrow('agent_not_found');
  });

  it('updateConfig: unknownAgentTemplate переключается drop → default-agent на лету', async () => {
    const svc = service(undefined, { resolveAgentTemplate: () => null, unknownAgentTemplate: 'drop' });
    await expect(
      svc.request({ initiator: 'user', intent: 'explicit', agentTemplate: 'ghost' }),
    ).rejects.toThrow('agent_not_found');

    svc.updateConfig({ unknownAgentTemplate: 'default-agent' });
    const created = await svc.request({ initiator: 'user', intent: 'explicit', agentTemplate: 'ghost' });
    expect(created).not.toBeNull();
    // Агент по умолчанию: agentRole не проставляется.
    expect(created?.settings?.agentRole).toBeUndefined();
  });

  it('updateConfig: defaultEphemeralTtl меняет TTL ephemeral-сессии на лету', async () => {
    const svc = service();
    svc.updateConfig({ defaultEphemeralTtl: '30s' });
    const created = await svc.request({ initiator: 'user', intent: 'explicit', mode: 'ephemeral' });
    expect(created).not.toBeNull();
    // parseTtl('30s') → ~30 c от текущего момента.
    const expiresAt = Date.parse(created!.expiresAt!);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
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

  it('handleEvent opts.audit пишет keyId/principalId в журнал (AD-089/AD-052)', async () => {
    const target = await sessionManager.createSession({ title: 'Bound' });
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:1', mode: 'bound', sessionId: target.id });

    const e = event({ identity: { chatKey: 'chat:telegram:1' } });
    await service().handleEvent(e, { audit: { keyId: 'eak_1', principalId: 'svc-1' } });

    const entries = await journal.list();
    expect(entries[0]?.keyId).toBe('eak_1');
    expect(entries[0]?.principalId).toBe('svc-1');
  });

  it('handleEvent без audit — журнал без keyId/principalId (обратная совместимость)', async () => {
    const e = event({ dedupKey: 'k-no-audit' });
    await service().handleEvent(e);

    const entries = await journal.list();
    expect(entries[0]?.keyId).toBeUndefined();
    expect(entries[0]?.principalId).toBeUndefined();
  });

  it('handleEvent: hook-blocked фиксирует audit в журнале (все ветки)', async () => {
    hooks.on('external_event', () => ({ block: true, reason: 'blocked by hook' }));

    const e = event({ dedupKey: 'k-blocked-audit' });
    await service().handleEvent(e, { audit: { keyId: 'eak_blocked' } });

    const entries = await journal.list();
    expect(entries[0]?.decision).toEqual({ kind: 'drop', reason: 'blocked by hook', audited: true });
    expect(entries[0]?.keyId).toBe('eak_blocked');
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

  it('eventToMessage: cron → author Scheduler, content = чистый текст задания, metadata расписания', () => {
    const e = event({
      source: 'cron',
      type: 'schedule_fired',
      payload: { scheduleId: 'sch_1', name: 'Nightly', text: 'make coffee' },
    });
    const msg = eventToMessage(e);

    expect(msg.author).toBe('Scheduler');
    expect(msg.content).toBe('make coffee');
    // Описание Scheduler — не в контенте, а в статическом system-блоке.
    expect(msg.content).not.toContain('[SCHEDULER]');
    expect(msg.content).not.toContain('планировщик');
    expect(msg.parts[0]?.data).toBe(msg.content);
    expect(msg.metadata).toMatchObject({
      scheduler: true,
      schedule_id: 'sch_1',
      schedule_name: 'Nightly',
      source: 'cron',
      event_id: 'evt_1',
      dedup_key: 'dedup-1',
    });
  });

  it('eventToMessage: cron без name → только текст, schedule_id из payload', () => {
    const e = event({ source: 'cron', payload: { scheduleId: 'sch_9', text: 't' } });
    const msg = eventToMessage(e);
    expect(msg.author).toBe('Scheduler');
    expect(msg.content).toBe('t');
    expect(msg.metadata?.scheduler).toBe(true);
    expect(msg.metadata?.schedule_id).toBe('sch_9');
    expect(msg.metadata?.schedule_name).toBeUndefined();
  });

  it('eventToMessage: не-cron → author undefined и контент не меняется', () => {
    const e = event({ source: 'webhook', payload: { text: 'hello' } });
    const msg = eventToMessage(e);

    expect(msg.author).toBeUndefined();
    expect(msg.content).toBe('hello');
    expect(msg.metadata).toEqual({
      source: 'webhook',
      event_id: 'evt_1',
      dedup_key: 'dedup-1',
    });
  });
});
