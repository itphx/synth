import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileMutex } from './file-mutex.js';

/**
 * `stat` оборачивается, чтобы детерминированно смоделировать узкую гонку
 * «владелец освободил лок между `mkdir` (`EEXIST`) и `stat`»: базой остаётся
 * настоящий `stat`, а точечный `mockRejectedValueOnce` отдаёт `ENOENT` ровно
 * один раз. Так регрессия ловится без ожидания реального тайминга (реальный
 * флейк `schedule-store.test.ts` «crossProcess: конкурентные create»).
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

describe('FileMutex — гонка освобождения лока (ADR-051/ADR-089)', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-file-mutex-race-'));
    lockPath = join(tmpDir, 'scheduler', 'schedules.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('лок исчез между mkdir и stat → retry и false, а не «acquired» без владения', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutex = new FileMutex({ path: lockPath });

    // Владелец держит лок (каталог-лок на месте, mtime свежий).
    await mkdir(dirname(lockPath), { recursive: true });
    await mkdir(lockPath);

    // В окне между `mkdir` (вернул EEXIST) и `stat` владелец освободил лок:
    // первый `stat` видит ENOENT, тогда как реальный каталог ещё на месте.
    vi.mocked(stat).mockRejectedValueOnce(
      Object.assign(new Error(`ENOENT: no such file or directory, stat '${lockPath}'`), {
        code: 'ENOENT',
      }),
    );

    // Контракт: `tryAcquire` возвращает `true` только реально владея локом.
    // Лок занят живым владельцем → `false` (после ENOENT проверка повторяется),
    // а не ложное «acquired», ведущее к параллельным секциям (потеря записей).
    expect(await mutex.tryAcquire()).toBe(false);
    warn.mockRestore();
  });
});
