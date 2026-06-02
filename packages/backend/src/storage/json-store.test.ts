import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './json-store.js';

describe('JsonStore', () => {
  let store: JsonStore<{ name: string; value: string }>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-jsonstore-'));
    store = new JsonStore<{ name: string; value: string }>({
      dataDir: tmpDir,
      subdir: 'providers',
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('save → load roundtrip', async () => {
    await store.save('test', { name: 'test', value: 'hello' });
    const loaded = await store.load('test');
    expect(loaded).toEqual({ name: 'test', value: 'hello' });
  });

  it('load несуществующего ключа возвращает null', async () => {
    expect(await store.load('nonexistent')).toBeNull();
  });

  it('exists проверяет наличие', async () => {
    expect(await store.exists('x')).toBe(false);
    await store.save('x', { name: 'x', value: 'v' });
    expect(await store.exists('x')).toBe(true);
  });

  it('delete удаляет ключ', async () => {
    await store.save('x', { name: 'x', value: 'v' });
    await store.delete('x');
    expect(await store.exists('x')).toBe(false);
  });

  it('list возвращает все записи', async () => {
    await store.save('a', { name: 'a', value: '1' });
    await store.save('b', { name: 'b', value: '2' });
    const items = await store.list();
    expect(items).toHaveLength(2);
  });

  it('запрещает path traversal через ..', () => {
    expect(() => store['_validateKey']('../../../etc/passwd')).toThrow('Недопустимый ключ');
  });

  it('запрещает path traversal через \\', () => {
    expect(() => store['_validateKey']('etc\\passwd')).toThrow('Недопустимый ключ');
  });

  it('разрешает обычные ключи', () => {
    expect(() => store['_validateKey']('normal-key')).not.toThrow();
    expect(() => store['_validateKey']('name.with.dots')).not.toThrow();
    expect(() => store['_validateKey']('test-123')).not.toThrow();
  });

  it('разрешает ключи с / (иерархические)', () => {
    expect(() => store['_validateKey']('itphx/arena-model')).not.toThrow();
    expect(() => store['_validateKey']('provider/model-name')).not.toThrow();
  });
});
