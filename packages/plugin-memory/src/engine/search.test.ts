/**
 * М2: тесты гибридного поиска (keyword + вектор + RRF).
 *
 * Проверяются: порядок слияния RRF на синтетических данных, деградация на
 * keyword-only (без векторов и при ошибке эмбеддинга) и поведение на пустом
 * индексе.
 */
import type { MemoryChunkRecord, MemoryIndexRecord, StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { cosine, reciprocalRankFusion, searchIndex } from './search.js';
import { createTestFacade, createTestStorage } from '../test-support.js';

/** Запись индекса для тестов. */
function indexRecord(over: Partial<MemoryIndexRecord> = {}): MemoryIndexRecord {
  const now = '2026-10-24T10:00:00.000Z';
  return {
    id: 'idx_test',
    namespace: 'plugin:synth-plugin-memory',
    name: 'project',
    providerId: 'plugin:synth-plugin-memory',
    projectId: 'p1',
    scope: 'project',
    source: { kind: 'files' },
    state: 'ready',
    generation: 1,
    fingerprint: { model: 'instance-default', dimension: 2, chunkerVersion: '1' },
    stats: { documents: 1, chunks: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Чанк индекса для тестов. */
function chunk(over: Partial<MemoryChunkRecord> & { id: string; text: string }): MemoryChunkRecord {
  return {
    indexId: 'idx_test',
    generation: 1,
    documentId: 'doc.md',
    ordinal: 0,
    ...over,
  };
}

/** Фасад с управляемым эмбеддером: текст с «вектор» → [0, 1], иначе [1, 0]. */
function makeFacade(
  storage: StorageContext,
  embed?: (texts: readonly string[]) => Promise<number[][]>,
) {
  const { facade } = createTestFacade({
    storage,
    ...(embed ? { embed } : {}),
  });
  return facade;
}

describe('поиск по индексу', () => {
  it('RRF сливает keyword- и векторный списки (порядок детерминирован)', async () => {
    const storage = createTestStorage();
    const index = indexRecord();
    await storage.memoryIndexes.saveIndex(index);
    await storage.memoryIndexes.replaceChunks(index.id, 1, [
      chunk({
        id: 'a#0',
        text: 'деплой через fleet',
        vector: [1, 0],
        metadata: { path: 'a.md', startLine: 1, endLine: 2 },
      }),
      chunk({
        id: 'b#0',
        text: 'совсем другое',
        vector: [0, 1],
        metadata: { path: 'b.md', startLine: 1, endLine: 2 },
      }),
      chunk({
        id: 'c#0',
        text: 'деплой в test',
        vector: [0.9, 0.1],
        metadata: { path: 'c.md', startLine: 1, endLine: 2 },
      }),
    ]);

    // Запрос «деплой fleet» → вектор [1, 0].
    const facade = makeFacade(storage, async (texts) =>
      texts.map((text) => (text.includes('вектор') ? [0, 1] : [1, 0])),
    );

    const found = await searchIndex(facade, index.id, 'деплой fleet', { topK: 3 });
    expect(found.readiness).toBe('ready');
    expect(found.items.map((item) => item.chunkId)).toEqual(['a#0', 'c#0', 'b#0']);
    // Скор нормирован в 0..1, лучший — 1.
    expect(found.items[0]!.score).toBe(1);
    expect(found.items[0]!.metadata.path).toBe('a.md');
    expect(found.items[0]!.generation).toBe(1);
    expect(found.items[0]!.indexId).toBe(index.id);
  });

  it('без векторов — keyword-only, готовность degraded', async () => {
    const storage = createTestStorage();
    const index = indexRecord();
    await storage.memoryIndexes.saveIndex(index);
    await storage.memoryIndexes.replaceChunks(index.id, 1, [
      chunk({ id: 'a#0', text: 'деплой через fleet' }),
      chunk({ id: 'b#0', text: 'совсем другое' }),
    ]);

    const facade = makeFacade(storage);
    const found = await searchIndex(facade, index.id, 'деплой', { topK: 3 });
    expect(found.readiness).toBe('degraded');
    expect(found.items.map((item) => item.chunkId)).toEqual(['a#0']);
  });

  it('ошибка эмбеддинга запроса — деградация на keyword, без исключения', async () => {
    const storage = createTestStorage();
    const index = indexRecord();
    await storage.memoryIndexes.saveIndex(index);
    await storage.memoryIndexes.replaceChunks(index.id, 1, [
      chunk({ id: 'a#0', text: 'деплой через fleet', vector: [1, 0] }),
    ]);

    const facade = makeFacade(storage, async () => {
      throw new Error('plugin.embedding_not_configured');
    });
    const found = await searchIndex(facade, index.id, 'деплой', { topK: 3 });
    expect(found.readiness).toBe('degraded');
    expect(found.items.map((item) => item.chunkId)).toEqual(['a#0']);
  });

  it('пустой индекс — без результатов, готовность не ready', async () => {
    const storage = createTestStorage();
    const index = indexRecord();
    await storage.memoryIndexes.saveIndex(index);

    const facade = makeFacade(storage);
    const found = await searchIndex(facade, index.id, 'деплой', { topK: 3 });
    expect(found.items).toEqual([]);
    expect(found.readiness).not.toBe('ready');
  });

  it('индекса нет — готовность unavailable (без исключения)', async () => {
    const storage = createTestStorage();
    const facade = makeFacade(storage);
    const found = await searchIndex(facade, 'idx_missing', 'деплой', { topK: 3 });
    expect(found.items).toEqual([]);
    expect(found.readiness).toBe('unavailable');
  });

  it('индекс помечен stale — готовность stale (корпус отдаётся)', async () => {
    const storage = createTestStorage();
    const index = indexRecord();
    await storage.memoryIndexes.saveIndex(index);
    await storage.memoryIndexes.replaceChunks(index.id, 1, [
      chunk({ id: 'a#0', text: 'деплой через fleet', vector: [1, 0] }),
    ]);

    const facade = makeFacade(storage);
    const found = await searchIndex(facade, index.id, 'деплой', { topK: 3, stale: true });
    expect(found.readiness).toBe('stale');
    expect(found.items).toHaveLength(1);
  });
});

describe('RRF и косинус', () => {
  it('косинус: одинаковые векторы → 1, ортогональные → 0, нулевые → 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([0, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('RRF: элемент из обоих списков поднимается выше', () => {
    const fused = reciprocalRankFusion([
      [{ key: 'a' }, { key: 'b' }],
      [{ key: 'b' }, { key: 'a' }],
    ]);
    // a: 1/61 + 1/62, b: 1/62 + 1/61 — равны, порядок детерминирован по ключу.
    expect(fused.map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 9);
  });

  it('RRF: k задаётся параметром', () => {
    const fused = reciprocalRankFusion([[{ key: 'a' }]], 1);
    expect(fused[0]!.score).toBeCloseTo(1 / 2, 9);
  });
});
