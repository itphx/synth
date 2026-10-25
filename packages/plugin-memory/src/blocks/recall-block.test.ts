/**
 * Тесты блока recall по вопросу хода с учётом **инстансных** индексов.
 *
 * Проверяются: слияние выдачи проектного и инстансного индексов, дедуп по
 * паре `indexId:chunkId` (chunkId уникален только в пределах индекса) и
 * пометка устаревшего индекса (`RECALL_STALE_NOTICE`).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StorageContext } from '@itphx/synth-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RECALL_BLOCK_HEADER,
  RECALL_STALE_NOTICE,
  createRecallBlock,
} from './recall-block.js';
import { MemoryProviderLite } from '../provider.js';
import { blockCtx, createTestFacade, createTestStorage, fakeEmbed } from '../test-support.js';

const tempDirs: string[] = [];

/** Каталог корпуса с одним файлом `deploy.md`. */
async function makeCorpus(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-recall-'));
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

/** Провайдер с управляемой размерностью эмбеддингов. */
function makeProvider(
  storage: StorageContext,
  options: { embed?: (texts: readonly string[]) => Promise<number[][]> } = {},
): MemoryProviderLite {
  const { facade } = createTestFacade({
    storage,
    settings: { dimensionProbeTtlMs: 0 },
    ...(options.embed ? { embed: options.embed } : {}),
  });
  return new MemoryProviderLite(facade);
}

describe('блок recall: инстансный и проектный индексы', () => {
  it('выдача содержит фрагменты обоих индексов', async () => {
    const storage = createTestStorage();
    const projectDir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');
    const provider = makeProvider(storage);

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

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));

    expect(content.split('\n')[0]).toBe(RECALL_BLOCK_HEADER);
    expect(content).toContain('Деплой проекта идёт через Fleet.');
    expect(content).toContain('Деплой инстанса идёт через Fleet.');
  });

  it('одинаковый chunkId из разных индексов не склеивается', async () => {
    const storage = createTestStorage();
    // Оба корпуса дают один и тот же chunkId (`deploy.md#0`) — но индексы
    // разные, поэтому фрагменты оба попадают в выдачу.
    const projectDir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');
    const provider = makeProvider(storage);

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

    // Чанки обоих индексов имеют одинаковые id (относительный путь файла),
    // но относятся к разным индексам.
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

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));
    const lines = content.split('\n').filter((line) => line.startsWith('- '));
    // Дедуп по `indexId:chunkId`: фрагменты обоих индексов остаются.
    expect(lines).toHaveLength(projectChunks.length + instanceChunks.length);
    expect(content).toContain('Деплой проекта идёт через Fleet.');
    expect(content).toContain('Деплой инстанса идёт через Fleet.');
  });

  it('порядок выдачи детерминирован (одинаковый вход → одинаковый блок)', async () => {
    const storage = createTestStorage();
    const projectDir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');
    const provider = makeProvider(storage);

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

    const block = createRecallBlock(provider);
    const first = await block.load(blockCtx({ projectId: 'p1', query: 'деплой' }));
    const second = await block.load(blockCtx({ projectId: 'p1', query: 'деплой' }));
    expect(first).toBe(second);
  });

  it('устаревший индекс → пометка RECALL_STALE_NOTICE', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus('# Проект\n\nДеплой проекта идёт через Fleet.\n');
    let dimension = 4;
    const provider = makeProvider(storage, {
      embed: (texts) => fakeEmbed(texts, dimension),
    });

    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    // Смена модели эмбеддинга → индекс `stale`.
    dimension = 8;

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));
    expect(content).toContain(RECALL_STALE_NOTICE);
  });

  it('инстансный индекс виден и сессии без проекта', async () => {
    const storage = createTestStorage();
    const instanceDir = await makeCorpus('# Инстанс\n\nДеплой инстанса идёт через Fleet.\n');
    const provider = makeProvider(storage);

    await provider.createIndex({
      source: { kind: 'files' },
      scope: 'instance',
      workingDir: instanceDir,
    });
    await provider.indexManager.whenIdle();

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ query: 'деплой' })));
    expect(content).toContain('Деплой инстанса идёт через Fleet.');
  });
});
