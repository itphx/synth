import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './json-store.js';

describe('JsonStore (core)', () => {
  let store: JsonStore<{ id: string; value?: string }>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-jsonstore-'));
    store = new JsonStore<{ id: string; value?: string }>({
      dataDir: tmpDir,
      subdir: 'models',
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('save → load roundtrip', async () => {
    await store.save('test', { id: 'test', value: 'hello' });
    expect(await store.load('test')).toEqual({ id: 'test', value: 'hello' });
  });

  it('load несуществующего ключа возвращает null', async () => {
    expect(await store.load('nonexistent')).toBeNull();
  });

  it('exists / delete', async () => {
    expect(await store.exists('x')).toBe(false);
    await store.save('x', { id: 'x' });
    expect(await store.exists('x')).toBe(true);
    await store.delete('x');
    expect(await store.exists('x')).toBe(false);
  });

  // Семантика: exists() = запись читается как валидный JSON. Битый файл
  // (оборвавшаяся атомарная запись) существующим не считается.
  it('exists возвращает false для битого JSON', async () => {
    await store.save('broken', { id: 'broken' });
    await writeFile(join(tmpDir, 'models', 'broken.json'), '{ not json', 'utf-8');
    expect(await store.exists('broken')).toBe(false);
  });

  it('повторный save после delete работает (lock освобождён)', async () => {
    await store.save('x', { id: 'x', value: 'first' });
    await store.delete('x');
    await store.save('x', { id: 'x', value: 'second' });
    expect(await store.load('x')).toEqual({ id: 'x', value: 'second' });
  });

  it('delete несуществующего ключа не бросает', async () => {
    await expect(store.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('delete запрещает path traversal через ..', async () => {
    await expect(store.delete('../../etc/passwd')).rejects.toThrow('Недопустимый ключ');
  });

  it('list возвращает плоские записи', async () => {
    await store.save('a', { id: 'a' });
    await store.save('b', { id: 'b' });
    const items = await store.list();
    expect(items).toHaveLength(2);
  });

  // Регрессия: модели сохраняются с полным id `provider/model` → файл
  // `models/<provider>/<model>.json`. Плоский list() их не видел.
  it('list возвращает вложенные ключи (provider/model)', async () => {
    await store.save('ollama/llama3', { id: 'ollama/llama3' });
    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: 'ollama/llama3' });
  });

  it('list собирает плоские ключи и несколько подкаталогов вместе', async () => {
    await store.save('flat', { id: 'flat' });
    await store.save('ollama/llama3', { id: 'ollama/llama3' });
    await store.save('ollama/qwen2', { id: 'ollama/qwen2' });
    await store.save('itphx/routerai.openai/gpt-4', { id: 'itphx/routerai.openai/gpt-4' });

    const ids = (await store.list()).map((m) => m.id).sort();
    expect(ids).toEqual([
      'flat',
      'itphx/routerai.openai/gpt-4',
      'ollama/llama3',
      'ollama/qwen2',
    ]);
  });

  it('list игнорирует .tmp-файлы атомарной записи и не-json файлы', async () => {
    await store.save('good/model', { id: 'good/model' });
    // Временный файл атомарной записи: `<target>.tmp.<id>` — не оканчивается на .json.
    await writeFile(join(tmpDir, 'models', 'good', 'model.json.tmp-abc123'), '{}', 'utf-8');
    // Посторонний не-json файл рядом.
    await writeFile(join(tmpDir, 'models', 'notes.txt'), 'мусор', 'utf-8');
    // Сломанный .json — не должен попасть в список (load вернёт null).
    await writeFile(join(tmpDir, 'models', 'broken.json'), '{ not json', 'utf-8');

    const items = await store.list();
    expect(items).toEqual([{ id: 'good/model' }]);
  });

  it('list на несуществующем каталоге возвращает []', async () => {
    const empty = new JsonStore<unknown>({ dataDir: tmpDir, subdir: 'nope' });
    expect(await empty.list()).toEqual([]);
  });

  it('разрешает ключи с / (иерархические)', () => {
    expect(() => store['_validateKey']('itphx/arena-model')).not.toThrow();
    expect(() => store['_validateKey']('provider/model-name')).not.toThrow();
  });

  it('запрещает path traversal через ..', () => {
    expect(() => store['_validateKey']('../../../etc/passwd')).toThrow('Недопустимый ключ');
  });

  it('запрещает path traversal через \\', () => {
    expect(() => store['_validateKey']('etc\\passwd')).toThrow('Недопустимый ключ');
  });
});
