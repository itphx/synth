/**
 * ADR-094: метрики памяти (`startMemoryMetrics`) — `synth_memory_*`.
 *
 * Проверяем: значения по статусам/состояниям, объём корпуса индексов (чанки по
 * состояниям, только актуальное поколение, индекс без поколения — 0 чанков),
 * отсутствие порта → серий нет (нули-обманки не публикуются), повторный скрейп
 * не плодит серии и ошибка порта не ломает скрейп.
 *
 * ADR-107: телеметрия контекста памяти и recall (`createMemoryTelemetry`) —
 * счётчики/гистограммы инъекции блоков в промпт и recall-запросов, нормализация
 * неизвестных значений в `other` и работа без реестра метрик.
 */
import { describe, it, expect, vi } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { MemoryFactRecord, MemoryFactRepository } from '../../storage/ports/memory-fact-repository.js';
import type {
  MemoryChunkRecord,
  MemoryIndexRecord,
  MemoryIndexRepository,
} from '../../storage/ports/memory-index-repository.js';
import { MEMORY_NAMESPACE } from '../../server/routes/memory.js';
import {
  createMemoryTelemetry,
  startMemoryMetrics,
  MEMORY_CONTEXT_CHARS_BUCKETS,
  MEMORY_RECALL_DURATION_BUCKETS,
  MEMORY_RECALL_HITS_BUCKETS,
} from './memory.js';

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

function makeIndex(id: string, state: MemoryIndexRecord['state'], generation = 1): MemoryIndexRecord {
  return {
    id,
    namespace: MEMORY_NAMESPACE,
    name: id,
    providerId: MEMORY_NAMESPACE,
    scope: 'project',
    source: { kind: 'project' },
    state,
    generation,
    fingerprint: { model: 'text-embed', dimension: 8, chunkerVersion: 'v1' },
    stats: { documents: 1, chunks: 3, updatedAt: '2026-10-12T00:00:00.000Z' },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };
}

function makeChunk(indexId: string, generation: number, id: string): MemoryChunkRecord {
  return {
    indexId,
    generation,
    id,
    documentId: `doc-${indexId}`,
    ordinal: 0,
    text: `чанк ${id}`,
    vector: [0.1, 0.2],
  };
}

/**
 * Обёртка над портом индексов: считает вызовы `countChunks` и умеет ронять
 * их по выбранному индексу (частичный результат пересчёта).
 */
