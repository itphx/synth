/**
 * М2: сквозной тест ванильного RAG — корпус → индекс → recall и поиск.
 *
 * Проверяется главный сценарий М2: индекс реально строится по файлам
 * временного каталога, блок recall и тул `memory_search` отдают найденные
 * фрагменты с источником (путь, строки, score), а устаревший индекс
 * помечается, а не выдаётся за «не найдено».
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRecallBlock, RECALL_STALE_NOTICE } from './blocks/recall-block.js';
import { MemoryProviderLite } from './provider.js';
import { createTestFacade, createTestStorage, fakeEmbed } from './test-support.js';
import { blockCtx, toolCtx } from './test-support.js';
import { createMemorySearchTool } from './tools/search.js';

const tempDirs: string[] = [];

/** Каталог корпуса с одним содержательным файлом. */
async function makeCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-rag-'));
  tempDirs.push(dir);
  await writeFile(
    join(dir, 'deploy.md'),
    ['# Деплой', '', 'В test деплой идёт через Fleet, а не через kubectl.', ''].join('\n'),
    'utf-8',
  );
  await writeFile(join(dir, 'other.md'), 'Совсем другая тема: рецепты блинов.\n', 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('ванильный RAG: корпус → индекс → выдача', () => {
  it('блок recall находит фрагмент корпуса с источником', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);

    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    const block = createRecallBlock(provider);
    const content = String(
      await block.load(blockCtx({ projectId: 'p1', query: 'как идёт деплой в test' })),
    );
    expect(content).toContain('[MEMORY: recall for this turn]');
    expect(content).toContain('Fleet');
    // Evidence: путь файла и диапазон строк.
    expect(content).toContain('src: deploy.md');
    expect(content).toMatch(/\d+-\d+/);
    expect(content).toMatch(/score \d\.\d\d/);
    // Впереди — релевантный фрагмент (по ключевым словам).
    const first = content.split('\n')[1] ?? '';
    expect(first).toContain('src: deploy.md');
  });

  it('тул memory_search отдаёт фрагменты корпуса вместе с фактами', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    await storage.memoryFacts.save({
      id: 'mem_1',
      namespace: 'plugin:synth-plugin-memory',
      version: 1,
      text: 'Деплой в test идёт через Fleet',
      kind: 'decision',
      projectId: 'p1',
      provenance: { sourceKind: 'session', sourceId: 's1', capturedAt: '2026-10-20T10:00:00.000Z' },
      confidence: 0.9,
      status: 'active',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    });

    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    const tool = createMemorySearchTool(provider);
    const result = await tool.execute({ query: 'деплой test Fleet' }, toolCtx('s1', 'p1'));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Fleet');
    const evidence = result.metadata?.results as Array<Record<string, unknown>>;
    expect(evidence.length).toBeGreaterThan(0);
    expect(
      evidence.some((entry) => entry.kind === 'chunk' && entry.path === 'deploy.md'),
    ).toBe(true);
  });

  it('устаревший индекс помечается, а не выдаётся как «не найдено»', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    let dimension = 4;
    const { facade } = createTestFacade({
      storage,
      settings: { dimensionProbeTtlMs: 0 },
      embed: (texts) => fakeEmbed(texts, dimension),
    });
    const provider = new MemoryProviderLite(facade);

    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: dir,
    });
    await provider.indexManager.whenIdle();

    // Модель инстанса сменилась — индекс устарел.
    dimension = 8;
    const block = createRecallBlock(provider);
    const content = String(
      await block.load(blockCtx({ projectId: 'p1', query: 'как идёт деплой в test' })),
    );
    expect(content).toContain(RECALL_STALE_NOTICE);
    expect(content).toContain('Fleet');
  });

  it('без индекса recall деградирует на keyword по фактам', async () => {
    const storage = createTestStorage();
    // Два факта: уверенный уходит в блок фактов, второй — в recall.
    for (const [id, text, confidence] of [
      ['mem_1', 'Деплой в test идёт через Fleet', 0.9],
      ['mem_2', 'Деплой в test идёт через kubectl', 0.2],
    ] as const) {
      await storage.memoryFacts.save({
        id,
        namespace: 'plugin:synth-plugin-memory',
        version: 1,
        text,
        kind: 'decision',
        projectId: 'p1',
        provenance: {
          sourceKind: 'session',
          sourceId: 's1',
          capturedAt: '2026-10-20T10:00:00.000Z',
        },
        confidence,
        status: 'active',
        createdAt: '2026-10-20T10:00:00.000Z',
        updatedAt: '2026-10-20T10:00:00.000Z',
      });
    }
    const { facade } = createTestFacade({ storage, settings: { factsLimit: 1 } });
    const provider = new MemoryProviderLite(facade);

    const block = createRecallBlock(provider);
    const content = String(
      await block.load(blockCtx({ projectId: 'p1', query: 'деплой test' })),
    );
    expect(content).toContain('Деплой в test идёт через kubectl');
    // Факт из блока фактов не дублируется.
    expect(content).not.toContain('Fleet');
    expect(content).not.toContain(RECALL_STALE_NOTICE);
  });
});
