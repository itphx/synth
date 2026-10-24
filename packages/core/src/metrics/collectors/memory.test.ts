/**
 * ADR-094: метрики памяти (`startMemoryMetrics`) — `synth_memory_*`.
 *
 * Проверяем: значения по статусам/состояниям, отсутствие порта → серий нет
 * (нули-обманки не публикуются), повторный скрейп не плодит серии и ошибка
 * порта не ломает скрейп.
 */
import { describe, it, expect, vi } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { MemoryFactRecord, MemoryFactRepository } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRecord, MemoryIndexRepository } from '../../storage/ports/memory-index-repository.js';
import { MEMORY_NAMESPACE } from '../../server/routes/memory.js';
import { startMemoryMetrics } from './memory.js';

/** Значение серии по точному префиксу строки (`name{...} value`). */
function valueOf(text: string, prefix: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${prefix} `));
  if (!line) return undefined;
  return Number(line.slice(prefix.length + 1));
}

/** Число серий метрики в тексте exposition. */
function seriesCount(text: string, name: string): number {
  return text.split('\n').filter((l) => l.startsWith(`${name}{`)).length;
}

function makeFact(id: string, status: MemoryFactRecord['status']): MemoryFactRecord {
  return {
    id,
    namespace: MEMORY_NAMESPACE,
    version: 1,
    text: `факт ${id}`,
    kind: 'decision',
    provenance: { sourceKind: 'session', sourceId: 's-1', capturedAt: '2026-10-12T00:00:00.000Z' },
    confidence: 0.9,
    status,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
}

function makeIndex(id: string, state: MemoryIndexRecord['state']): MemoryIndexRecord {
  return {
    id,
    namespace: MEMORY_NAMESPACE,
    name: id,
    providerId: MEMORY_NAMESPACE,
    source: { kind: 'project' },
    state,
    generation: 1,
    fingerprint: { model: 'text-embed', dimension: 8, chunkerVersion: 'v1' },
    stats: { documents: 1, chunks: 3, updatedAt: '2026-10-12T00:00:00.000Z' },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
}

describe('startMemoryMetrics', () => {
  it('значения по статусам фактов и состояниям индексов', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryFacts.save(makeFact('f-1', 'active'));
    await storage.memoryFacts.save(makeFact('f-2', 'active'));
    await storage.memoryFacts.save(makeFact('f-3', 'candidate'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-1', 'ready'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-2', 'stale'));

    const stop = startMemoryMetrics(registry, {
      facts: storage.memoryFacts,
      indexes: storage.memoryIndexes,
    });

    await vi.waitFor(() => {
      const rendered = registry.render().text;
      expect(valueOf(rendered, 'synth_memory_facts{status="active"}')).toBe(2);
      expect(valueOf(rendered, 'synth_memory_facts{status="candidate"}')).toBe(1);
      expect(valueOf(rendered, 'synth_memory_facts{status="superseded"}')).toBe(0);
      expect(valueOf(rendered, 'synth_memory_facts{status="retracted"}')).toBe(0);
      expect(valueOf(rendered, 'synth_memory_indexes{status="ready"}')).toBe(1);
      expect(valueOf(rendered, 'synth_memory_indexes{status="stale"}')).toBe(1);
      expect(valueOf(rendered, 'synth_memory_indexes{status="failed"}')).toBe(0);
      expect(valueOf(rendered, 'synth_memory_indexes{status="building"}')).toBe(0);
    });

    stop();
  });

  it('без портов серии не публикуются (нули-обманки нет)', async () => {
    const registry = new MetricsRegistry();
    const stop = startMemoryMetrics(registry, {});
    registry.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rendered = registry.render().text;
    expect(seriesCount(rendered, 'synth_memory_facts')).toBe(0);
    expect(seriesCount(rendered, 'synth_memory_indexes')).toBe(0);
    stop();
  });

  it('повторный скрейп не плодит серии', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryFacts.save(makeFact('f-1', 'active'));
    const stop = startMemoryMetrics(registry, {
      facts: storage.memoryFacts,
      indexes: storage.memoryIndexes,
    });

    await vi.waitFor(() => {
      expect(valueOf(registry.render().text, 'synth_memory_facts{status="active"}')).toBe(1);
    });

    const first = registry.render().text;
    const second = registry.render().text;
    expect(seriesCount(first, 'synth_memory_facts')).toBe(4);
    expect(seriesCount(second, 'synth_memory_facts')).toBe(4);
    expect(seriesCount(second, 'synth_memory_indexes')).toBe(4);

    stop();
  });

  it('ошибка порта не ломает скрейп', async () => {
    const registry = new MetricsRegistry();
    const brokenFacts: MemoryFactRepository = {
      save: async () => {},
      get: async () => null,
      list: async () => [],
      delete: async () => false,
      supersede: async () => false,
      count: async () => { throw new Error('порт памяти недоступен'); },
    };
    const brokenIndexes: MemoryIndexRepository = {
      saveIndex: async () => {},
      getIndex: async () => null,
      listIndexes: async () => { throw new Error('порт памяти недоступен'); },
      deleteIndex: async () => false,
      setState: async () => false,
      replaceChunks: async () => 0,
      listChunks: async () => [],
      deleteChunks: async () => 0,
      countChunks: async () => 0,
    };
    const stop = startMemoryMetrics(registry, {
      facts: brokenFacts,
      indexes: brokenIndexes,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => registry.render()).not.toThrow();
    stop();
  });
});