function wrapIndexes(
  repo: MemoryIndexRepository,
  hooks: { countCalls?: string[]; failOn?: (indexId: string) => boolean } = {},
): MemoryIndexRepository {
  return {
    saveIndex: (index) => repo.saveIndex(index),
    getIndex: (id) => repo.getIndex(id),
    listIndexes: (query) => repo.listIndexes(query),
    deleteIndex: (id) => repo.deleteIndex(id),
    setState: (id, state, error) => repo.setState(id, state, error),
    replaceChunks: (indexId, generation, chunks) => repo.replaceChunks(indexId, generation, chunks),
    listChunks: (indexId, opts) => repo.listChunks(indexId, opts),
    deleteChunks: (indexId, generation) => repo.deleteChunks(indexId, generation),
    countChunks: async (indexId, generation) => {
      hooks.countCalls?.push(indexId);
      if (hooks.failOn?.(indexId)) throw new Error('сбой подсчёта чанков');
      return repo.countChunks(indexId, generation);
    },
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

  it('объём корпуса: число чанков по состояниям индексов', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryIndexes.saveIndex(makeIndex('i-ready-1', 'ready'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-ready-2', 'ready'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-stale', 'stale'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-building', 'building'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-failed', 'failed'));
    await storage.memoryIndexes.replaceChunks('i-ready-1', 1, [
      makeChunk('i-ready-1', 1, 'c1'),
      makeChunk('i-ready-1', 1, 'c2'),
    ]);
    await storage.memoryIndexes.replaceChunks('i-ready-2', 1, [makeChunk('i-ready-2', 1, 'c1')]);
    await storage.memoryIndexes.replaceChunks('i-stale', 1, [
      makeChunk('i-stale', 1, 'c1'),
      makeChunk('i-stale', 1, 'c2'),
      makeChunk('i-stale', 1, 'c3'),
    ]);

    const stop = startMemoryMetrics(registry, { indexes: storage.memoryIndexes });

    await vi.waitFor(() => {
      const rendered = registry.render().text;
      expect(valueOf(rendered, 'synth_memory_index_chunks{status="ready"}')).toBe(3);
      expect(valueOf(rendered, 'synth_memory_index_chunks{status="stale"}')).toBe(3);
      expect(valueOf(rendered, 'synth_memory_index_chunks{status="building"}')).toBe(0);
      expect(valueOf(rendered, 'synth_memory_index_chunks{status="failed"}')).toBe(0);
    });

    stop();
  });

  it('объём корпуса: учитывается только актуальное поколение', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryIndexes.saveIndex(makeIndex('i-1', 'ready', 2));
    await storage.memoryIndexes.replaceChunks('i-1', 1, [
      makeChunk('i-1', 1, 'old-1'),
      makeChunk('i-1', 1, 'old-2'),
      makeChunk('i-1', 1, 'old-3'),
    ]);
    await storage.memoryIndexes.replaceChunks('i-1', 2, [makeChunk('i-1', 2, 'new-1')]);

    const stop = startMemoryMetrics(registry, { indexes: storage.memoryIndexes });

    await vi.waitFor(() => {
      expect(valueOf(registry.render().text, 'synth_memory_index_chunks{status="ready"}')).toBe(1);
    });

    stop();
  });

  it('индекс без поколения (generation 0) чанков не даёт и не опрашивается', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryIndexes.saveIndex(makeIndex('i-empty', 'building', 0));
    await storage.memoryIndexes.replaceChunks('i-empty', 0, [makeChunk('i-empty', 0, 'c1')]);
    const countCalls: string[] = [];
    const indexes = wrapIndexes(storage.memoryIndexes, { countCalls });

    const stop = startMemoryMetrics(registry, { indexes });

    await vi.waitFor(() => {
      const rendered = registry.render().text;
      expect(valueOf(rendered, 'synth_memory_indexes{status="building"}')).toBe(1);
      expect(valueOf(rendered, 'synth_memory_index_chunks{status="building"}')).toBe(0);
    });
    expect(countCalls).not.toContain('i-empty');

    stop();
  });

  it('ошибка countChunks по одному индексу: остальные считаются, скрейп не ломается', async () => {
    const registry = new MetricsRegistry();
    const storage = createMemoryStorage();
    await storage.memoryIndexes.saveIndex(makeIndex('i-ok', 'ready'));
    await storage.memoryIndexes.saveIndex(makeIndex('i-broken', 'ready'));
    await storage.memoryIndexes.replaceChunks('i-ok', 1, [
      makeChunk('i-ok', 1, 'c1'),
      makeChunk('i-ok', 1, 'c2'),
    ]);
    await storage.memoryIndexes.replaceChunks('i-broken', 1, [makeChunk('i-broken', 1, 'c1')]);
    const indexes = wrapIndexes(storage.memoryIndexes, { failOn: (id) => id === 'i-broken' });

    const stop = startMemoryMetrics(registry, { indexes });

    await vi.waitFor(() => {
      // Битый индекс пропущен, два чанка рабочего индекса учтены.
      expect(valueOf(registry.render().text, 'synth_memory_index_chunks{status="ready"}')).toBe(2);
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
    expect(seriesCount(rendered, 'synth_memory_index_chunks')).toBe(0);
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
    expect(seriesCount(first, 'synth_memory_index_chunks')).toBe(4);
    expect(seriesCount(second, 'synth_memory_index_chunks')).toBe(4);

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
    // Порт недоступен — данных нет, значит и серий нет (нули-обманки не публикуем).
    const rendered = registry.render().text;
    expect(seriesCount(rendered, 'synth_memory_indexes')).toBe(0);
    expect(seriesCount(rendered, 'synth_memory_index_chunks')).toBe(0);
    stop();
  });
});

/**
 * ADR-107: телеметрия контекста памяти и recall.
 */
