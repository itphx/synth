import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDedupStore, MemoryDedupStore } from './dedup-store.js';
import type { DedupStore } from './dedup-store.js';

describe('MemoryDedupStore (ADR-051/ADR-089)', () => {
  it('первый claim true, повторный — false', async () => {
    const store = new MemoryDedupStore();
    expect(await store.tryClaim('k1')).toBe(true);
    expect(await store.tryClaim('k1')).toBe(false);
    expect(await store.tryClaim('k2')).toBe(true);
  });

  it('seed предзаполняет кэш — ключ из seed считается занятым', async () => {
    const store = new MemoryDedupStore();
    store.seed(['a', 'b']);
    expect(await store.tryClaim('a')).toBe(false);
    expect(await store.tryClaim('b')).toBe(false);
    expect(await store.tryClaim('c')).toBe(true);
  });
});

describe('FileDedupStore (ADR-051/ADR-089)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-dedup-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('первый claim true, повторный false (файл-маркер)', async () => {
    const store = new FileDedupStore({ dataDir: tmpDir });
    expect(await store.tryClaim('key-1')).toBe(true);
    expect(await store.tryClaim('key-1')).toBe(false);
  });

  it('разные ключи — разные маркеры', async () => {
    const store = new FileDedupStore({ dataDir: tmpDir });
    expect(await store.tryClaim('a')).toBe(true);
    expect(await store.tryClaim('b')).toBe(true);
    const files = await readdir(join(tmpDir, 'events', 'dedup'));
    expect(files).toHaveLength(2);
  });

  it('шаг claim = sha256(key) в {dataDir}/events/dedup', async () => {
    const store = new FileDedupStore({ dataDir: tmpDir });
    await store.tryClaim('stable-key');
    const expected = createHash('sha256').update('stable-key').digest('hex');
    const files = await readdir(join(tmpDir, 'events', 'dedup'));
    expect(files).toEqual([expected]);
  });

  it('персистентность между экземплярами: второй store видит claim первого', async () => {
    const first = new FileDedupStore({ dataDir: tmpDir });
    expect(await first.tryClaim('persist')).toBe(true);
    const second = new FileDedupStore({ dataDir: tmpDir });
    expect(await second.tryClaim('persist')).toBe(false);
  });

  it('конкурентные claim одного ключа: ровно один true', async () => {
    const store = new FileDedupStore({ dataDir: tmpDir });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.tryClaim('race')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('seed — no-op (маркеры персистентны)', async () => {
    const store: DedupStore = new FileDedupStore({ dataDir: tmpDir });
    store.seed(['x']);
    // seed не блокирует claim: файла-маркера ещё нет.
    expect(await store.tryClaim('x')).toBe(true);
  });
});
