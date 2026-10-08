import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDecision, SynthEvent } from '@itphx/synth-shared';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import type { UpsertEventBindingInput } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { EventRouter } from './event-router.js';
import type { RouteRuleProvider } from './types.js';

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

const binding = (overrides: Partial<UpsertEventBindingInput> = {}): UpsertEventBindingInput => ({
  source: 'telegram',
  mode: 'bound',
  ...overrides,
});

describe('EventRouter (AD-089)', () => {
  let tmpDir: string;
  let bindingStore: EventBindingStore;
  let journal: EventJournalStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-router-'));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const router = (config: { allowedSources?: string[]; defaultEphemeralTtl?: string; ruleProviders?: RouteRuleProvider[] } = {}) =>
    new EventRouter({
      bindingStore,
      journal,
      config: { defaultEphemeralTtl: config.defaultEphemeralTtl ?? '24h', allowedSources: config.allowedSources },
      ruleProviders: config.ruleProviders,
    });

  it('allowedSources: пусто — все источники разрешены (фоллбек no_route)', async () => {
    expect(await router().decide(event())).toEqual({ kind: 'drop', reason: 'no_route', audited: true });
  });

  it('allowedSources: источник в списке разрешён, вне — drop source_not_allowed', async () => {
    const r = router({ allowedSources: ['telegram'] });
    // Разрешённый источник доходит до фоллбека.
    expect(await r.decide(event({ source: 'telegram' }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });

    const r2 = router({ allowedSources: ['telegram'] });
    expect(await r2.decide(event({ source: 'webhook' }))).toEqual({
      kind: 'drop',
      reason: 'source_not_allowed',
      audited: true,
    });
  });

  it('явный binding mode=bound → bound по sessionId', async () => {
    await bindingStore.upsert(binding({ chatKey: 'chat:telegram:1', sessionId: 's-bound' }));
    expect(await router().decide(event({ identity: { chatKey: 'chat:telegram:1' } }))).toEqual({
      kind: 'bound',
      sessionId: 's-bound',
    });
  });

  it('binding mode=bound без sessionId не резолвится → фоллбек no_route', async () => {
    await bindingStore.upsert(binding({ chatKey: 'chat:telegram:1' }));
    expect(await router().decide(event({ identity: { chatKey: 'chat:telegram:1' } }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });
  });

  it('binding mode=ephemeral → ephemeral с TTL конфига и agentTemplate (или "")', async () => {
    await bindingStore.upsert(
      binding({ chatKey: 'chat:telegram:1', mode: 'ephemeral', agentTemplate: 'agent-x' }),
    );
    expect(
      await router({ defaultEphemeralTtl: '6h' }).decide(event({ identity: { chatKey: 'chat:telegram:1' } })),
    ).toEqual({ kind: 'ephemeral', agentTemplate: 'agent-x', ttl: '6h' });

    await bindingStore.upsert(binding({ chatKey: 'chat:telegram:2', mode: 'ephemeral' }));
    expect(await router().decide(event({ identity: { chatKey: 'chat:telegram:2' } }))).toEqual({
      kind: 'ephemeral',
      agentTemplate: '',
      ttl: '24h',
    });
  });

  it('binding mode=queue → queue{owner, reason:binding}; без sessionId → фоллбек', async () => {
    await bindingStore.upsert(binding({ chatKey: 'chat:telegram:1', mode: 'queue', sessionId: 'owner-1' }));
    expect(await router().decide(event({ identity: { chatKey: 'chat:telegram:1' } }))).toEqual({
      kind: 'queue',
      owner: 'owner-1',
      reason: 'binding',
    });

    await bindingStore.upsert(binding({ chatKey: 'chat:telegram:2', mode: 'queue' }));
    expect(await router().decide(event({ identity: { chatKey: 'chat:telegram:2' } }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });
  });

  it('приоритет threadKey над chatKey (через store)', async () => {
    await bindingStore.upsert(
      binding({ chatKey: 'chat:telegram:1', sessionId: 's-chat' }),
    );
    await bindingStore.upsert(
      binding({ chatKey: 'chat:telegram:1', threadKey: 'thread:telegram:1:7', sessionId: 's-thread' }),
    );
    const decision = await router().decide(
      event({ identity: { chatKey: 'chat:telegram:1', threadKey: 'thread:telegram:1:7' } }),
    );
    expect(decision).toEqual({ kind: 'bound', sessionId: 's-thread' });
  });

  it('rule providers: порядок регистрации, первый непустой выигрывает', async () => {
    const calls: string[] = [];
    const nullProvider: RouteRuleProvider = {
      name: 'null',
      resolve: () => {
        calls.push('null');
        return null;
      },
    };
    const winProvider: RouteRuleProvider = {
      name: 'win',
      resolve: () => {
        calls.push('win');
        return { kind: 'bound', sessionId: 's-rule' };
      },
    };
    const laterProvider: RouteRuleProvider = {
      name: 'later',
      resolve: () => {
        calls.push('later');
        return { kind: 'drop', reason: 'later', audited: true };
      },
    };

    const r = router();
    r.registerRuleProvider(nullProvider);
    r.registerRuleProvider(winProvider);
    r.registerRuleProvider(laterProvider);

    expect(await r.decide(event())).toEqual({ kind: 'bound', sessionId: 's-rule' });
    expect(calls).toEqual(['null', 'win']);
  });

  it('rule provider, бросивший исключение, не роняет decide (идём дальше)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badProvider: RouteRuleProvider = {
      name: 'bad',
      resolve: () => {
        throw new Error('boom');
      },
    };
    const goodProvider: RouteRuleProvider = {
      name: 'good',
      resolve: () => ({ kind: 'bound', sessionId: 's-after-error' }),
    };
    const r = router({ ruleProviders: [badProvider, goodProvider] });
    expect(await r.decide(event())).toEqual({ kind: 'bound', sessionId: 's-after-error' });
  });

  it('dedup: до record собственное повторное решение не считается дубликатом', async () => {
    const r = router();
    const first = await r.decide(event());
    const second = await r.decide(event());
    expect(first).toEqual({ kind: 'drop', reason: 'no_route', audited: true });
    expect(second).toEqual(first);
  });

  it('dedup: после record повторный dedupKey → drop duplicate', async () => {
    const r = router();
    const e = event({ dedupKey: 'k-1' });
    const first = await r.decide(e);
    await r.record(e, first);

    expect(await r.decide(event({ id: 'evt_2', dedupKey: 'k-1' }))).toEqual({
      kind: 'drop',
      reason: 'duplicate',
      audited: true,
    });
    // Другой ключ — не дубликат.
    expect(await r.decide(event({ id: 'evt_3', dedupKey: 'k-2' }))).toEqual({
      kind: 'drop',
      reason: 'no_route',
      audited: true,
    });
  });

  it('dedup: ленивая инициализация из журнала (запись другого инстанса)', async () => {
    const e = event({ dedupKey: 'k-from-journal' });
    await journal.record({ ts: new Date().toISOString(), event: e });

    const r = router();
    expect(await r.decide(event({ id: 'evt_other', dedupKey: 'k-from-journal' }))).toEqual({
      kind: 'drop',
      reason: 'duplicate',
      audited: true,
    });
  });

  it('record пишет decision и error в журнал', async () => {
    const r = router();
    const e = event({ dedupKey: 'k-rec' });
    const decision: RouteDecision = { kind: 'drop', reason: 'no_route', audited: true };
    await r.record(e, decision, 'materialize failed');

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event.id).toBe(e.id);
    expect(entries[0]?.decision).toEqual(decision);
    expect(entries[0]?.error).toBe('materialize failed');
  });
});
