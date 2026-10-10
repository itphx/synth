import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import type { EventJournalEntry } from '../../storage/event-journal-store.js';
import { startEventJournalPruner } from './journal-prune.js';
import type { SynthEvent } from '@itphx/synth-shared';

const OLD_TS = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const NEW_TS = new Date().toISOString();

const event = (id: string, ts: string): SynthEvent => ({
  id,
  source: 'webhook',
  type: 'webhook',
  payload: null,
  identity: {},
  dedupKey: `dedup-${id}`,
  ts,
});

const entry = (id: string, ts: string): EventJournalEntry => ({ ts, event: event(id, ts) });

describe('startEventJournalPruner (AD-089)', () => {
  let store: EventJournalStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-journal-prune-'));
    store = new EventJournalStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('при старте удаляет записи старше getRetentionDays', async () => {
    await store.record(entry('old', OLD_TS));
    await store.record(entry('new', NEW_TS));

    const stop = startEventJournalPruner(store, { getRetentionDays: () => 7, intervalMs: 60_000 });
    try {
      await vi.waitFor(async () => {
        expect((await store.list()).map((e) => e.event.id)).toEqual(['new']);
      });
    } finally {
      stop();
    }
  });

  it('retentionDays <= 0 → prune не выполняется (no-op)', async () => {
    await store.record(entry('old', OLD_TS));

    const stop = startEventJournalPruner(store, { getRetentionDays: () => 0, intervalMs: 10 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect((await store.list()).map((e) => e.event.id)).toEqual(['old']);
    } finally {
      stop();
    }
  });

  it('повторяет prune по интервалу и останавливается по stop()', async () => {
    const stop = startEventJournalPruner(store, { getRetentionDays: () => 7, intervalMs: 20 });

    // Периодический прогон чистит новую старую запись.
    await store.record(entry('old-1', OLD_TS));
    await vi.waitFor(async () => {
      expect(await store.list()).toHaveLength(0);
    });

    stop();

    // После stop() интервал не срабатывает — запись остаётся.
    await store.record(entry('old-2', OLD_TS));
    await new Promise((r) => setTimeout(r, 80));
    expect((await store.list()).map((e) => e.event.id)).toEqual(['old-2']);
  });
});
