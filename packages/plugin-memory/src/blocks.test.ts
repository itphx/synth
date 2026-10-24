/**
 * М1: тесты блоков промпта (факты и recall).
 *
 * Проверяются свойства, важные для промпта: детерминированность (prompt-cache,
 * ADR-070), скоуп по проекту, пустой блок вместо пустой строки и деградация
 * при недоступном хранилище памяти.
 */
import { describe, expect, it } from 'vitest';

import { FACTS_BLOCK_HEADER, FACTS_BLOCK_KEY, createFactsBlock } from './blocks/facts-block.js';
import { RECALL_BLOCK_HEADER, RECALL_BLOCK_KEY, createRecallBlock } from './blocks/recall-block.js';
import { MemoryProviderLite } from './provider.js';
import { blockCtx, createTestFacade, createTestStorage } from './test-support.js';
import type { StorageContext } from '@itphx/synth-core';

/** Засеять факт в памяти плагина (namespace навязывает хост). */
async function seedFact(
  storage: StorageContext,
  over: {
    id: string;
    text: string;
    projectId?: string;
    confidence?: number;
    updatedAt?: string;
  },
): Promise<void> {
  const updatedAt = over.updatedAt ?? '2026-10-20T10:00:00.000Z';
  await storage.memoryFacts.save({
    id: over.id,
    namespace: 'plugin:synth-plugin-memory',
    version: 1,
    text: over.text,
    kind: 'observation',
    ...(over.projectId ? { projectId: over.projectId } : {}),
    provenance: { sourceKind: 'session', sourceId: 's42', capturedAt: updatedAt },
    confidence: over.confidence ?? 0.8,
    status: 'active',
    createdAt: updatedAt,
    updatedAt,
  });
}

describe('блок фактов памяти', () => {
  it('одинаковый вход → одинаковый текст (детерминизм)', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_1',
      text: 'Провайдер itphx — основной для dev',
      projectId: 'p1',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_2',
      text: 'Деплой идёт через Fleet',
      projectId: 'p1',
      confidence: 0.5,
    });
    const { facade } = createTestFacade({ storage });
    const block = createFactsBlock(new MemoryProviderLite(facade));

    const first = await block.load(blockCtx({ projectId: 'p1' }));
    const second = await block.load(blockCtx({ projectId: 'p1' }));
    expect(first).toBe(second);
    expect(typeof first).toBe('string');
  });

  it('порядок: уверенность ↓ → свежесть ↓ → id ↑', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_low',
      text: 'Низкая уверенность',
      projectId: 'p1',
      confidence: 0.4,
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    await seedFact(storage, {
      id: 'mem_high_old',
      text: 'Высокая уверенность, но старее',
      projectId: 'p1',
      confidence: 0.9,
      updatedAt: '2026-10-10T10:00:00.000Z',
    });
    await seedFact(storage, {
      id: 'mem_high_new',
      text: 'Высокая уверенность и свежее',
      projectId: 'p1',
      confidence: 0.9,
      updatedAt: '2026-10-23T10:00:00.000Z',
    });
    const { facade } = createTestFacade({ storage });
    const block = createFactsBlock(new MemoryProviderLite(facade));

    const content = String(await block.load(blockCtx({ projectId: 'p1' })));
    const lines = content.split('\n').slice(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Высокая уверенность и свежее');
    expect(lines[1]).toContain('Высокая уверенность, но старее');
    expect(lines[2]).toContain('Низкая уверенность');
  });

  it('формат строки: утверждение + провенанс + дата', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_1',
      text: 'Деплой идёт через Fleet',
      projectId: 'p1',
      confidence: 0.9,
      updatedAt: '2026-10-12T08:30:00.000Z',
    });
    const { facade } = createTestFacade({ storage });
    const block = createFactsBlock(new MemoryProviderLite(facade));

    const content = String(await block.load(blockCtx({ projectId: 'p1' })));
    expect(content.split('\n')[0]).toBe(FACTS_BLOCK_HEADER);
    expect(content).toContain('- Деплой идёт через Fleet (src: session s42, 2026-10-12)');
  });

  it('скоуп по проекту: чужие проекты в блок не попадают', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_p1', text: 'Факт проекта p1', projectId: 'p1' });
    await seedFact(storage, { id: 'mem_p2', text: 'Факт проекта p2', projectId: 'p2' });
    await seedFact(storage, { id: 'mem_global', text: 'Общий факт без проекта' });
    const { facade } = createTestFacade({ storage });
    const block = createFactsBlock(new MemoryProviderLite(facade));

    const inP1 = String(await block.load(blockCtx({ projectId: 'p1' })));
    expect(inP1).toContain('Факт проекта p1');
    expect(inP1).not.toContain('Факт проекта p2');

    // Без проекта — только факты без проекта.
    const global = String(await block.load(blockCtx()));
    expect(global).toContain('Общий факт без проекта');
    expect(global).not.toContain('Факт проекта p1');
  });

  it('нет фактов → блок пуст (null), а не пустая строка', async () => {
    const { facade } = createTestFacade();
    const block = createFactsBlock(new MemoryProviderLite(facade));
    expect(await block.load(blockCtx({ projectId: 'p1' }))).toBeNull();
  });

  it('хранилище памяти недоступно → блок пуст (null)', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const block = createFactsBlock(new MemoryProviderLite(facade));
    expect(await block.load(blockCtx({ projectId: 'p1' }))).toBeNull();
  });

  it('ключ и тир блока совпадают с манифестом', () => {
    const { facade } = createTestFacade();
    const block = createFactsBlock(new MemoryProviderLite(facade));
    expect(block.key).toBe(FACTS_BLOCK_KEY);
    expect(block.tier).toBe('context');
    expect(block.order).toBe(100);
  });
});

