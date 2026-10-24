/**
 * М4a: тесты тула `memory_consolidate` (консолидация фактов памяти).
 *
 * Проверяются: имя и capability тула, скоуп по проекту сессии (аргумент
 * модели игнорируется), пробный прогон (`dryRun`), понятная ошибка при
 * недопустимом пороге, недоступной памяти и недоступных эмбеддингах.
 */
import type { StorageContext } from '@itphx/synth-core';
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from '../provider.js';
import {
  createTestFacade,
  createTestStorage,
  fakeNgramEmbed,
  TEST_PLUGIN_NAME,
  toolCtx,
} from '../test-support.js';
import { createMemoryConsolidateTool, MEMORY_CONSOLIDATE_TOOL_NAME } from './consolidate.js';

/** Namespace памяти плагина (навязывает хост, ADR-107). */
const NAMESPACE = `plugin:${TEST_PLUGIN_NAME}`;

/** Параметры факта, который тест кладёт в порт. */
interface SeedFact {
  /** id факта. */
  id: string;
  /** Текст утверждения. */
  text: string;
  /** Уверенность. */
  confidence?: number;
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
    confidence: fact.confidence ?? 0.7,
    status: 'active',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
  });
}

/** Тул над настоящим in-memory хранилищем + фейковые эмбеддинги. */
function makeTool(embed?: (texts: readonly string[]) => Promise<number[][]>) {
  const storage = createTestStorage();
  const { facade } = createTestFacade({
    storage,
    ...(embed ? { embed } : {}),
  });
  const provider = new MemoryProviderLite(facade);
  return { storage, provider, tool: createMemoryConsolidateTool(provider) };
}

/** Статус факта в порту (для проверок). */
async function statusOf(storage: StorageContext, id: string): Promise<string | undefined> {
  return (await storage.memoryFacts.get(id))?.status;
}

describe('тул memory_consolidate', () => {
  it('имя тула и capability — как в манифесте', () => {
    const { tool } = makeTool(fakeNgramEmbed);
    expect(tool.name).toBe(MEMORY_CONSOLIDATE_TOOL_NAME);
    expect(tool.capabilities).toEqual(['memory']);
  });

  it('сливает похожие факты и отдаёт сводку с метаданными', async () => {
    const { storage, tool } = makeTool(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    const result = await tool.execute({}, toolCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Кластеров: 1, заменено: 1, оставлено: 1');
    expect(result.metadata?.clusters).toBe(1);
    expect(result.metadata?.superseded).toBe(1);
    expect(result.metadata?.kept).toBe(1);
    const items = result.metadata?.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.keptId).toBe('mem_a');
    expect(items[0]!.supersededIds).toEqual(['mem_b']);
    expect(await statusOf(storage, 'mem_b')).toBe('superseded');
  });

  it('скоуп по проекту сессии: аргумент модели игнорируется', async () => {
    const { storage, tool } = makeTool(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_p1',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
      projectId: 'p1',
    });
    await seedFact(storage, {
      id: 'mem_p1_dup',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
      projectId: 'p1',
    });
    await seedFact(storage, {
      id: 'mem_p2',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
      projectId: 'p2',
    });

    // Аргумент модели указывает на p2 — скоуп сессии (p1) приоритетнее.
    const result = await tool.execute({ projectId: 'p2' }, toolCtx('s1', 'p1'));

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.clusters).toBe(1);
    const items = result.metadata?.items as Array<Record<string, unknown>>;
    expect(items[0]!.keptId).toBe('mem_p1');
    expect(items[0]!.supersededIds).toEqual(['mem_p1_dup']);
    // Факт чужого проекта не тронут.
    expect(await statusOf(storage, 'mem_p2')).toBe('active');
  });

  it('dryRun — план показан, память не изменена', async () => {
    const { storage, tool } = makeTool(fakeNgramEmbed);
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    const result = await tool.execute({ dryRun: true }, toolCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Кластеров: 1, заменено: 1, оставлено: 1');
    expect(result.content).toContain('Пробный прогон');
    expect(await statusOf(storage, 'mem_a')).toBe('active');
    expect(await statusOf(storage, 'mem_b')).toBe('active');
  });

  it('недопустимый порог → понятная ошибка', async () => {
    const { tool } = makeTool(fakeNgramEmbed);
    const result = await tool.execute({ threshold: 0.2 }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('порог вне верхней границы → понятная ошибка', async () => {
    const { tool } = makeTool(fakeNgramEmbed);
    const result = await tool.execute({ threshold: 1.5 }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('хранилище памяти недоступно → понятная ошибка', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const tool = createMemoryConsolidateTool(new MemoryProviderLite(facade));

    const result = await tool.execute({}, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });

  it('эмбеддинги недоступны → ошибка с кодом фасада', async () => {
    const { storage, tool } = makeTool(() => {
      const error = new Error('Эмбеддинги не сконфигурированы');
      Object.assign(error, { code: 'plugin.embedding_not_configured' });
      return Promise.reject(error);
    });
    await seedFact(storage, {
      id: 'mem_a',
      text: 'Деплой в test идёт через Fleet',
      confidence: 0.9,
    });
    await seedFact(storage, {
      id: 'mem_b',
      text: 'Деплой в test идёт через Fleet.',
      confidence: 0.5,
    });

    const result = await tool.execute({}, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Эмбеддинги не сконфигурированы');
    expect(result.metadata?.code).toBe('plugin.embedding_not_configured');
    // Память не тронута.
    expect(await statusOf(storage, 'mem_b')).toBe('active');
  });
});
