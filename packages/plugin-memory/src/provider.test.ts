/**
 * М1: тесты провайдера памяти (write → search → forget).
 *
 * Хранилище — настоящее in-memory (`createMemoryStorage()`), фасад — тестовый
 * (тот же контракт, что отдаёт хост): scoped-доступ к фактам, namespace
 * навязывает хост (ADR-107).
 */
import { describe, expect, it } from 'vitest';

import { MemoryProviderLite } from './provider.js';
import { createMemoryForgetTool } from './tools/forget.js';
import { createMemorySearchTool } from './tools/search.js';
import { createMemoryWriteTool } from './tools/write.js';
import { createTestFacade, createTestStorage, toolCtx } from './test-support.js';

/** Провайдер + тулы над настоящим in-memory хранилищем. */
function makeMemory() {
  const storage = createTestStorage();
  const { facade } = createTestFacade({ storage });
  const provider = new MemoryProviderLite(facade);
  return {
    storage,
    provider,
    write: createMemoryWriteTool(provider),
    search: createMemorySearchTool(provider),
    forget: createMemoryForgetTool(provider),
  };
}

/** Текст факта, записанного тестом. */
const FACT_TEXT = 'Деплой в test идёт через Fleet, а не через kubectl';

describe('память: запись и поиск', () => {
  it('write → факт сохранён, поиск его находит', async () => {
    const { write, search } = makeMemory();

    const written = await write.execute({ text: FACT_TEXT }, toolCtx());
    expect(written.isError).toBeUndefined();
    expect(written.metadata?.factId).toMatch(/^mem_/);
    expect(written.metadata?.version).toBe(1);

    const found = await search.execute({ query: 'деплой fleet' }, toolCtx());
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain(FACT_TEXT);
    expect(found.content).toContain('id: mem_');
    expect(found.content).toContain('conf:');
  });

  it('write без совпадений → «Ничего не найдено» (не ошибка)', async () => {
    const { write, search } = makeMemory();
    await write.execute({ text: FACT_TEXT }, toolCtx());

    const found = await search.execute({ query: 'котлета' }, toolCtx());
    expect(found.isError).toBeUndefined();
    expect(found.content).toBe('Ничего не найдено.');
  });

  it('запись хранит провенанс, версию и статус активного факта', async () => {
    const { write, storage } = makeMemory();
    const written = await write.execute({ text: FACT_TEXT, kind: 'decision' }, toolCtx());
    const factId = String(written.metadata?.factId);

    const stored = await storage.memoryFacts.get(factId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('active');
    expect(stored!.version).toBe(1);
    expect(stored!.kind).toBe('decision');
    expect(stored!.provenance.sourceKind).toBe('agent');
    expect(stored!.provenance.sourceId).toBe('s1');
    // Namespace навязывает хост — плагин его не выбирает.
    expect(stored!.namespace).toBe('plugin:synth-plugin-memory');
  });
});

describe('память: supersede', () => {
  it('замена утверждения создаёт новую версию, старая помечена superseded', async () => {
    const { write, forget, storage } = makeMemory();
    const written = await write.execute({ text: FACT_TEXT }, toolCtx());
    const oldId = String(written.metadata?.factId);

    const forgotten = await forget.execute(
      { factId: oldId, mode: 'supersede', text: 'Деплой в test идёт через Fleet (Railway)' },
      toolCtx(),
    );
    expect(forgotten.isError).toBeUndefined();

    const newId = String(forgotten.metadata?.factId);
    expect(newId).not.toBe(oldId);
    expect(forgotten.metadata?.version).toBe(2);

    const oldFact = await storage.memoryFacts.get(oldId);
    expect(oldFact!.status).toBe('superseded');
    expect(oldFact!.supersededBy).toBe(newId);

    const newFact = await storage.memoryFacts.get(newId);
    expect(newFact!.status).toBe('active');
    expect(newFact!.version).toBe(2);
    expect(newFact!.text).toContain('Railway');
  });

  it('supersede без нового текста → понятная ошибка', async () => {
    const { write, forget } = makeMemory();
    const written = await write.execute({ text: FACT_TEXT }, toolCtx());

    const result = await forget.execute(
      { factId: String(written.metadata?.factId), mode: 'supersede' },
      toolCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('нужен новый текст факта');
  });
});

describe('память: retract', () => {
  it('отзыв скрывает факт из активных', async () => {
    const { write, forget, storage, search } = makeMemory();
    const written = await write.execute({ text: FACT_TEXT }, toolCtx());
    const factId = String(written.metadata?.factId);

    const result = await forget.execute({ factId, mode: 'retract' }, toolCtx());
    expect(result.isError).toBeUndefined();

    const stored = await storage.memoryFacts.get(factId);
    expect(stored!.status).toBe('retracted');

    const active = await storage.memoryFacts.list({ namespace: 'plugin:synth-plugin-memory', status: 'active' });
    expect(active.map((fact) => fact.id)).not.toContain(factId);

    // Явный поиск по умолчанию смотрит только активные факты.
    const found = await search.execute({ query: 'деплой fleet' }, toolCtx());
    expect(found.content).toBe('Ничего не найдено.');
  });
});

describe('память: чужие и несуществующие факты', () => {
  it('несуществующий id → «Факт не найден»', async () => {
    const { forget } = makeMemory();
    const result = await forget.execute({ factId: 'mem_missing', mode: 'retract' }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Факт не найден');
  });

  it('чужой namespace → «Факт не найден» (факт неотличим от отсутствующего)', async () => {
    const { forget, storage, search } = makeMemory();
    await storage.memoryFacts.save({
      id: 'mem_foreign',
      namespace: 'plugin:other-plugin',
      version: 1,
      text: 'Чужое утверждение',
      kind: 'observation',
      provenance: { sourceKind: 'session', sourceId: 's9', capturedAt: '2026-10-20T10:00:00.000Z' },
      confidence: 0.9,
      status: 'active',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    });

    const result = await forget.execute({ factId: 'mem_foreign', mode: 'retract' }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Факт не найден');

    // Чужой факт не виден и в поиске.
    const found = await search.execute({ query: 'чужое утверждение' }, toolCtx());
    expect(found.content).toBe('Ничего не найдено.');

    // И не тронут.
    const foreign = await storage.memoryFacts.get('mem_foreign');
    expect(foreign!.status).toBe('active');
  });
});

describe('память: настройки плагина', () => {
  it('без настроек → дефолты', () => {
    const { facade } = createTestFacade();
    const provider = new MemoryProviderLite(facade);
    expect(provider.settings()).toEqual({
      factsLimit: 6,
      recallLimit: 5,
      minScore: 0.34,
      topK: 5,
      maxChunks: 2000,
      chunkChars: 1200,
      chunkOverlap: 200,
      maxFileBytes: 512_000,
      exclude: [],
      embeddingModel: '',
      dimensionProbeTtlMs: 30_000,
      consolidateThreshold: 0.9,
    });
  });

  it('значения вне диапазона приводятся к границам', () => {
    const { facade } = createTestFacade({
      settings: { factsLimit: 100, recallLimit: 0, minScore: 5 },
    });
    const provider = new MemoryProviderLite(facade);
    const settings = provider.settings();
    expect(settings.factsLimit).toBe(20);
    expect(settings.recallLimit).toBe(1);
    expect(settings.minScore).toBe(1);
  });

  it('нечисловые значения → дефолты', () => {
    const { facade } = createTestFacade({
      settings: { factsLimit: 'шесть', recallLimit: null, minScore: undefined },
    });
    const provider = new MemoryProviderLite(facade);
    const settings = provider.settings();
    expect(settings.factsLimit).toBe(6);
    expect(settings.recallLimit).toBe(5);
    expect(settings.minScore).toBe(0.34);
  });

  it('настройки М2 (чанкер, корпус, эмбеддинги) нормализуются', () => {
    const { facade } = createTestFacade({
      settings: {
        chunkChars: 10,
        chunkOverlap: 9999,
        maxFileBytes: 1,
        exclude: 'docs/**',
        embeddingModel: '  text-embed-3  ',
      },
    });
    const provider = new MemoryProviderLite(facade);
    const settings = provider.settings();
    expect(settings.chunkChars).toBe(100);
    // Перекрытие не может быть больше чанка.
    expect(settings.chunkOverlap).toBeLessThan(settings.chunkChars);
    expect(settings.maxFileBytes).toBe(1024);
    expect(settings.exclude).toEqual(['docs/**']);
    expect(settings.embeddingModel).toBe('text-embed-3');
  });
});

describe('память: сервис недоступен', () => {  it('тулы отвечают понятной ошибкой, активация не падает', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const provider = new MemoryProviderLite(facade);
    const write = createMemoryWriteTool(provider);

    const result = await write.execute({ text: FACT_TEXT }, toolCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });
});
