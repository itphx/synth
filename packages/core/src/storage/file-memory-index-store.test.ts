import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMemoryIndexStore } from './file-memory-index-store.js';
import type { MemoryIndexRecord } from './ports/memory-index-repository.js';

/**
 * Специфика файлового backend'а порта индексов памяти (ADR-096, ADR-005).
 *
 * Общий контракт (`storage/contract/memory.ts`) покрыт для всех backend'ов;
 * здесь — то, что возможно только для файлового: **легаси-записи** без поля
 * `scope` (сохранённые до появления области видимости) читаются как
 * `project` — это историческое поведение.
 */
describe('FileMemoryIndexStore: область видимости индекса', () => {
  let dataDir: string;
  let store: FileMemoryIndexStore;

  /** Запись индекса для файлового теста (без поля `scope` — легаси). */
  function legacyIndex(id: string): Omit<MemoryIndexRecord, 'scope'> {
    return {
      id,
      namespace: 'plugin:synth-plugin-memory',
      name: id,
      providerId: 'plugin:synth-plugin-memory',
      projectId: 'project-1',
      source: { kind: 'project', filter: '**/*.ts' },
      state: 'ready',
      generation: 1,
      fingerprint: { model: 'text-embed', dimension: 8, chunkerVersion: 'v1' },
      stats: { documents: 1, chunks: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /** Записать коллекцию индексов в файл напрямую (минуя порт). */
  async function writeIndexesFile(items: unknown[]): Promise<void> {
    await mkdir(join(dataDir, 'memory'), { recursive: true });
    await writeFile(
      join(dataDir, 'memory', 'indexes.json'),
      JSON.stringify({ schemaVersion: 1, indexes: items }, null, 2),
      'utf-8',
    );
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-memory-index-'));
    store = new FileMemoryIndexStore({ dataDir });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('легаси-запись без поля scope читается как project', async () => {
    await writeIndexesFile([legacyIndex('legacy-1')]);

    const legacy = await store.getIndex('legacy-1');
    expect(legacy?.scope).toBe('project');
    expect(legacy?.projectId).toBe('project-1');
  });

  it('легаси-запись попадает в выборку по scope=project и не попадает в scope=instance', async () => {
    await writeIndexesFile([legacyIndex('legacy-1')]);

    expect((await store.listIndexes({ scope: 'project' })).map((i) => i.id)).toEqual(['legacy-1']);
    expect(await store.listIndexes({ scope: 'instance' })).toEqual([]);
  });

  it('невалидное значение scope читается как project', async () => {
    await writeIndexesFile([{ ...legacyIndex('broken-1'), scope: 'unknown' }]);

    expect((await store.getIndex('broken-1'))?.scope).toBe('project');
    expect((await store.listIndexes({ scope: 'project' })).map((i) => i.id)).toEqual(['broken-1']);
    expect(await store.listIndexes({ scope: 'instance' })).toEqual([]);
  });

  it('запись сохраняет область видимости как есть', async () => {
    await store.saveIndex({ ...legacyIndex('index-1'), scope: 'instance' });

    const raw = JSON.parse(await readFile(join(dataDir, 'memory', 'indexes.json'), 'utf-8'));
    expect(raw.indexes[0].scope).toBe('instance');
    expect((await store.getIndex('index-1'))?.scope).toBe('instance');
    expect((await store.listIndexes({ scope: 'instance' })).map((i) => i.id)).toEqual(['index-1']);
  });
});
