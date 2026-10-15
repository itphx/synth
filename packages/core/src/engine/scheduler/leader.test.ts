import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlwaysLeader, FileLeader } from './leader.js';

describe('AlwaysLeader (ADR-051)', () => {
  it('всегда лидер, touch/release — no-op', async () => {
    const leader = new AlwaysLeader();
    expect(await leader.acquire()).toBe(true);
    await expect(leader.touch()).resolves.toBeUndefined();
    await expect(leader.release()).resolves.toBeUndefined();
  });
});

describe('FileLeader (ADR-051/ADR-089)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-leader-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('конкуренция: лидер только один, после release — следующий', async () => {
    const a = new FileLeader({ dataDir: tmpDir, tickMs: 60_000 });
    const b = new FileLeader({ dataDir: tmpDir, tickMs: 60_000 });

    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);

    await a.release();
    expect(await b.acquire()).toBe(true);
  });

  it('stale takeover: лок старше 3×tick перехватывается', async () => {
    const lockDir = join(tmpDir, 'scheduler', 'leader.lock');
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDir, old, old);

    // tickMs=1000 → staleMs=3000 < 10000.
    const leader = new FileLeader({ dataDir: tmpDir, tickMs: 1_000 });
    expect(await leader.acquire()).toBe(true);
  });

  it('touch не падает без лока', async () => {
    const leader = new FileLeader({ dataDir: tmpDir, tickMs: 60_000 });
    await expect(leader.touch()).resolves.toBeUndefined();
  });
});
