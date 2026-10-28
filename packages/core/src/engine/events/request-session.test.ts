import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventAttachmentRef, EventBinding, EventIdentity, Session, SynthEvent } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { HookBus } from '../hooks/hook-bus.js';
import { EventRouter } from './event-router.js';
import { RequestSessionService, eventToMessage, eventToMessageText, addEventAttachmentRefs } from './request-session.js';
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

describe('RequestSessionService (ADR-089)', () => {
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
      resolveOwnerId?: () => string | Promise<string | undefined>;
      resolveLlmDefaults?: () => { provider?: string; model?: string } | Promise<{ provider?: string; model?: string }>;
      resolveDefaultAgent?: () => string | Promise<string>;
      resolveExternalIdentity?: (identity: EventIdentity) => { userId: string; displayName?: string; roles?: string[] } | null | Promise<{ userId: string; displayName?: string; roles?: string[] } | null>;
      identityMap?: Record<string, string>;
      onSessionMaterialized?: (session: Session) => void | Promise<void>;
      issueIdentityClaim?: (event: SynthEvent) => Promise<{ code: string; expiresAt: string } | null>;
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
    ...(overrides?.resolveOwnerId ? { resolveOwnerId: overrides.resolveOwnerId } : {}),
    ...(overrides?.resolveLlmDefaults ? { resolveLlmDefaults: overrides.resolveLlmDefaults } : {}),
    ...(overrides?.resolveDefaultAgent ? { resolveDefaultAgent: overrides.resolveDefaultAgent } : {}),
    ...(overrides?.resolveExternalIdentity ? { resolveExternalIdentity: overrides.resolveExternalIdentity } : {}),
    ...(overrides?.identityMap ? { identityMap: overrides.identityMap } : {}),
    ...(overrides?.onSessionMaterialized ? { onSessionMaterialized: overrides.onSessionMaterialized } : {}),
    ...(overrides?.issueIdentityClaim ? { issueIdentityClaim: overrides.issueIdentityClaim } : {}),
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
    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: false });
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
    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: false });
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
    expect(deliver).toHaveBeenCalledWith(session!.id, e, 'run', { roles: [], linked: false });
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

  // --- ADR-089: агент по умолчанию инстанса для событийных сессий ---
  // Баг: сессии, материализуемые funnel'ом (auto-bind/bind/ephemeral), создавались
  // без `settings.agentRole`, поэтому оркестратор не писал `agent` в assistant-сообщение
  // и UI не рисовал бейдж агента. Фикс: при пустом шаблоне применяем `resolveDefaultAgent`.

  it('handleEvent ephemeral: без agentTemplate + resolveDefaultAgent → settings.agentRole = default', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-no-agent',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: '', ttl: '1h' }),
    });

    const e = event({ dedupKey: 'k-default-agent-ephemeral' });
    const { session } = await service(router, {
      resolveDefaultAgent: () => 'assistant',
    }).handleEvent(e);

    expect(session).not.toBeNull();
    expect(session?.settings.agentRole).toBe('assistant');
  });

  it('handleEvent auto-bind: без agentTemplate + resolveDefaultAgent → settings.agentRole = default', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:default-agent' }, dedupKey: 'k-default-agent-bind' });
    const { session } = await service(router, {
      resolveDefaultAgent: () => 'assistant',
    }).handleEvent(e);

    expect(session).not.toBeNull();
    expect(session?.settings.agentRole).toBe('assistant');
  });

  it('handleEvent: явный agentTemplate приоритетнее resolveDefaultAgent (дефолт не применяется)', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-explicit-agent',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: 'agent-x', ttl: '1h' }),
    });
    const resolveDefaultAgent = vi.fn(() => 'assistant');

    const e = event({ dedupKey: 'k-explicit-agent-over-default' });
    const { session } = await service(router, {
      resolveAgentTemplate: (t) => (t === 'agent-x' ? 'agent-x' : null),
      resolveDefaultAgent,
    }).handleEvent(e);

    expect(session?.settings.agentRole).toBe('agent-x');
    expect(resolveDefaultAgent).not.toHaveBeenCalled();
  });

  it('handleEvent ephemeral: резолвер не задан, шаблон пуст → agentRole отсутствует (прежнее поведение)', async () => {
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-no-resolver',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: '', ttl: '1h' }),
    });

    const e = event({ dedupKey: 'k-no-default-agent' });
    const { session } = await service(router).handleEvent(e);

    expect(session).not.toBeNull();
    expect(session?.settings.agentRole).toBeUndefined();
  });

  it('регресс: неизвестный шаблон при drop не подменяется дефолтом (нет сессии)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const router = new EventRouter({ bindingStore, journal, config: { defaultEphemeralTtl: '24h' } });
    router.registerRuleProvider({
      name: 'ephemeral-ghost-default',
      resolve: () => ({ kind: 'ephemeral', agentTemplate: 'ghost', ttl: '1h' }),
    });
    const resolveDefaultAgent = vi.fn(() => 'assistant');

    const e = event({ dedupKey: 'k-ghost-default' });
    const { session } = await service(router, {
      resolveAgentTemplate: () => null,
      unknownAgentTemplate: 'drop',
      resolveDefaultAgent,
    }).handleEvent(e);

    // Политика `drop` — исключение при материализации; дефолт агента не спасает.
    expect(session).toBeNull();
    const entries = await journal.list();
    expect(entries[0]?.error).toContain('agent_not_found');
    expect(resolveDefaultAgent).not.toHaveBeenCalled();
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
    expect(deliver).toHaveBeenCalledWith(session!.id, e, 'run', { roles: [], linked: false });

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
    expect(deliver).toHaveBeenCalledWith(existingSession.id, e, 'run', { roles: [], linked: false });
    // Новая привязка не создана.
    expect(await bindingStore.list()).toHaveLength(1);
  });

  it('handleEvent ephemeral: владелец из deps.resolveOwnerId (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:own',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:own' } });
    const { session } = await service(undefined, { resolveOwnerId: () => 'local' }).handleEvent(e);

    expect(session?.userId).toBe('local');
    expect(session?.ownerId).toBe('local');
  });

  it('handleEvent auto-bind: владелец из deps.resolveOwnerId (ADR-089)', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:owner-bind' }, dedupKey: 'k-owner-bind' });
    const { session } = await service(router, { resolveOwnerId: () => 'local' }).handleEvent(e);

    expect(session?.userId).toBe('local');
    expect(session?.ownerId).toBe('local');
  });

  it('handleEvent opts.ownerId переопределяет deps.resolveOwnerId (ADR-089)', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:owner-explicit' }, dedupKey: 'k-owner-explicit' });
    const { session } = await service(router, { resolveOwnerId: () => 'local' })
      .handleEvent(e, { ownerId: 'u-42' });

    expect(session?.userId).toBe('u-42');
    expect(session?.ownerId).toBe('u-42');
  });

  it('handleEvent без резолвера/opts → владелец не задан (principalId — не id инстанса) (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:cron',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:cron', principalId: 'tg:999' } });
    const { session } = await service().handleEvent(e);

    // Внешний идентификатор (`tg:999`) не подставляется как id пользователя
    // инстанса: без резолвера/маппинга владелец не проставляется.
    expect(session?.ownerId).toBe('');
  });

  it('handleEvent: identityMap по chatKey задаёт владельца сессии (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:42',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:42' } });
    const { session } = await service(undefined, {
      identityMap: { 'chat:telegram:42': 'u-human' },
    }).handleEvent(e, { ownerId: 'machine-account' });

    // identityMap приоритетнее per-event владельца (машинного аккаунта).
    expect(session?.userId).toBe('u-human');
    expect(session?.ownerId).toBe('u-human');
  });

  it('handleEvent: identityMap по principalId задаёт владельца (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:pi',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:pi', principalId: 'tg:777' } });
    const { session } = await service(undefined, {
      identityMap: { 'tg:777': 'u-tg' },
    }).handleEvent(e);

    expect(session?.ownerId).toBe('u-tg');
  });

  it('handleEvent: principalId из identityMap приоритетнее chatKey (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:both',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:both', principalId: 'tg:1' } });
    const { session } = await service(undefined, {
      identityMap: { 'chat:telegram:both': 'u-chat', 'tg:1': 'u-principal' },
    }).handleEvent(e);

    // Владельца определяет человек (principalId), а не чат.
    expect(session?.ownerId).toBe('u-principal');
  });

  it('handleEvent: резолвер внешней идентичности переопределяет identityMap (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:resolver',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:resolver', principalId: 'tg:55' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: (identity) =>
        identity.principalId === 'tg:55' ? { userId: 'u-resolved', displayName: 'Пётр' } : null,
      identityMap: { 'tg:55': 'u-map' },
    }).handleEvent(e);

    expect(session?.ownerId).toBe('u-resolved');
  });

  it('handleEvent: резолвер внешней идентичности > identityMap(principalId) > identityMap(chatKey) > per-event > resolveOwnerId (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:prio',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    // Резолвер внешней идентичности — высший приоритет.
    const withResolver = event({ dedupKey: 'k-prio-resolver', identity: { chatKey: 'chat:telegram:prio', principalId: 'tg:66' } });
    const r1 = await service(undefined, {
      resolveExternalIdentity: (identity) => ({ userId: `u-ext:${identity.principalId}` }),
      identityMap: { 'tg:66': 'u-map-principal', 'chat:telegram:prio': 'u-map-chat' },
      resolveOwnerId: () => 'local',
    }).handleEvent(withResolver, { ownerId: 'u-event' });
    expect(r1.session?.ownerId).toBe('u-ext:tg:66');

    // Нет резолвера → identityMap по principalId.
    const mapPrincipalEvent = event({ dedupKey: 'k-prio-map-principal', identity: { chatKey: 'chat:telegram:prio', principalId: 'tg:66' } });
    const r2 = await service(undefined, {
      identityMap: { 'tg:66': 'u-map-principal', 'chat:telegram:prio': 'u-map-chat' },
      resolveOwnerId: () => 'local',
    }).handleEvent(mapPrincipalEvent, { ownerId: 'u-event' });
    expect(r2.session?.ownerId).toBe('u-map-principal');

    // Нет резолвера и principalId в карте → chatKey.
    const mapChatEvent = event({ dedupKey: 'k-prio-map-chat', identity: { chatKey: 'chat:telegram:prio', principalId: 'tg:66' } });
    const r3 = await service(undefined, {
      identityMap: { 'chat:telegram:prio': 'u-map-chat' },
      resolveOwnerId: () => 'local',
    }).handleEvent(mapChatEvent, { ownerId: 'u-event' });
    expect(r3.session?.ownerId).toBe('u-map-chat');

    // Нет резолвера/карты → per-event владелец.
    const perEventEvent = event({ dedupKey: 'k-prio-per-event', identity: { chatKey: 'chat:telegram:prio', principalId: 'tg:66' } });
    const r4 = await service(undefined, { resolveOwnerId: () => 'local' })
      .handleEvent(perEventEvent, { ownerId: 'u-event' });
    expect(r4.session?.ownerId).toBe('u-event');

    // Нет резолвера/карты/per-event → resolveOwnerId.
    const fallbackEvent = event({ dedupKey: 'k-prio-fallback', identity: { chatKey: 'chat:telegram:prio', principalId: 'tg:66' } });
    const r5 = await service(undefined, { resolveOwnerId: () => 'local' }).handleEvent(fallbackEvent);
    expect(r5.session?.ownerId).toBe('local');
  });

  it('handleEvent: чат не определяет владельца при наличии principalId (резолвер) (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:group',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    // Группа: chatKey = группа, principalId = автор. Владелец — автор.
    const e = event({ identity: { chatKey: 'chat:telegram:group', principalId: 'tg:author' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: (identity) => ({ userId: `user:${identity.principalId}` }),
      resolveOwnerId: () => 'local',
    }).handleEvent(e);

    expect(session?.ownerId).toBe('user:tg:author');
  });

  it('handleEvent: без совпадения в identityMap — прежняя логика (opts.ownerId) (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:nomatch',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:nomatch' } });
    const { session } = await service(undefined, {
      identityMap: { 'chat:telegram:other': 'u-other' },
    }).handleEvent(e, { ownerId: 'u-agent' });

    expect(session?.ownerId).toBe('u-agent');
  });

  it('onSessionMaterialized: вызывается для explicit-сессии с её владельцем (ADR-089)', async () => {
    const onMaterialized = vi.fn();
    const created = await service(undefined, { onSessionMaterialized: onMaterialized }).request(
      { initiator: 'user', intent: 'explicit' },
      { userId: 'u-explicit' },
    );

    expect(onMaterialized).toHaveBeenCalledOnce();
    expect(onMaterialized).toHaveBeenCalledWith(expect.objectContaining({ id: created!.id, userId: 'u-explicit' }));
  });

  it('onSessionMaterialized: вызывается для materialized auto-bind до deliver (ADR-089)', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const calls: string[] = [];
    const onMaterialized = vi.fn((session: Session) => { calls.push(`materialized:${session.id}`); });
    const deliverOrdered = vi.fn<EventDelivery>(async (sid) => { calls.push(`deliver:${sid}`); });

    const svc = new RequestSessionService({
      sessionManager,
      eventRouter: router,
      bindingStore,
      hooks,
      config: { defaultEphemeralTtl: '24h' },
      deliver: deliverOrdered,
      onSessionMaterialized: onMaterialized,
    });

    const e = event({ identity: { chatKey: 'chat:telegram:on-mat' }, dedupKey: 'k-on-mat' });
    const { session } = await svc.handleEvent(e);

    expect(onMaterialized).toHaveBeenCalledOnce();
    expect(onMaterialized).toHaveBeenCalledWith(expect.objectContaining({ id: session!.id }));
    // Подписка (callback) — строго до доставки, иначе события сессии теряются.
    expect(calls).toEqual([`materialized:${session!.id}`, `deliver:${session!.id}`]);
  });

  it('handleEvent без владельца → сессия без ownerId (обратная совместимость)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:none',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:none' } });
    const { session } = await service().handleEvent(e);

    expect(session?.userId).toBe('');
    expect(session?.ownerId).toBe('');
  });

  it('handleEvent ephemeral: дефолтные provider/model из deps.resolveLlmDefaults (ADR-089)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:def',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:def' } });
    const { session } = await service(undefined, {
      resolveLlmDefaults: () => ({ provider: 'p-def', model: 'm-def' }),
    }).handleEvent(e);

    expect(session?.settings.provider).toBe('p-def');
    expect(session?.settings.model).toBe('m-def');
  });

  it('handleEvent auto-bind: дефолтные provider/model из deps.resolveLlmDefaults (ADR-089)', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:def-bind' }, dedupKey: 'k-def-bind' });
    const { session } = await service(router, {
      resolveLlmDefaults: () => ({ provider: 'p-def', model: 'm-def' }),
    }).handleEvent(e);

    expect(session?.settings.provider).toBe('p-def');
    expect(session?.settings.model).toBe('m-def');
  });

  it('handleEvent ephemeral: без резолвера дефолтов provider/model не заданы (обратная совместимость)', async () => {
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:nodef',
      mode: 'ephemeral',
      agentTemplate: '',
    });

    const e = event({ identity: { chatKey: 'chat:telegram:nodef' } });
    const { session } = await service().handleEvent(e);

    expect(session?.settings.provider).toBeUndefined();
    expect(session?.settings.model).toBeUndefined();
  });

  it('request explicit: дефолтные provider/model из deps.resolveLlmDefaults (ADR-089)', async () => {
    const created = await service(undefined, {
      resolveLlmDefaults: () => ({ provider: 'p-def', model: 'm-def' }),
    }).request({ initiator: 'user', intent: 'explicit' });

    expect(created?.settings.provider).toBe('p-def');
    expect(created?.settings.model).toBe('m-def');
  });

  it('request explicit: явные provider/model приоритетнее дефолтов (ADR-089)', async () => {
    const created = await service(undefined, {
      resolveLlmDefaults: () => ({ provider: 'p-def', model: 'm-def' }),
    }).request({
      initiator: 'user',
      intent: 'explicit',
      settings: { provider: 'p-explicit', model: 'm-explicit' },
    });

    expect(created?.settings.provider).toBe('p-explicit');
    expect(created?.settings.model).toBe('m-explicit');
  });

  it('request explicit: частичное переопределение — задан provider, model добирается из дефолта (ADR-089)', async () => {
    const created = await service(undefined, {
      resolveLlmDefaults: () => ({ provider: 'p-def', model: 'm-def' }),
    }).request({
      initiator: 'user',
      intent: 'explicit',
      settings: { provider: 'p-explicit' },
    });

    expect(created?.settings.provider).toBe('p-explicit');
    expect(created?.settings.model).toBe('m-def');
  });

  it('request explicit: пустые дефолты не заполняют provider/model (ADR-089)', async () => {
    const created = await service(undefined, {
      resolveLlmDefaults: () => ({ provider: '', model: '' }),
    }).request({ initiator: 'user', intent: 'explicit' });

    expect(created?.settings.provider).toBeUndefined();
    expect(created?.settings.model).toBeUndefined();
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
    expect(deliver).toHaveBeenCalledWith(owner.id, e, 'defer', { roles: [], linked: false });
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

  it('handleEvent opts.audit пишет keyId/principalId в журнал (ADR-089/ADR-052)', async () => {
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

  // --- ADR-089 (этап 5): эффективные роли отправителя в deliver ---

  const boundTo = async (chatKey: string): Promise<Session> => {
    const target = await sessionManager.createSession({ title: 'Bound' });
    await bindingStore.upsert({ source: 'telegram', chatKey, mode: 'bound', sessionId: target.id });
    return target;
  };

  it('deliver получает эффективные роли: профиль ADMIN, identity.roles не заданы → [ADMIN]', async () => {
    const target = await boundTo('chat:telegram:roles-a');
    const e = event({ identity: { chatKey: 'chat:telegram:roles-a', principalId: 'tg:1' } });

    await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-admin', roles: ['ADMIN'] }),
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: ['ADMIN'], linked: true });
  });

  it('deliver: identity.roles сужают роли профиля (ADMIN+USER ∩ USER → [USER])', async () => {
    const target = await boundTo('chat:telegram:roles-b');
    const e = event({
      identity: { chatKey: 'chat:telegram:roles-b', principalId: 'tg:2', roles: ['USER'] },
    });

    await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-1', roles: ['ADMIN', 'USER'] }),
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: ['USER'], linked: true });
  });

  it('deliver: identity.roles ADMIN не повышают профиль USER → пусто, linked', async () => {
    const target = await boundTo('chat:telegram:roles-c');
    const e = event({
      identity: { chatKey: 'chat:telegram:roles-c', principalId: 'tg:3', roles: ['ADMIN'] },
    });

    await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-user', roles: ['USER'] }),
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: true });
  });

  it('deliver: несопознанный отправитель → ролей нет, linked=false (fail-closed)', async () => {
    const target = await boundTo('chat:telegram:roles-d');
    const e = event({
      identity: { chatKey: 'chat:telegram:roles-d', principalId: 'tg:4', roles: ['ADMIN'] },
    });

    await service(undefined, {
      resolveExternalIdentity: () => null,
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: false });
  });

  it('deliver: без резолвера (профиль неизвестен) → ролей нет, linked=false', async () => {
    const target = await boundTo('chat:telegram:roles-e');
    const e = event({
      identity: { chatKey: 'chat:telegram:roles-e', principalId: 'tg:5', roles: ['ADMIN'] },
    });

    const { decision, session } = await service().handleEvent(e);

    expect(decision).toEqual({ kind: 'bound', sessionId: target.id });
    expect(session?.id).toBe(target.id);
    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: false });
  });

  it('deliver: резолвер без roles (override identityMap) → пустые роли, linked=true', async () => {
    const target = await boundTo('chat:telegram:roles-f');
    const e = event({ identity: { chatKey: 'chat:telegram:roles-f', principalId: 'tg:6' } });

    await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-map' }),
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(target.id, e, 'run', { roles: [], linked: true });
  });

  it('deliver: queue-режим тоже несёт контекст ролей', async () => {
    const owner = await sessionManager.createSession({ title: 'Queue owner' });
    await bindingStore.upsert({ source: 'telegram', chatKey: 'chat:telegram:roles-q', mode: 'queue', sessionId: owner.id });
    const e = event({ identity: { chatKey: 'chat:telegram:roles-q', principalId: 'tg:7' } });

    await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-lead', roles: ['LEAD'] }),
    }).handleEvent(e);

    expect(deliver).toHaveBeenCalledWith(owner.id, e, 'defer', { roles: ['LEAD'], linked: true });
  });

  // --- ADR-089 (claim-flow): переустановка владельца существующей сессии ---

  it('bound: машинный владелец (service:key) → сопознанный человек «забирает» сессию', async () => {
    const machine = await sessionManager.createSession({
      title: 'Bound machine',
      userId: 'service:svk_1',
      ownerId: 'service:svk_1',
    });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:reassign',
      mode: 'bound',
      sessionId: machine.id,
    });

    const onMaterialized = vi.fn();
    const e = event({ identity: { chatKey: 'chat:telegram:reassign', principalId: 'tg:555' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: (identity) =>
        identity.principalId === 'tg:555' ? { userId: 'u-human' } : null,
      onSessionMaterialized: onMaterialized,
    }).handleEvent(e);

    expect(session?.id).toBe(machine.id);
    expect(session?.ownerId).toBe('u-human');
    expect(session?.userId).toBe('u-human');
    // Изменение сохранено в хранилище (переживает перезагрузку сессии).
    const reloaded = await sessionManager.getSession(machine.id);
    expect(reloaded?.ownerId).toBe('u-human');
    expect(reloaded?.userId).toBe('u-human');
    // Хаб уведомлён — клиенты нового владельца подписываются на сессию.
    expect(onMaterialized).toHaveBeenCalledOnce();
    expect(onMaterialized).toHaveBeenCalledWith(
      expect.objectContaining({ id: machine.id, ownerId: 'u-human' }),
    );
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('bound: сессия без владельца → сопознанный человек проставляет владельца', async () => {
    const ownerless = await sessionManager.createSession({ title: 'Ownerless' });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:ownerless',
      mode: 'bound',
      sessionId: ownerless.id,
    });

    const e = event({ identity: { chatKey: 'chat:telegram:ownerless', principalId: 'tg:556' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-first' }),
    }).handleEvent(e);

    expect(session?.ownerId).toBe('u-first');
    expect(session?.userId).toBe('u-first');
    expect((await sessionManager.getSession(ownerless.id))?.ownerId).toBe('u-first');
  });

  it('bound: «чужая человеческая» сессия (владелец A, пишет B) → владелец не меняется (нет угона)', async () => {
    const human = await sessionManager.createSession({
      title: 'Human A',
      userId: 'u-a',
      ownerId: 'u-a',
    });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:group-owners',
      mode: 'bound',
      sessionId: human.id,
    });

    const onMaterialized = vi.fn();
    const e = event({
      identity: { chatKey: 'chat:telegram:group-owners', principalId: 'tg:b' },
    });
    const { session } = await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-b' }),
      onSessionMaterialized: onMaterialized,
    }).handleEvent(e);

    expect(session?.ownerId).toBe('u-a');
    expect(session?.userId).toBe('u-a');
    expect((await sessionManager.getSession(human.id))?.ownerId).toBe('u-a');
    // Переподписка не требуется — владелец не менялся.
    expect(onMaterialized).not.toHaveBeenCalled();
    // Доставка состоялась несмотря на то, что владелец остался прежним.
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('bound: несопознанный отправитель → владелец (машинный) не трогается', async () => {
    const machine = await sessionManager.createSession({
      title: 'Machine',
      userId: 'service:svk_2',
      ownerId: 'service:svk_2',
    });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:unknown',
      mode: 'bound',
      sessionId: machine.id,
    });

    const e = event({ identity: { chatKey: 'chat:telegram:unknown', principalId: 'tg:999' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: () => null,
    }).handleEvent(e);

    expect(session?.ownerId).toBe('service:svk_2');
    expect(session?.userId).toBe('service:svk_2');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('bound: ошибка резолвера → владелец не трогается, доставка выполняется (fail-safe)', async () => {
    const machine = await sessionManager.createSession({ ownerId: 'service:svk_3', userId: 'service:svk_3' });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:resolver-throws',
      mode: 'bound',
      sessionId: machine.id,
    });

    const e = event({ identity: { chatKey: 'chat:telegram:resolver-throws', principalId: 'tg:1' } });
    const { session } = await service(undefined, {
      resolveExternalIdentity: () => {
        throw new Error('profile store failed');
      },
    }).handleEvent(e);

    expect(session?.ownerId).toBe('service:svk_3');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('bind (существующая привязка, повтор/гонка): машинный владелец → переустанавливается человеку', async () => {
    const existing = await sessionManager.createSession({
      title: 'Race machine',
      userId: 'service:svk_4',
      ownerId: 'service:svk_4',
    });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:race-owner',
      mode: 'bound',
      sessionId: existing.id,
    });
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const onMaterialized = vi.fn();
    // Форсированная привязка без sessionId → материализация находит существующую.
    const forced: EventBinding = {
      id: 'bnd_race_owner',
      source: 'telegram',
      chatKey: 'chat:telegram:race-owner',
      mode: 'bound',
    };
    const e = event({ identity: { chatKey: 'chat:telegram:race-owner', principalId: 'tg:777' }, dedupKey: 'k-race-owner' });
    const { decision, session } = await service(router, {
      resolveExternalIdentity: () => ({ userId: 'u-linked' }),
      onSessionMaterialized: onMaterialized,
    }).handleEvent(e, { binding: forced });

    expect(decision.kind).toBe('bind');
    expect(session?.id).toBe(existing.id);
    expect(session?.ownerId).toBe('u-linked');
    expect((await sessionManager.getSession(existing.id))?.userId).toBe('u-linked');
    expect(onMaterialized).toHaveBeenCalledWith(expect.objectContaining({ id: existing.id }));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('bound (claim-flow): конкурентная правка сессии не теряется при переустановке владельца', async () => {
    const machine = await sessionManager.createSession({
      title: 'RMW',
      userId: 'service:svk_rmw',
      ownerId: 'service:svk_rmw',
    });
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:rmw',
      mode: 'bound',
      sessionId: machine.id,
    });

    // Резолвер вызывается дважды: (1) `_resolveDeliveryContext` (до чтения сессии),
    // (2) `_maybeReassignOwner` (после чтения). На втором вызове «зависаем», чтобы
    // вклинить конкурентную правку ровно в анализируемое окно read-modify-write.
    let calls = 0;
    let enteredReassign!: () => void;
    const enteredP = new Promise<void>((r) => { enteredReassign = r; });
    let releaseResolver!: () => void;
    const releaseP = new Promise<void>((r) => { releaseResolver = r; });
    const resolveExternalIdentity = async (): Promise<{ userId: string }> => {
      calls += 1;
      if (calls === 2) { enteredReassign(); await releaseP; }
      return { userId: 'u-human' };
    };

    const e = event({ identity: { chatKey: 'chat:telegram:rmw', principalId: 'tg:1' } });
    const pending = service(undefined, { resolveExternalIdentity }).handleEvent(e);
    await enteredP;

    // Конкурентная правка сессии «под локом» (как это делают роуты/тулы).
    await sessionManager.withLock(machine.id, async (s) => {
      s.icon = 'folder';
      await sessionManager.updateSession(s);
    });

    releaseResolver();
    const { session } = await pending;

    expect(session?.ownerId).toBe('u-human');
    const reloaded = await sessionManager.getSession(machine.id);
    expect(reloaded?.ownerId).toBe('u-human');
    // Старая реализация сохраняла устаревший снапшот — конкурентный icon пропадал.
    expect(reloaded?.icon).toBe('folder');
  });

  it('регресс: bind-сессия при создании получает владельца-человека от резолвера', async () => {
    const router = new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: '24h', autoBind: true },
    });
    const e = event({ identity: { chatKey: 'chat:telegram:create-human', principalId: 'tg:888' }, dedupKey: 'k-create-human' });
    const { session } = await service(router, {
      resolveExternalIdentity: () => ({ userId: 'u-creator' }),
    }).handleEvent(e);

    expect(session?.ownerId).toBe('u-creator');
    expect(session?.userId).toBe('u-creator');
  });

  // --- ADR-089 (claim-flow): выпуск claim-кода неизвестному отправителю ---

  it('handleEvent: неизвестный отправитель (резолвер null) → identityHint от issueIdentityClaim', async () => {
    const e = event({ identity: { principalId: 'tg:777', chatKey: 'chat:telegram:777' } });
    const issueIdentityClaim = vi.fn(async (_event: SynthEvent) => ({ code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' }));

    const res = await service(undefined, {
      resolveExternalIdentity: () => null,
      issueIdentityClaim,
    }).handleEvent(e);

    expect(res.identityHint).toEqual({ code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(issueIdentityClaim).toHaveBeenCalledOnce();
    expect(issueIdentityClaim.mock.calls[0]![0].identity?.principalId).toBe('tg:777');
  });

  it('handleEvent: сопознанный отправитель (резолвер вернул userId) → без identityHint', async () => {
    const e = event({ identity: { principalId: 'tg:777', chatKey: 'chat:telegram:777' } });
    const issueIdentityClaim = vi.fn(async () => ({ code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' }));

    const res = await service(undefined, {
      resolveExternalIdentity: () => ({ userId: 'u-1' }),
      issueIdentityClaim,
    }).handleEvent(e);

    expect(res.identityHint).toBeUndefined();
    expect(issueIdentityClaim).not.toHaveBeenCalled();
  });

  it('handleEvent: нет principalId → без identityHint', async () => {
    const e = event({ identity: { chatKey: 'chat:telegram:777' } });
    const issueIdentityClaim = vi.fn(async () => ({ code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' }));

    const res = await service(undefined, { issueIdentityClaim }).handleEvent(e);
    expect(res.identityHint).toBeUndefined();
    expect(issueIdentityClaim).not.toHaveBeenCalled();
  });

  it('handleEvent: без issueIdentityClaim (не сконфигурирован) → без identityHint', async () => {
    const e = event({ identity: { principalId: 'tg:777', chatKey: 'chat:telegram:777' } });
    const res = await service(undefined, { resolveExternalIdentity: () => null }).handleEvent(e);
    expect(res.identityHint).toBeUndefined();
  });

  it('handleEvent: код выпускается и когда владелец определён чатом (per-event), но отправитель не сопознан', async () => {
    // ephemeral-маршрут по чату даёт владельца, но сам principalId не сопознан —
    // код всё равно нужен.
    await bindingStore.upsert({
      source: 'telegram',
      chatKey: 'chat:telegram:group',
      mode: 'ephemeral',
      agentTemplate: '',
    });
    const e = event({ identity: { principalId: 'tg:888', chatKey: 'chat:telegram:group' } });
    const issueIdentityClaim = vi.fn(async () => ({ code: 'GHJ-KLM', expiresAt: '2030-01-01T00:00:00.000Z' }));

    const res = await service(undefined, {
      resolveExternalIdentity: () => null,
      resolveOwnerId: () => 'local',
      issueIdentityClaim,
    }).handleEvent(e, { ownerId: 'chat-owner' });

    expect(res.session?.ownerId).toBe('chat-owner');
    expect(res.identityHint).toEqual({ code: 'GHJ-KLM', expiresAt: '2030-01-01T00:00:00.000Z' });
  });

  it('handleEvent: hook-blocked не выпускает код (событие не обработано)', async () => {
    hooks.on('external_event', () => ({ block: true, reason: 'nope' }));
    const e = event({ identity: { principalId: 'tg:777', chatKey: 'chat:telegram:777' } });
    const issueIdentityClaim = vi.fn(async () => ({ code: 'ABC-DEF', expiresAt: '2030-01-01T00:00:00.000Z' }));

    const res = await service(undefined, { resolveExternalIdentity: () => null, issueIdentityClaim }).handleEvent(e);
    expect(res.identityHint).toBeUndefined();
    expect(issueIdentityClaim).not.toHaveBeenCalled();
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

  it('eventToMessage: внешний отправитель `from.username` → author @username (ADR-089)', () => {
    const e = event({
      identity: { chatKey: 'chat:telegram:-100', principalId: 'tg:123', threadKey: 'thread:telegram:-100:7' },
      payload: { text: 'hi', from: { username: 'durov', firstName: 'Pavel' } },
    });
    const msg = eventToMessage(e);

    expect(msg.author).toBe('@durov');
    expect(msg.metadata).toMatchObject({
      principal_id: 'tg:123',
      chat_key: 'chat:telegram:-100',
      thread_key: 'thread:telegram:-100:7',
    });
  });

  it('eventToMessage: `from` без username → author firstName lastName (ADR-089)', () => {
    const e = event({ payload: { text: 'hi', from: { firstName: 'Pavel', lastName: 'Durov' } } });
    const msg = eventToMessage(e);
    expect(msg.author).toBe('Pavel Durov');
  });

  it('eventToMessage: `from` без имени → author = principalId (ADR-089)', () => {
    const e = event({ identity: { principalId: 'tg:123' }, payload: { text: 'hi', from: {} } });
    const msg = eventToMessage(e);
    expect(msg.author).toBe('tg:123');
  });

  it('eventToMessage: внешний источник без from/principalId → author undefined (ADR-089)', () => {
    const e = event({ identity: { chatKey: 'chat:telegram:1' }, payload: { text: 'hi' } });
    const msg = eventToMessage(e);
    expect(msg.author).toBeUndefined();
    expect(msg.metadata).toMatchObject({ chat_key: 'chat:telegram:1' });
    expect(msg.metadata?.principal_id).toBeUndefined();
    expect(msg.metadata?.thread_key).toBeUndefined();
  });

  it('eventToMessage: cron не ломается атрибуцией внешнего отправителя (ADR-051/ADR-089)', () => {
    const e = event({
      source: 'cron',
      payload: { scheduleId: 'sch_1', text: 'tick', from: { username: 'ignored' } },
    });
    const msg = eventToMessage(e);
    expect(msg.author).toBe('Scheduler');
    expect(msg.metadata?.scheduler).toBe(true);
    expect(msg.metadata?.principal_id).toBeUndefined();
  });
});

/**
 * ADR-115 × ADR-089: сборка сообщения из события с вложениями.
 *
 * Части: текст первым, затем медиа-части в порядке ссылок события; `content`
 * получает плейсхолдеры `[image: name]` (иначе факт вложения теряется в
 * строковых производных), `metadata.attachments_count` — для аудита.
 */
describe('eventToMessage: вложения события (ADR-115 × ADR-089)', () => {
  const sha = (n: number): string => String(n).repeat(64);

  const attachment = (overrides: Partial<EventAttachmentRef> = {}): EventAttachmentRef => ({
    blobPath: `attachments/ab/${sha(1)}`,
    sha256: sha(1),
    mime: 'image/png',
    size: 2048,
    name: 'photo.png',
    ...overrides,
  });

  const withAttachments = (attachments: EventAttachmentRef[]): SynthEvent =>
    event({ payload: { text: 'смотри' }, attachments });

  it('текстовая часть первая, затем медиа-часть с данными объекта', () => {
    const ref = attachment();
    const msg = eventToMessage(withAttachments([ref]));

    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toMatchObject({ type: 'text', data: 'смотри' });
    expect(msg.parts[1]).toMatchObject({
      type: 'image',
      data: {
        blobPath: ref.blobPath,
        sha256: ref.sha256,
        mime: ref.mime,
        size: ref.size,
        name: 'photo.png',
      },
    });
    expect(msg.metadata?.attachments_count).toBe(1);
    // `source` не меняется — поле остаётся источником события.
    expect(msg.metadata?.source).toBe('telegram');
    expect(msg.role).toBe('user');
  });

  it('content получает плейсхолдер вложения (appendMediaPlaceholders)', () => {
    const msg = eventToMessage(withAttachments([attachment()]));

    expect(msg.content).toBe('смотри\n[image: photo.png]');
    expect(msg.parts[0]?.data).toBe('смотри');
  });

  it('порядок частей повторяет порядок `attachments[]`; тип — по MIME', () => {
    const image = attachment();
    const audio = attachment({
      blobPath: `attachments/cd/${sha(2)}`,
      sha256: sha(2),
      mime: 'audio/mpeg',
      size: 512,
      name: 'voice.mp3',
    });
    const file = attachment({
      blobPath: `attachments/ef/${sha(3)}`,
      sha256: sha(3),
      mime: 'application/pdf',
      size: 4096,
      name: 'doc.pdf',
    });
    const msg = eventToMessage(withAttachments([image, audio, file]));

    expect(msg.parts.map((part) => part.type)).toEqual(['text', 'image', 'audio', 'file']);
    expect(msg.content).toBe('смотри\n[image: photo.png]\n[audio: voice.mp3]\n[file: doc.pdf]');
    expect(msg.metadata?.attachments_count).toBe(3);
  });

  it('вложение без имени — плейсхолдер без подписи', () => {
    const msg = eventToMessage(withAttachments([attachment({ name: undefined })]));
    expect(msg.content).toBe('смотри\n[image]');
  });

  it('без вложений сообщение не меняется (одна текстовая часть, нет attachments_count)', () => {
    const msg = eventToMessage(event({ payload: { text: 'hi' } }));
    expect(msg.parts).toHaveLength(1);
    expect(msg.metadata?.attachments_count).toBeUndefined();
    expect(msg.content).toBe('hi');
  });

  it('медиа-событие без текста: content — один плейсхолдер, служебного payload нет', () => {
    // Голосовое из Telegram-шлюза: `payload.text` нет, есть вложение.
    const voice = attachment({
      blobPath: `attachments/cd/${sha(2)}`,
      sha256: sha(2),
      mime: 'audio/ogg',
      size: 1024,
      name: 'file_1.oga',
    });
    const e = event({
      payload: { chatId: '-100123', attachment: { kind: 'voice', fileId: 'AgADvoice' } },
      attachments: [voice],
    });

    expect(eventToMessageText(e)).toBe('');

    const msg = eventToMessage(e);
    // Ровно один плейсхолдер — без текстовой метки-дубля и без JSON.
    expect(msg.content).toBe('[audio: file_1.oga]');
    expect(msg.content.match(/\[audio:/g)).toHaveLength(1);
    // Служебные поля шлюза в диалог и модель не уходят.
    expect(msg.content).not.toContain('chatId');
    expect(msg.content).not.toContain('fileId');
    expect(msg.content).not.toContain('{');
    // Текстовая часть — пустая (текста в событии не было), медиа-часть на месте.
    expect(msg.parts[0]).toMatchObject({ type: 'text', data: '' });
    expect(msg.parts[1]).toMatchObject({ type: 'audio' });
    // Счётчик вложений для аудита сохранён.
    expect(msg.metadata?.attachments_count).toBe(1);
  });

  it('без текста и без вложений → прежний JSON-payload (служебные события)', () => {
    const msg = eventToMessage(event({ source: 'ci', payload: { build: 42 } }));

    expect(msg.content).toBe('{"build":42}');
    expect(eventToMessageText(event({ source: 'ci', payload: { build: 42 } }))).toBe('{"build":42}');
  });

  it('сообщение внешнего канала сохраняет external_message_id/chat_id (для повторного скачивания)', () => {
    const msg = eventToMessage(event({
      payload: { chatId: '450316139', messageId: 108, text: 'видео' },
    }));
    expect(msg.metadata).toMatchObject({
      external_message_id: '108',
      external_chat_id: '450316139',
    });
  });

  it('Telegram-сообщение без текста и вложений → маркер, не JSON', () => {
    const e = event({
      payload: {
        chatId: '450316139',
        chatType: 'private',
        messageId: 105,
        from: { id: '450316139', isExternal: true },
      },
    });

    expect(eventToMessageText(e)).toBe('[message]');
    expect(eventToMessage(e).content).toBe('[message]');
    expect(eventToMessage(e).content).not.toContain('chatId');
  });

  it('Telegram-сообщение без вложения знает его вид (video_note) — маркер с видом', () => {
    const e = event({
      payload: {
        chatId: '450316139',
        messageId: 105,
        attachment: { kind: 'video_note', fileId: 'vn1' },
      },
    });

    expect(eventToMessageText(e)).toBe('[video_note]');
    expect(eventToMessage(e).content).not.toContain('fileId');
  });

  it('вложение с текстом → текст и плейсхолдер, JSON не подмешивается', () => {
    const msg = eventToMessage(withAttachments([attachment()]));

    expect(msg.content).toBe('смотри\n[image: photo.png]');
    expect(msg.content).not.toContain('{');
    expect(eventToMessageText(withAttachments([attachment()]))).toBe('смотри');
  });
});

/**
 * ADR-115 × ADR-089: привязка вложений события к сообщению (`blob_refs`).
 *
 * Без ссылки GC удалил бы объект по `attachments.gcDays`, хотя сообщение на него
 * ссылается. `ownerId` — id того же сообщения, которое попадает в историю.
 */
describe('addEventAttachmentRefs (ADR-115 × ADR-089)', () => {
  const eventWith = (attachments: EventAttachmentRef[]): SynthEvent =>
    event({ payload: { text: 'hi' }, attachments });

  it('пишет ссылки с ownerKind=message и id сообщения', async () => {
    const add = vi.fn(async () => {});
    const refs = { add } as unknown as BlobRefRepository;
    const attachments: EventAttachmentRef[] = [
      { blobPath: `attachments/aa/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), mime: 'image/png', size: 1 },
      { blobPath: `attachments/bb/${'b'.repeat(64)}`, sha256: 'b'.repeat(64), mime: 'audio/mpeg', size: 2 },
    ];
    const message = eventToMessage(eventWith(attachments));

    const added = await addEventAttachmentRefs(refs, eventWith(attachments), message.id);

    expect(added).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(1, {
      blobPath: attachments[0]!.blobPath,
      ownerKind: 'message',
      ownerId: message.id,
    });
    expect(add).toHaveBeenNthCalledWith(2, {
      blobPath: attachments[1]!.blobPath,
      ownerKind: 'message',
      ownerId: message.id,
    });
  });

  it('без порта/вложений — no-op', async () => {
    const add = vi.fn(async () => {});
    expect(await addEventAttachmentRefs(undefined, eventWith([]), 'msg_1')).toBe(0);
    expect(
      await addEventAttachmentRefs({ add } as unknown as BlobRefRepository, eventWith([]), 'msg_1'),
    ).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });

  it('ошибка порта не отменяет доставку — best-effort лог', async () => {
    const add = vi.fn(async () => {
      throw new Error('boom');
    });
    const log = vi.fn();
    const attachments: EventAttachmentRef[] = [
      { blobPath: `attachments/aa/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), mime: 'image/png', size: 1 },
    ];

    const added = await addEventAttachmentRefs(
      { add } as unknown as BlobRefRepository,
      eventWith(attachments),
      'msg_1',
      log,
    );

    expect(added).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });
});
