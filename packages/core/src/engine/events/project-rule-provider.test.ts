import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SynthEvent } from '@itphx/synth-shared';
import { RouteRuleStore } from '../../storage/route-rule-store.js';
import { ProjectRuleProvider } from './project-rule-provider.js';

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'telegram',
  type: 'message',
  payload: { text: 'hello world' },
  identity: {},
  dedupKey: 'd1',
  ts: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('ProjectRuleProvider (AD-089)', () => {
  let tmpDir: string;
  let store: RouteRuleStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-rules-'));
    store = new RouteRuleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const provider = () => new ProjectRuleProvider(store, '24h');

  it('нет правил → null', async () => {
    expect(await provider().resolve({ event: event(), bindings: [] })).toBeNull();
  });

  it('совпадение по source → decision цели, reason=rule', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'bound', sessionId: 's-bound' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'bound',
      sessionId: 's-bound',
    });
  });

  it('queue → reason=rule (не schedule/binding)', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'queue', sessionId: 'owner-1' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'queue',
      owner: 'owner-1',
      reason: 'rule',
    });
  });

  it('ephemeral → ttl дефолт провайдера и project', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'ephemeral', agentTemplate: 'triage', project: 'p1' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'ephemeral',
      agentTemplate: 'triage',
      ttl: '24h',
      project: 'p1',
    });
  });

  it('приоритет: больше = раньше; при равенстве — порядок в файле', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'bound', sessionId: 'low' },
    });
    await store.upsert({
      priority: 5,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'bound', sessionId: 'high' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'bound',
      sessionId: 'high',
    });

    // Равный приоритет — выигрывает первое в файле.
    await store.upsert({
      priority: 5,
      enabled: true,
      match: { source: 'telegram' },
      target: { mode: 'bound', sessionId: 'high-first' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'bound',
      sessionId: 'high',
    });
  });

  it('AND-матчинг: все заполненные поля должны совпасть', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { source: 'telegram', type: 'message', chatKey: 'chat:telegram:1' },
      target: { mode: 'bound', sessionId: 's1' },
    });

    expect(
      await provider().resolve({
        event: event({ identity: { chatKey: 'chat:telegram:1' } }),
        bindings: [],
      }),
    ).toEqual({ kind: 'bound', sessionId: 's1' });

    // Не тот чат → нет матча.
    expect(
      await provider().resolve({
        event: event({ identity: { chatKey: 'chat:telegram:2' } }),
        bindings: [],
      }),
    ).toBeNull();

    // Не тот type → нет матча.
    expect(
      await provider().resolve({
        event: event({ type: 'callback', identity: { chatKey: 'chat:telegram:1' } }),
        bindings: [],
      }),
    ).toBeNull();
  });

  it('principalId и label матчатся точно', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { principalId: 'u1', label: 'alert' },
      target: { mode: 'bound', sessionId: 's-label' },
    });
    expect(
      await provider().resolve({
        event: event({ identity: { principalId: 'u1' }, payload: { text: 'x', label: 'alert' } }),
        bindings: [],
      }),
    ).toEqual({ kind: 'bound', sessionId: 's-label' });
    expect(
      await provider().resolve({
        event: event({ identity: { principalId: 'u2' }, payload: { label: 'alert' } }),
        bindings: [],
      }),
    ).toBeNull();
    expect(
      await provider().resolve({
        event: event({ identity: { principalId: 'u1' }, payload: { label: 'other' } }),
        bindings: [],
      }),
    ).toBeNull();
  });

  it('keywords: регистронезависимо, достаточно одной подстроки', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: { keywords: ['Deploy', 'release'] },
      target: { mode: 'bound', sessionId: 's-kw' },
    });
    expect(
      await provider().resolve({ event: event({ payload: { text: 'Please DEPLOY now' } }), bindings: [] }),
    ).toEqual({ kind: 'bound', sessionId: 's-kw' });
    expect(
      await provider().resolve({ event: event({ payload: { text: 'cut a release' } }), bindings: [] }),
    ).toEqual({ kind: 'bound', sessionId: 's-kw' });
    expect(
      await provider().resolve({ event: event({ payload: { text: 'nothing here' } }), bindings: [] }),
    ).toBeNull();
  });

  it('пустой match игнорируется (не матчит всё)', async () => {
    await store.upsert({
      priority: 1,
      enabled: true,
      match: {},
      target: { mode: 'bound', sessionId: 's-all' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toBeNull();
  });

  it('disabled-правило игнорируется', async () => {
    await store.upsert({
      priority: 1,
      enabled: false,
      match: { source: 'telegram' },
      target: { mode: 'bound', sessionId: 's-off' },
    });
    expect(await provider().resolve({ event: event(), bindings: [] })).toBeNull();
  });
});