describe('блок recall по вопросу хода', () => {
  it('без вопроса хода → блок пуст (null)', async () => {
    const storage = createTestStorage();
    await seedFact(storage, { id: 'mem_1', text: 'Деплой идёт через Fleet' });
    const { facade } = createTestFacade({ storage });
    const block = createRecallBlock(new MemoryProviderLite(facade));
    expect(await block.load(blockCtx({ projectId: 'p1' }))).toBeNull();
  });

  it('по вопросу находит релевантный факт', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_top',
      text: 'Провайдер itphx — основной для dev',
      projectId: 'p1',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_hit',
      text: 'Деплой в test идёт через Fleet',
      projectId: 'p1',
      confidence: 0.5,
    });
    await seedFact(storage, {
      id: 'mem_other',
      text: 'Что-то ещё',
      projectId: 'p1',
      confidence: 0.4,
    });
    // factsLimit = 1 → в блок фактов попадает только самый уверенный факт,
    // остальные остаются кандидатами recall.
    const { facade } = createTestFacade({ storage, settings: { factsLimit: 1 } });
    const block = createRecallBlock(new MemoryProviderLite(facade));

    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'как идёт деплой' })));
    expect(content.split('\n')[0]).toBe(RECALL_BLOCK_HEADER);
    expect(content).toContain('Деплой в test идёт через Fleet');
    expect(content).not.toContain('Провайдер itphx');
    expect(content).not.toContain('Что-то ещё');
  });

  it('не дублирует факт, уже попавший в блок фактов', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_top',
      text: 'Деплой идёт через Fleet',
      projectId: 'p1',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_low',
      text: 'Деплой идёт через kubectl',
      projectId: 'p1',
      confidence: 0.2,
    });
    // factsLimit = 1 → в блок фактов попадает только самый уверенный факт.
    const { facade } = createTestFacade({ storage, settings: { factsLimit: 1 } });
    const provider = new MemoryProviderLite(facade);

    const factsContent = String(
      await createFactsBlock(provider).load(blockCtx({ projectId: 'p1' })),
    );
    expect(factsContent).toContain('Деплой идёт через Fleet');
    expect(factsContent).not.toContain('kubectl');

    const recallContent = String(
      await createRecallBlock(provider).load(blockCtx({ projectId: 'p1', query: 'деплой' })),
    );
    expect(recallContent).toContain('Деплой идёт через kubectl');
    expect(recallContent).not.toContain('- Деплой идёт через Fleet');
  });

  it('пусто → блок пуст (null)', async () => {
    const storage = createTestStorage();
    await seedFact(storage, {
      id: 'mem_top',
      text: 'Провайдер itphx — основной для dev',
      projectId: 'p1',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_other',
      text: 'Что-то ещё',
      projectId: 'p1',
      confidence: 0.4,
    });
    const { facade } = createTestFacade({ storage, settings: { factsLimit: 1 } });
    const block = createRecallBlock(new MemoryProviderLite(facade));
    expect(await block.load(blockCtx({ projectId: 'p1', query: 'котлета' }))).toBeNull();
  });

  it('хранилище памяти недоступно → блок пуст (null)', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const block = createRecallBlock(new MemoryProviderLite(facade));
    expect(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' }))).toBeNull();
  });

  it('ключ и тир блока совпадают с манифестом', () => {
    const { facade } = createTestFacade();
    const block = createRecallBlock(new MemoryProviderLite(facade));
    expect(block.key).toBe(RECALL_BLOCK_KEY);
    expect(block.tier).toBe('volatile');
    expect(block.order).toBe(110);
  });
});
