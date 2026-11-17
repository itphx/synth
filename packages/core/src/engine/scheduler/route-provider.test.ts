import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SynthEvent } from '@itphx/synth-shared';
import { ScheduleStore } from '../../storage/schedule-store.js';
import { SchedulerRuleProvider } from './route-provider.js';

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'cron',
  type: 'schedule_fired',
  payload: { scheduleId: 'sch_1' },
  identity: {},
  dedupKey: 'd',
  ts: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('SchedulerRuleProvider (ADR-051 / ADR-089)', () => {
  let tmpDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sched-rule-'));
    store = new ScheduleStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('не cron-источник → null', async () => {
    const provider = new SchedulerRuleProvider(store);
    expect(await provider.resolve({ event: event({ source: 'telegram' }), bindings: [] })).toBeNull();
  });

  it('cron без scheduleId → null', async () => {
    const provider = new SchedulerRuleProvider(store);
    expect(await provider.resolve({ event: event({ payload: {} }), bindings: [] })).toBeNull();
    expect(await provider.resolve({ event: event({ payload: null }), bindings: [] })).toBeNull();
  });

  it('расписание не найдено → drop schedule_not_found', async () => {
    const provider = new SchedulerRuleProvider(store);
    expect(await provider.resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'drop',
      reason: 'schedule_not_found',
      audited: true,
    });
  });

  it('выключенное расписание → drop schedule_disabled', async () => {
    const created = await store.create({
      name: 'off',
      enabled: false,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const provider = new SchedulerRuleProvider(store);
    expect(
      await provider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'drop', reason: 'schedule_disabled', audited: true });
  });

  it('force в payload пропускает выключенное расписание (ADR-051)', async () => {
    const created = await store.create({
      name: 'off-force',
      enabled: false,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    const provider = new SchedulerRuleProvider(store);
    expect(
      await provider.resolve({
        event: event({ payload: { scheduleId: created.id, force: true } }),
        bindings: [],
      }),
    ).toEqual({ kind: 'bound', sessionId: 's1' });

    expect(
      await provider.resolve({
        event: event({ payload: { scheduleId: created.id, force: false } }),
        bindings: [],
      }),
    ).toEqual({ kind: 'drop', reason: 'schedule_disabled', audited: true });
  });

  it('target bound → bound', async () => {
    const created = await store.create({
      name: 'b',
      enabled: true,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'bound', sessionId: 's-bound' },
    });
    const provider = new SchedulerRuleProvider(store);
    expect(
      await provider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'bound', sessionId: 's-bound' });
  });

  it('target queue → queue{owner, reason:schedule}', async () => {
    const created = await store.create({
      name: 'q',
      enabled: true,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'queue', sessionId: 'owner-1' },
    });
    const provider = new SchedulerRuleProvider(store);
    expect(
      await provider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'queue', owner: 'owner-1', reason: 'schedule' });
  });

  it('target ephemeral → ttl/agentTemplate из target', async () => {
    const created = await store.create({
      name: 'e',
      enabled: true,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'ephemeral', agentTemplate: 'triage', project: 'proj-1', ttl: '30m' },
    });
    const provider = new SchedulerRuleProvider(store);
    expect(
      await provider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'ephemeral', agentTemplate: 'triage', ttl: '30m', project: 'proj-1' });
  });

  it('ephemeral без ttl/agentTemplate → дефолт провайдера', async () => {
    const created = await store.create({
      name: 'e2',
      enabled: true,
      projectId: 'proj-1',
      every: '1h',
      target: { mode: 'ephemeral', project: 'proj-1' },
    });
    const provider = new SchedulerRuleProvider(store, '6h');
    expect(
      await provider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'ephemeral', agentTemplate: '', ttl: '6h', project: 'proj-1' });

    const defaultProvider = new SchedulerRuleProvider(store);
    expect(
      await defaultProvider.resolve({ event: event({ payload: { scheduleId: created.id } }), bindings: [] }),
    ).toEqual({ kind: 'ephemeral', agentTemplate: '', ttl: '24h', project: 'proj-1' });
  });
});