describe('createMemoryTelemetry', () => {
  it('блоки памяти в промпте: счётчик по блоку/статусу и гистограмма символов', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);

    telemetry.recordContext([
      { block: 'facts', status: 'loaded', chars: 120 },
      { block: 'recall', status: 'truncated', chars: 900 },
    ]);

    const rendered = registry.render().text;
    expect(valueOf(rendered, 'synth_memory_context_injected_total{block="facts",status="loaded"}')).toBe(1);
    expect(valueOf(rendered, 'synth_memory_context_injected_total{block="recall",status="truncated"}')).toBe(1);
    // Объём блока — в гистограмме символов (сумма наблюдений).
    expect(valueOf(rendered, 'synth_memory_context_chars_sum{block="facts"}')).toBe(120);
    expect(valueOf(rendered, 'synth_memory_context_chars_sum{block="recall"}')).toBe(900);
    expect(valueOf(rendered, 'synth_memory_context_chars_count{block="facts"}')).toBe(1);
  });

  it('два блока с одинаковым статусом — два инкремента счётчика', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);

    telemetry.recordContext([{ block: 'facts', status: 'loaded', chars: 10 }]);
    telemetry.recordContext([{ block: 'facts', status: 'loaded', chars: 20 }]);

    const rendered = registry.render().text;
    expect(valueOf(rendered, 'synth_memory_context_injected_total{block="facts",status="loaded"}')).toBe(2);
    expect(valueOf(rendered, 'synth_memory_context_chars_count{block="facts"}')).toBe(2);
  });

  it('recall: счётчик по виду и исходу', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);

    telemetry.recordRecall({ kind: 'recall', outcome: 'hit', hits: 3, durationMs: 120 });
    telemetry.recordRecall({ kind: 'search', outcome: 'empty', hits: 0, durationMs: 10 });

    const rendered = registry.render().text;
    expect(valueOf(rendered, 'synth_memory_recall_queries_total{kind="recall",outcome="hit"}')).toBe(1);
    expect(valueOf(rendered, 'synth_memory_recall_queries_total{kind="search",outcome="empty"}')).toBe(1);
    // Неизвестный исход не заводит серию — только конечные значения.
    expect(seriesCount(rendered, 'synth_memory_recall_queries_total')).toBe(2);
  });

  it('recall: гистограммы числа фрагментов и длительности', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);

    telemetry.recordRecall({ kind: 'recall', outcome: 'hit', hits: 7, durationMs: 250 });

    const rendered = registry.render().text;
    expect(valueOf(rendered, 'synth_memory_recall_hits_count{kind="recall"}')).toBe(1);
    expect(valueOf(rendered, 'synth_memory_recall_hits_sum{kind="recall"}')).toBe(7);
    // Длительность — в секундах.
    expect(valueOf(rendered, 'synth_memory_recall_duration_seconds_sum{kind="recall"}')).toBe(0.25);
    expect(valueOf(rendered, 'synth_memory_recall_duration_seconds_count{kind="recall"}')).toBe(1);
  });

  it('корзины гистограмм — из контракта (реестр отбрасывает неположительные границы)', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);
    telemetry.recordRecall({ kind: 'recall', outcome: 'empty', hits: 0, durationMs: 0 });
    telemetry.recordContext([{ block: 'facts', status: 'empty', chars: 0 }]);

    const rendered = registry.render().text;
    // Граница `0` неположительна — реестр её отбрасывает, первая корзина `le="1"`.
    expect(valueOf(rendered, 'synth_memory_recall_hits_bucket{kind="recall",le="1"}')).toBe(1);
    expect(rendered).toContain('synth_memory_recall_hits_bucket{kind="recall",le="+Inf"} 1');
    // Корзины объёма блока — по контракту.
    for (const bound of MEMORY_CONTEXT_CHARS_BUCKETS) {
      expect(rendered).toContain(`synth_memory_context_chars_bucket{block="facts",le="${bound}"}`);
    }
    for (const bound of MEMORY_RECALL_DURATION_BUCKETS) {
      expect(rendered).toContain(`synth_memory_recall_duration_seconds_bucket{kind="recall",le="${bound}"}`);
    }
    // Ноль в списке контракта есть, но в выводе его нет (реестр: `b > 0`).
    expect(MEMORY_RECALL_HITS_BUCKETS).toContain(0);
    expect(rendered).not.toContain('synth_memory_recall_hits_bucket{kind="recall",le="0"}');
  });

  it('неизвестные значения приводятся к other', () => {
    const registry = new MetricsRegistry();
    const telemetry = createMemoryTelemetry(registry);

    telemetry.recordContext([
      { block: 'что-то' as never, status: 'неизвестно' as never, chars: 5 },
    ]);
    telemetry.recordRecall({
      kind: 'прочее' as never,
      outcome: 'неизвестно' as never,
      hits: 1,
      durationMs: 1,
    });

    const rendered = registry.render().text;
    expect(valueOf(rendered, 'synth_memory_context_injected_total{block="other",status="other"}')).toBe(1);
    expect(valueOf(rendered, 'synth_memory_recall_queries_total{kind="other",outcome="other"}')).toBe(1);
    expect(valueOf(rendered, 'synth_memory_context_chars_sum{block="other"}')).toBe(5);
  });

  it('без реестра метрик ничего не падает (телеметрия — no-op)', () => {
    const telemetry = createMemoryTelemetry(undefined as unknown as MetricsRegistry);

    expect(() => telemetry.recordContext([{ block: 'facts', status: 'loaded', chars: 10 }])).not.toThrow();
    expect(() =>
      telemetry.recordRecall({ kind: 'recall', outcome: 'hit', hits: 1, durationMs: 1 }),
    ).not.toThrow();
  });
});
