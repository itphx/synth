/**
 * Тесты тула `memory_search` с учётом **инстансных** индексов.
 *
 * Проверяются: фрагменты берутся из всех пригодных индексов (проектных и
 * инстансных), ключи RRF не сталкиваются при одинаковом `chunkId` в разных
 * индексах, а evidence несёт `indexId` и область видимости индекса.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, createTestStorage, toolCtx } from '../test-support.js';
import { createMemorySearchTool } from './search.js';

const tempDirs: string[] = [];

/** Каталог корпуса с одним файлом `deploy.md`. */
async function makeCorpus(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-search-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'deploy.md'), text, 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Провайдер и тул поиска над настоящим in-memory хранилищем. */
function makeMemory() {
  const storage = createTestStorage();
  const { facade } = createTestFacade({ storage });
  const provider = new MemoryProviderLite(facade);
  return { storage, provider, search: createMemorySearchTool(provider) };
}

describe('тул memory_search: инстансные индексы', () => {
  it('одинаковый chunkId из разных индексов: оба фрагмента в выдаче, ключи не сталкиваются', async () => {
    const { storage, provider, search } = makeMemory();
    // Одинаковый относительный путь → одинаковый chunkId (`deploy.md#0`).
    const projectDir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');

    const project = await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: projectDir,
    });
    const instance = await provider.createIndex({
      source: { kind: 'files' },
      scope: 'instance',
      workingDir: instanceDir,
    });
    await provider.indexManager.whenIdle();

    const projectChunks = await storage.memoryIndexes.listChunks(project.index.id, {
      generation: 1,
    });
    const instanceChunks = await storage.memoryIndexes.listChunks(instance.index.id, {
      generation: 1,
    });
    expect(projectChunks.length).toBeGreaterThan(0);
    expect(instanceChunks.map((chunk) => chunk.id)).toEqual(
      projectChunks.map((chunk) => chunk.id),
    );

    const found = await search.execute({ query: 'деплой', limit: 10 }, toolCtx('s1', 'p1'));
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain('Деплой проекта идёт через Fleet.');
    expect(found.content).toContain('Деплой инстанса идёт через Fleet.');

    const results = found.metadata?.results as Array<Record<string, unknown>>;
    const chunks = results.filter((entry) => entry.kind === 'chunk');
    const indexIds = new Set(chunks.map((entry) => entry.indexId));
    // Оба индекса в выдаче — ключи не склеились.
    expect(indexIds.size).toBe(2);
    expect(indexIds.has(project.index.id)).toBe(true);
    expect(indexIds.has(instance.index.id)).toBe(true);
    // Evidence несёт область видимости индекса.
    const scopeByIndex = new Map(chunks.map((entry) => [entry.indexId, entry.scope]));
    expect(scopeByIndex.get(project.index.id)).toBe('project');
    expect(scopeByIndex.get(instance.index.id)).toBe('instance');
  });

  it('инстансный индекс виден из чужого проекта, проектный — нет', async () => {
    const { provider, search } = makeMemory();
    const projectDir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');

    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: projectDir,
    });
    await provider.createIndex({
      source: { kind: 'files' },
      scope: 'instance',
      workingDir: instanceDir,
    });
    await provider.indexManager.whenIdle();

    const found = await search.execute({ query: 'деплой', limit: 10 }, toolCtx('s1', 'p2'));
    expect(found.content).toContain('Деплой инстанса идёт через Fleet.');
    expect(found.content).not.toContain('Деплой проекта идёт через Fleet.');
  });
});
