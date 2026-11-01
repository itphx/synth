import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withFileLocks, fileLockRegistrySize, fileLockKey } from './file-lock.js';

/**
 * Реестр per-path локов: порядок взятия, отсутствие дедлока и отсутствие
 * утечек (запись реестра удаляется, когда очередь пуста).
 */
describe('file-lock — per-path сериализация', () => {
  const p1 = join(tmpdir(), 'synth-lock-a');
  const p2 = join(tmpdir(), 'synth-lock-b');
  const p3 = join(tmpdir(), 'synth-lock-c');

  it('пустой список путей — fn вызывается без локов', async () => {
    const seen: string[] = [];
    const result = await withFileLocks([], async () => {
      seen.push('called');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['called']);
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('один путь — критическая секция не пересекается с собой', async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLocks([p1], async () => {
        order.push('a-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('a-end');
      }),
      withFileLocks([p1], async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);
    // Второй вызов ждал первый: секции не пересеклись.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('дубли пути в одном вызове не приводят к самоблокировке', async () => {
    const result = await withFileLocks([p1, p1, p1], async () => 'ok');
    expect(result).toBe('ok');
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('пересекающиеся наборы путей в разном порядке — без дедлока', async () => {
    const order: string[] = [];
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000));
    const work = Promise.all([
      withFileLocks([p1, p2], async () => {
        order.push('x-start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('x-end');
      }),
      withFileLocks([p2, p1], async () => {
        order.push('y-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('y-end');
      }),
    ]);

    const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
    expect(outcome).toBe('done');
    // Секции не пересеклись: один дождался другого.
    expect(order.filter((step) => step.endsWith('-end')).length).toBe(2);
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('цикл из трёх пересекающихся наборов — без дедлока', async () => {
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000));
    const work = Promise.all([
      withFileLocks([p1, p2], async () => { await new Promise((r) => setTimeout(r, 20)); }),
      withFileLocks([p2, p3], async () => { await new Promise((r) => setTimeout(r, 20)); }),
      withFileLocks([p1, p3], async () => { await new Promise((r) => setTimeout(r, 20)); }),
    ]);
    const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
    expect(outcome).toBe('done');
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('исключение из fn освобождает локи (реестр пуст)', async () => {
    await expect(withFileLocks([p1], async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(fileLockRegistrySize()).toBe(0);

    // Лок действительно освобождён: следующий вызов проходит.
    const result = await withFileLocks([p1], async () => 'ok');
    expect(result).toBe('ok');
    expect(fileLockRegistrySize()).toBe(0);
  });

  it('ключ лока — абсолютный нормализованный путь', () => {
    expect(fileLockKey(join(tmpdir(), 'x', '..', 'y.txt'))).toBe(join(tmpdir(), 'y.txt'));
    expect(fileLockKey('relative.txt')).toBe(fileLockKey('relative.txt'));
    expect(fileLockKey('relative.txt').startsWith('/')).toBe(true);
  });
});
