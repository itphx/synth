/**
 * Тесты скоупа памяти: явный поиск (`memory_search`) ограничен проектом хода.
 *
 * Правило одно для тула и для блоков промпта (docs/MEMORY.md §3 — «одна
 * реализация recall»): проект сессии задан → факты этого проекта **и** общие
 * (без `projectId`); проект не задан → только общие. Чужие проекты не видны
 * никогда.
 */
import type { StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from './provider.js';
import { createMemorySearchTool } from './tools/search.js';
import { createTestFacade, createTestStorage, toolCtx } from './test-support.js';

/** Засеять факт в памяти плагина (namespace навязывает хост). */
async function seedFact(
  storage: StorageContext,
  over: { id: string; text: string; projectId?: string },
): Promise<void> {
  const ts = '2026-10-20T10:00:00.000Z';
  await storage.memoryFacts.save({
    id: over.id,
    namespace: 'plugin:synth-plugin-memory',
    version: 1,
    text: over.text,
    kind: 'observation',
    ...(over.projectId ? { projectId: over.projectId } : {}),
    provenance: { sourceKind: 'session', sourceId: 's42', capturedAt: ts },
    confidence: 0.8,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  });
}

/** Провайдер и тул поиска над хранилищем с двумя проектами и общим фактом. */
async function makeScopedSearch() {
  const storage = createTestStorage();
  await seedFact(storage, { id: 'mem_a', text: 'Деплой проекта A идёт через Fleet', projectId: 'pA' });
  await seedFact(storage, { id: 'mem_b', text: 'Деплой проекта B идёт через Fleet', projectId: 'pB' });
  await seedFact(storage, { id: 'mem_shared', text: 'Деплой в test идёт через Fleet' });
  const { facade } = createTestFacade({ storage });
  return { search: createMemorySearchTool(new MemoryProviderLite(facade)) };
}

describe('память: скоуп поиска по проекту', () => {
  it('из проекта A видны факт A и общий, но не факт B', async () => {
    const { search } = await makeScopedSearch();

    const found = await search.execute({ query: 'деплой' }, toolCtx('s1', 'pA'));
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain('Деплой проекта A идёт через Fleet');
    expect(found.content).toContain('Деплой в test идёт через Fleet');
    expect(found.content).not.toContain('Деплой проекта B идёт через Fleet');
  });

  it('без проекта виден только общий факт', async () => {
    const { search } = await makeScopedSearch();

    const found = await search.execute({ query: 'деплой' }, toolCtx('s1'));
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain('Деплой в test идёт через Fleet');
    expect(found.content).not.toContain('Деплой проекта A идёт через Fleet');
    expect(found.content).not.toContain('Деплой проекта B идёт через Fleet');
  });
});
