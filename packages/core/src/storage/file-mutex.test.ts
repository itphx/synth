import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMutex } from './file-mutex.js';

describe('FileMutex (AD-051/AD-089)', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-file-mutex-'));
    lockPath = join(tmpDir, 'nested', 'resource.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('acquire → true; повторный acquire другим инстансом → false; release → снова true', async () => {
    const a = new FileMutex({ path: lockPath });
    const b = new FileMutex({ path: lockPath });

    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);

    await a.release();
    expect(await b.tryAcquire()).toBe(true);
  });

  it('release идемпотентен и не падает без лока', async () => {
    const mutex = new FileMutex({ path: lockPath });
    await expect(mutex.release()).resolves.toBeUndefined();
    await expect(mutex.release()).resolves.toBeUndefined();
  });

  it('stale takeover: лок старше staleMs перехватывается', async () => {
    await mkdir(join(tmpDir, 'nested'), { recursive: true });
    await mkdir(lockPath);
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const mutex = new FileMutex({ path: lockPath, staleMs: 1_000 });
    expect(await mutex.tryAcquire()).toBe(true);
  });

  it('живой лок (mtime свежий) не перехватывается', async () => {
    const holder = new FileMutex({ path: lockPath });
    expect(await holder.tryAcquire()).toBe(true);

    const mutex = new FileMutex({ path: lockPath, staleMs: 60_000 });
    expect(await mutex.tryAcquire()).toBe(false);
  });

  it('touch обновляет mtime лока', async () => {
    const mutex = new FileMutex({ path: lockPath, staleMs: 60_000 });
    expect(await mutex.tryAcquire()).toBe(true);

    const old = new Date(Date.now() - 30_000);
    await utimes(lockPath, old, old);
    const before = (await stat(lockPath)).mtimeMs;

    await mutex.touch();
    const after = (await stat(lockPath)).mtimeMs;
    expect(after).toBeGreaterThan(before);
  });

  it('withLock выполняет fn и освобождает лок', async () => {
    const mutex = new FileMutex({ path: lockPath });
    const result = await mutex.withLock(async () => 42);
    expect(result).toBe(42);

    const other = new FileMutex({ path: lockPath });
    expect(await other.tryAcquire()).toBe(true);
  });

  it('withLock при исключении в fn всё равно освобождает лок', async () => {
    const mutex = new FileMutex({ path: lockPath });
    await expect(
      mutex.withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const other = new FileMutex({ path: lockPath });
    expect(await other.tryAcquire()).toBe(true);
  });

  it('withLock сериализует конкурентные секции на общем пути', async () => {
    const a = new FileMutex({ path: lockPath, retryMs: 5, timeoutMs: 2_000 });
    const b = new FileMutex({ path: lockPath, retryMs: 5, timeoutMs: 2_000 });

    const order: string[] = [];
    const section = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:end`);
    };

    await Promise.all([a.withLock(section('a')), b.withLock(section('b'))]);

    // Секции не перемешиваются: каждая началась после завершения предыдущей.
    const first = order[0]!.slice(0, 1);
    expect(order).toEqual([`${first}:start`, `${first}:end`, `${first === 'a' ? 'b' : 'a'}:start`, `${first === 'a' ? 'b' : 'a'}:end`]);
  });
});
