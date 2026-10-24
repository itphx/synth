/**
 * М2: тесты тула `memory_index` (управление индексами памяти).
 *
 * Проверяются: создание/сборка/пересборка/удаление/статус, скоуп по проекту
 * (индексы чужих проектов не видны) и понятная ошибка, когда сервис памяти
 * недоступен.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, createTestStorage } from '../test-support.js';
import { createMemoryIndexTool, MEMORY_INDEX_TOOL_NAME } from './index-tool.js';

const tempDirs: string[] = [];

/** Временный каталог корпуса. */
async function makeCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-index-tool-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'readme.md'), '# Readme\n\nДеплой идёт через Fleet.\n', 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Контекст тула (суженный контекст плагина, ADR-107). */
function ctx(projectId?: string, workingDir = '/ws') {
  return {
    sessionId: 's1',
    messageId: 'm1',
    workingDir,
    ...(projectId ? { projectId } : {}),
  };
}

describe('тул memory_index', () => {
  it('имя тула и capability — как в манифесте', () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));
    expect(tool.name).toBe(MEMORY_INDEX_TOOL_NAME);
    expect(tool.capabilities).toEqual(['memory']);
  });

  it('create → индекс создан, сборка идёт в фоне и завершается успехом', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', name: 'project', source: { kind: 'files' } },
      ctx('p1', dir),
    );
    expect(created.isError).toBeUndefined();
    const indexId = String(created.metadata?.indexId);
    expect(indexId).toMatch(/^idx_/);
    expect(created.metadata?.state).toBe('building');

    await provider.indexManager.whenIdle();

    const status = await tool.execute({ action: 'status' }, ctx('p1', dir));
    expect(status.content).toContain(indexId);
    expect(status.content).toContain('ready');
    const indexes = status.metadata?.indexes as Array<Record<string, unknown>>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.state).toBe('ready');
    expect(indexes[0]!.generation).toBe(1);
  });

  it('rebuild → новое поколение, delete → индекс удалён', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create' }, ctx('p1', dir));
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const rebuilt = await tool.execute({ action: 'rebuild', indexId }, ctx('p1', dir));
    expect(rebuilt.isError).toBeUndefined();
    expect(rebuilt.metadata?.state).toBe('building');
    expect(rebuilt.metadata?.generation).toBe(2);
    await provider.indexManager.whenIdle();

    const status = await tool.execute({ action: 'status' }, ctx('p1', dir));
    const indexes = status.metadata?.indexes as Array<Record<string, unknown>>;
    expect(indexes[0]!.generation).toBe(2);

    const deleted = await tool.execute({ action: 'delete', indexId }, ctx('p1', dir));
    expect(deleted.isError).toBeUndefined();
    expect(deleted.metadata?.deleted).toBe(true);
    expect(await storage.memoryIndexes.getIndex(indexId)).toBeNull();

    const empty = await tool.execute({ action: 'status' }, ctx('p1', dir));
    expect(empty.content).toContain('Индексов памяти пока нет');
  });

  it('build/rebuild по имени индекса (без id)', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const rebuilt = await tool.execute({ action: 'build', name: 'docs' }, ctx('p1', dir));
    expect(rebuilt.isError).toBeUndefined();
    expect(rebuilt.metadata?.generation).toBe(2);
  });

  it('скоуп по проекту: индексы чужого проекта не видны и не удаляются', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create' }, ctx('p1', dir));
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const foreign = await tool.execute({ action: 'status' }, ctx('p2', dir));
    expect(foreign.content).toContain('Индексов памяти пока нет');

    const foreignDelete = await tool.execute({ action: 'delete', indexId }, ctx('p2', dir));
    expect(foreignDelete.isError).toBe(true);
    // Индекс чужого проекта на месте.
    expect(await storage.memoryIndexes.getIndex(indexId)).not.toBeNull();
  });

  it('неизвестный индекс → понятная ошибка', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'rebuild', indexId: 'idx_missing' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Индекс не найден');
  });

  it('некорректные аргументы → понятная ошибка', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'unknown' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('хранилище памяти недоступно → понятная ошибка (тул зарегистрирован)', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'status' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });
});
