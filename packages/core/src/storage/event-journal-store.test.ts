import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventJournalStore } from './event-journal-store.js';
import type { EventJournalEntry } from './event-journal-store.js';
import type { SynthEvent } from '@itphx/synth-shared';

const event = (id: string, ts = new Date().toISOString()): SynthEvent => ({
  id,
  source: 'webhook',
  type: 'webhook',
  payload: null,
  identity: {},
  dedupKey: `dedup-${id}`,
  ts,
});

const entry = (id: string, ts = new Date().toISOString()): EventJournalEntry => ({
  ts,
  event: event(id, ts),
});

describe('EventJournalStore (ADR-089)', () => {
  let store: EventJournalStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-journal-'));
    store = new EventJournalStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('list на отсутствующем файле возвращает []', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('record + list: порядок добавления (старые → новые)', async () => {
    await store.record(entry('a'));
    await store.record(entry('b'));
    await store.record(entry('c'));
    expect((await store.list()).map((e) => e.event.id)).toEqual(['a', 'b', 'c']);
  });

  it('limit возвращает последние N (самые новые)', async () => {
    await store.record(entry('a'));
    await store.record(entry('b'));
    await store.record(entry('c'));
    expect((await store.list(2)).map((e) => e.event.id)).toEqual(['b', 'c']);
  });

  it('record сохраняет decision и error', async () => {
    await store.record({
      ...entry('a'),
      decision: { kind: 'drop', reason: 'no-binding', audited: true },
      error: 'boom',
    });
    const [saved] = await store.list();
    expect(saved?.decision).toEqual({ kind: 'drop', reason: 'no-binding', audited: true });
    expect(saved?.error).toBe('boom');
  });

  it('prune удаляет записи старше N дней и возвращает число удалённых', async () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();
    await store.record(entry('old', oldTs));
    await store.record(entry('new', newTs));

    expect(await store.prune(7)).toBe(1);
    const remaining = await store.list();
    expect(remaining.map((e) => e.event.id)).toEqual(['new']);

    // Повторный prune — нечего удалять.
    expect(await store.prune(7)).toBe(0);
  });

  it('prune сохраняет записи с непарсящимся ts', async () => {
    await store.record({ ...entry('weird'), ts: 'not-a-date' });
    expect(await store.prune(1)).toBe(0);
    expect((await store.list()).map((e) => e.event.id)).toEqual(['weird']);
  });

  it('повреждённые строки пропускаются с console.warn', async () => {
    await store.record(entry('valid'));
    const file = join(tmpDir, 'events', 'journal.jsonl');
    await writeFile(file, (await readFile(file, 'utf8')) + '{ broken json\n', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = await store.list();
    expect(entries.map((e) => e.event.id)).toEqual(['valid']);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('конкурентные record не рвут строки', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.record(entry(`e-${i}`))));
    const raw = await readFile(join(tmpDir, 'events', 'journal.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line) as EventJournalEntry).not.toThrow();
    }
  });
});
