/**
 * М5: тесты тула `memory_graph` (граф сущностей памяти).
 *
 * Проверяются: имя и capability тула, скоуп по проекту сессии (чужие проекты
 * не видны), валидация `depth`/`limit`, недоступная память и текст ответа
 * (сводка по графу и разбор по сущности).
 */
import type { StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, createTestStorage, TEST_PLUGIN_NAME, toolCtx } from '../test-support.js';
import { createMemoryGraphTool, MEMORY_GRAPH_TOOL_NAME } from './graph.js';

/** Namespace памяти плагина (навязывает хост, ADR-107). */
const NAMESPACE = `plugin:${TEST_PLUGIN_NAME}`;

/** Параметры факта, который тест кладёт в порт. */
interface SeedFact {
  /** id факта. */
  id: string;
  /** Текст утверждения. */
  text: string;
  /** Проект-владелец факта. */
  projectId?: string;
}

/** Положить активный факт в порт памяти плагина. */
async function seedFact(storage: StorageContext, fact: SeedFact): Promise<void> {
  await storage.memoryFacts.save({
    id: fact.id,
    namespace: NAMESPACE,
    version: 1,
    text: fact.text,
    kind: 'observation',
    ...(fact.projectId ? { projectId: fact.projectId } : {}),
    provenance: { sourceKind: 'agent', sourceId: 's1', capturedAt: '2026-10-24T10:00:00.000Z' },
    confidence: 0.7,
    status: 'active',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
  });
}

/** Тул над настоящим in-memory хранилищем. */
function makeTool() {
  const storage = createTestStorage();
  const { facade } = createTestFacade({ storage });
  const provider = new MemoryProviderLite(facade);
  return { storage, provider, tool: createMemoryGraphTool(provider) };
}

describe('тул memory_graph', () => {
  it('имя тула и capability — как в манифесте', () => {
    const { tool } = makeTool();
    expect(tool.name).toBe(MEMORY_GRAPH_TOOL_NAME);
    expect(tool.capabilities).toEqual(['memory']);
  });

  it('скоуп по проекту сессии: чужой проект не виден', async () => {
    const { storage, tool } = makeTool();
    await seedFact(storage, {
      id: 'mem_p1',
      text: 'Деплой идёт через [[Fleet]]',
      projectId: 'p1',
    });
    await seedFact(storage, {
      id: 'mem_p2',
      text: 'Чужой проект упоминает [[СекретныйПроект]]',
      projectId: 'p2',
    });

    const result = await tool.execute({}, toolCtx('s1', 'p1'));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Сущностей: 1');
    expect(result.content).not.toContain('СекретныйПроект');
    const stats = result.metadata?.stats as { entities: number; facts: number };
    expect(stats.entities).toBe(1);
    expect(stats.facts).toBe(1);
  });

  it('глубина вне диапазона → понятная ошибка', async () => {
    const { tool } = makeTool();
    const result = await tool.execute({ depth: 4 }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('лимит вне диапазона → понятная ошибка', async () => {
    const { tool } = makeTool();
    const result = await tool.execute({ limit: 500 }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('хранилище памяти недоступно → понятная ошибка', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const tool = createMemoryGraphTool(new MemoryProviderLite(facade));

    const result = await tool.execute({}, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });

  it('текст ответа по графу: сводка и топ-сущности', async () => {
    const { storage, tool } = makeTool();
    await seedFact(storage, { id: 'mem_a', text: 'Деплой идёт через [[Fleet]]' });
    await seedFact(storage, { id: 'mem_b', text: 'Провайдер [[itphx]] — основной' });

    const result = await tool.execute({}, toolCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Сущностей: 2, фактов: 2, связей: 2');
    expect(result.content).toContain('Топ-сущности (по числу фактов):');
    expect(result.content).toContain('- Fleet — 1 факт');
    const nodes = result.metadata?.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node.id)).toEqual(['entity:Fleet', 'entity:itphx', 'fact:mem_a', 'fact:mem_b']);
    const edges = result.metadata?.edges as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(2);
  });

  it('текст ответа по сущности: факты и соседние сущности', async () => {
    const { storage, tool } = makeTool();
    await seedFact(storage, { id: 'mem_a', text: 'Деплой идёт через [[Fleet]] и [[GitVerse]]' });

    const result = await tool.execute({ entity: 'Fleet', depth: 2 }, toolCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Сущность «Fleet»: 1 факт, 2 связи');
    expect(result.content).toContain('mem_a');
    expect(result.content).toContain('Соседние сущности:');
    expect(result.content).toContain('- GitVerse');
  });

  it('неизвестная сущность — понятный текст, не ошибка', async () => {
    const { storage, tool } = makeTool();
    await seedFact(storage, { id: 'mem_a', text: 'Деплой идёт через [[Fleet]]' });

    const result = await tool.execute({ entity: 'Неизвестно' }, toolCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Сущность «Неизвестно» не найдена');
    const stats = result.metadata?.stats as { entities: number };
    expect(stats.entities).toBe(0);
  });
});
