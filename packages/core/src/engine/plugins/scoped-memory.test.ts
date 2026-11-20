/**
 * ADR-090 / PROP-047 §2.1: scoped-доступ плагина к портам памяти.
 *
 * Проверяется главное свойство обёртки (`engine/plugins/scoped-memory.ts`):
 * **плагин видит только свою память**. Изоляция — в обе стороны:
 * - запись, сохранённая плагином A, недоступна плагину B (ни по `id`, ни в
 *   списке, ни по счётчику);
 * - запись плагина B не может быть прочитана/удалена/заменена плагином A.
 *
 * Нарушение namespace **не выражается исключением** — наружу уходит только
 * «не найдено» (`null`/`false`/`0`/пустой список), иначе по коду ответа можно
 * было бы отличить «чужой id» от «несуществующий» и перебором id выяснить
 * содержимое чужой памяти.
 */
import { describe, expect, it } from 'vitest';

import { pluginsConfigSchema, type PackManifest } from '@itphx/synth-shared';

import { MemoryFactRepository as MemoryFactRepositoryImpl } from '../../storage/memory/facts.js';
import { MemoryIndexRepository as MemoryIndexRepositoryImpl } from '../../storage/memory/indexes.js';
import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import type {
  MemoryChunkRecord,
  MemoryFactRecord,
  MemoryIndexRecord,
} from '../../storage/ports/index.js';
import { PluginHost } from './plugin-host.js';
import {
  createScopedMemory,
  PLUGIN_MEMORY_NAMESPACE_PREFIX,
  pluginMemoryNamespace,
} from './scoped-memory.js';

/** Порты инстанса (общие для всех плагинов — как в реальной сборке). */
function makePorts(): {
  facts: MemoryFactRepositoryImpl;
  indexes: MemoryIndexRepositoryImpl;
} {
  return {
    facts: new MemoryFactRepositoryImpl(),
    indexes: new MemoryIndexRepositoryImpl(),
  };
}

/** Запись факта для теста. */
function makeFact(over: Partial<MemoryFactRecord> = {}): MemoryFactRecord {
  return {
    id: 'fact-1',
    namespace: 'plugin:other',
    version: 1,
    text: 'деплой идёт через Fleet',
    kind: 'decision',
    provenance: {
      sourceKind: 'session',
      sourceId: 's-42',
      capturedAt: '2026-10-24T10:00:00.000Z',
    },
    confidence: 0.9,
    status: 'active',
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...over,
  };
}

/** Запись индекса для теста. */
function makeIndex(over: Partial<MemoryIndexRecord> = {}): MemoryIndexRecord {
  return {
    id: 'index-1',
    namespace: 'plugin:other',
    name: 'корпус',
    providerId: 'plugin:other',
    scope: 'project',
    source: { kind: 'project' },
    state: 'building',
    generation: 1,
    fingerprint: {
      model: 'text-embed',
      dimension: 3,
      chunkerVersion: '1',
    },
    stats: { documents: 1, chunks: 0, updatedAt: '2026-10-24T10:00:00.000Z' },
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...over,
  };
}

/** Чанк индекса для теста. */
function makeChunk(over: Partial<MemoryChunkRecord> = {}): MemoryChunkRecord {
  return {
    indexId: 'index-1',
    generation: 1,
    id: 'chunk-1',
    documentId: 'doc-1',
    ordinal: 0,
    text: 'фрагмент корпуса',
    ...over,
  };
}

describe('scoped-доступ плагина к памяти (PROP-047 §2.1)', () => {
  it('namespace плагина — plugin:<имя плагина>', () => {
    expect(PLUGIN_MEMORY_NAMESPACE_PREFIX).toBe('plugin:');
    expect(pluginMemoryNamespace('my-plugin')).toBe('plugin:my-plugin');
  });

  it('save штампует namespace своим: входное значение игнорируется', async () => {
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports);

    await memory.facts.save(makeFact({ namespace: 'plugin:plugin-b' }));

    const stored = await ports.facts.get('fact-1');
    expect(stored?.namespace).toBe('plugin:plugin-a');
  });

  it('saveIndex штампует namespace своим', async () => {
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports);

    await memory.indexes.saveIndex(makeIndex({ namespace: 'plugin:plugin-b' }));

    const stored = await ports.indexes.getIndex('index-1');
    expect(stored?.namespace).toBe('plugin:plugin-a');
  });

  it('изоляция в обе стороны: факт плагина A не виден плагину B', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.facts.save(makeFact({ id: 'fact-a' }));

    // Чтение по чужому id — «не найдено» (не 403 и не «существует, но чужой»).
    expect(await b.facts.get('fact-a')).toBeNull();
    // Список и счётчик — только своя память.
    expect(await b.facts.list()).toHaveLength(0);
    expect(await b.facts.count()).toBe(0);
    // Свой факт виден.
    expect(await a.facts.get('fact-a')).not.toBeNull();
    expect(await a.facts.count()).toBe(1);
  });

  it('namespace в запросе игнорируется: чужое не прочитать списком', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.facts.save(makeFact({ id: 'fact-a' }));
    await b.facts.save(makeFact({ id: 'fact-b' }));

    // Плагин B просит чужой namespace — получает только свои записи.
    const listed = await b.facts.list({ namespace: 'plugin:plugin-a' });
    expect(listed.map((fact) => fact.id)).toEqual(['fact-b']);
    expect(await b.facts.count({ namespace: 'plugin:plugin-a' })).toBe(1);
  });

  it('delete/supersede чужого факта — «не найдено» (false)', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.facts.save(makeFact({ id: 'fact-a' }));

    expect(await b.facts.delete('fact-a')).toBe(false);
    expect(await b.facts.supersede('fact-a', 'fact-a-2')).toBe(false);
    // Запись плагина A не тронута.
    expect(await a.facts.get('fact-a')).not.toBeNull();

    // Свою запись плагин удаляет/заменяет. Новая версия должна быть уже
    // записана: `supersede` проверяет оба id.
    await b.facts.save(makeFact({ id: 'fact-b' }));
    await b.facts.save(makeFact({ id: 'fact-b-2' }));
    expect(await b.facts.supersede('fact-b', 'fact-b-2')).toBe(true);
    expect(await b.facts.delete('fact-b')).toBe(true);
  });

  it('изоляция индексов: чужой индекс не виден и не удаляется', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.indexes.saveIndex(makeIndex({ id: 'index-a' }));

    expect(await b.indexes.getIndex('index-a')).toBeNull();
    expect(await b.indexes.listIndexes()).toHaveLength(0);
    expect(await b.indexes.deleteIndex('index-a')).toBe(false);
    expect(await b.indexes.setState('index-a', 'ready')).toBe(false);
    // Запись плагина A не тронута.
    expect(await a.indexes.getIndex('index-a')).not.toBeNull();

    // Свой индекс плагин меняет.
    await b.indexes.saveIndex(makeIndex({ id: 'index-b' }));
    expect(await b.indexes.setState('index-b', 'ready')).toBe(true);
    expect(await b.indexes.deleteIndex('index-b')).toBe(true);
  });

  it('namespace в запросе индексов игнорируется', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.indexes.saveIndex(makeIndex({ id: 'index-a' }));
    await b.indexes.saveIndex(makeIndex({ id: 'index-b' }));

    const listed = await b.indexes.listIndexes({ namespace: 'plugin:plugin-a' });
    expect(listed.map((index) => index.id)).toEqual(['index-b']);
  });

  it('чанки чужого индекса недоступны: пустой результат вместо исключения', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.indexes.saveIndex(makeIndex({ id: 'index-a' }));
    await a.indexes.replaceChunks('index-a', 1, [makeChunk({ indexId: 'index-a' })]);

    // Чужой индекс: чтение пустое, счётчик нулевой, запись/удаление — нет.
    expect(await b.indexes.listChunks('index-a')).toEqual([]);
    expect(await b.indexes.countChunks('index-a')).toBe(0);
    expect(await b.indexes.replaceChunks('index-a', 1, [makeChunk()])).toBe(0);
    expect(await b.indexes.deleteChunks('index-a')).toBe(0);
    // Чанки плагина A не тронуты.
    expect(await a.indexes.countChunks('index-a')).toBe(1);
  });

  it('свои чанки плагин читает и заменяет', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);

    await a.indexes.saveIndex(makeIndex({ id: 'index-a' }));
    const written = await a.indexes.replaceChunks('index-a', 1, [makeChunk({ indexId: 'index-a' })]);
    expect(written).toBe(1);
    expect(await a.indexes.countChunks('index-a')).toBe(1);
    const chunks = await a.indexes.listChunks('index-a');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('фрагмент корпуса');
    expect(await a.indexes.deleteChunks('index-a')).toBe(1);
    expect(await a.indexes.countChunks('index-a')).toBe(0);
  });

  it('supersede: чужой id новой версии — «не найдено», старый факт не тронут', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);
    const b = createScopedMemory('plugin-b', ports);

    await a.facts.save(makeFact({ id: 'a1' }));
    await a.facts.save(makeFact({ id: 'a2' }));
    await b.facts.save(makeFact({ id: 'b1' }));

    // Новая версия — чужой факт: отказ, старый факт не меняется.
    expect(await a.facts.supersede('a1', 'b1')).toBe(false);
    const untouched = await a.facts.get('a1');
    expect(untouched?.supersededBy).toBeUndefined();
    expect(untouched?.status).toBe('active');
    // Запись плагина B не тронута.
    expect((await b.facts.get('b1'))?.supersededBy).toBeUndefined();

    // Оба id свои — замена проходит.
    expect(await a.facts.supersede('a1', 'a2')).toBe(true);
    const replaced = await a.facts.get('a1');
    expect(replaced?.supersededBy).toBe('a2');
    expect(replaced?.status).toBe('superseded');
  });

  it('несуществующий id — «не найдено» (без исключений наружу)', async () => {
    const ports = makePorts();
    const a = createScopedMemory('plugin-a', ports);

    expect(await a.facts.get('нет-такого')).toBeNull();
    expect(await a.facts.delete('нет-такого')).toBe(false);
    expect(await a.facts.supersede('нет-такого', 'x')).toBe(false);
    expect(await a.indexes.getIndex('нет-такого')).toBeNull();
    expect(await a.indexes.deleteIndex('нет-такого')).toBe(false);
    expect(await a.indexes.setState('нет-такого', 'ready')).toBe(false);
    expect(await a.indexes.listChunks('нет-такого')).toEqual([]);
    expect(await a.indexes.countChunks('нет-такого')).toBe(0);
  });
});

/** Манифест плагина для проверки хоста (совместим с тестовым хостом). */
function makeManifest(name: string): PackManifest {
  return {
    name,
    version: '1.0.0',
    kind: 'plugin',
    description: `плагин ${name}`,
    host: '^0.11.0',
    contracts: { extensionApi: '^1' },
    mode: 'inline',
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [],
      llmFilters: [],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  } as PackManifest;
}

describe('хост плагинов: сервис памяти в фасаде', () => {
  it('фасад отдаёт scoped-сервис: запись плагина остаётся в его namespace', async () => {
    const ports = makePorts();
    const host = new PluginHost({
      audit: new MemoryPluginAuditRepository(),
      config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
      hostVersion: '0.11.0',
      logger: { warn: () => undefined },
      memory: { facts: ports.facts, indexes: ports.indexes },
      loader: async () => ({
        apply: async (facade) => {
          expect(facade.memory).toBeDefined();
          await facade.memory?.facts.save(makeFact({ id: 'host-fact' }));
        },
      }),
    });

    const result = await host.activate({
      name: 'host-plugin',
      version: '1.0.0',
      manifest: makeManifest('host-plugin'),
      trustLevel: 'trusted',
      installKind: 'deploy',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    expect(result.outcome).toBe('activated');
    const stored = await ports.facts.get('host-fact');
    expect(stored?.namespace).toBe('plugin:host-plugin');
  });

  it('без портов памяти сервис не задан, активация не падает', async () => {
    const host = new PluginHost({
      audit: new MemoryPluginAuditRepository(),
      config: { ...pluginsConfigSchema.parse({}), executionEnabled: true, trustFloor: 'community' },
      hostVersion: '0.11.0',
      logger: { warn: () => undefined },
      loader: async () => ({
        apply: (facade) => {
          // Сервис не сконфигурирован — плагин это учитывает (ошибки нет).
          expect(facade.memory).toBeUndefined();
        },
      }),
    });

    const result = await host.activate({
      name: 'no-memory-plugin',
      version: '1.0.0',
      manifest: makeManifest('no-memory-plugin'),
      trustLevel: 'trusted',
      installKind: 'deploy',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    expect(result.outcome).toBe('activated');
  });
});

/**
 * Событие шины `memory.updated` на chokepoint'е записи в память.
 *
 * Обёртка (`engine/plugins/scoped-memory.ts`) — **единственный путь плагина в
 * порты памяти**, поэтому публикация посажена здесь: через неё ходят тулы
 * `memory_write`/`memory_forget`/`memory_consolidate`/`memory_index` (то есть и
 * агент в чате), и мутации портала, которые исполняет тул плагина. Иначе факт,
 * записанный агентом, не доходил бы до раздела «Память» второго клиента.
 *
 * Контракт: событие — только после **успешной** записи (`false`/чужой namespace
 * молчат), payload — `{ scope, action, id }` без содержимого памяти (ни текста
 * факта, ни эмбеддингов — docs/MEMORY.md §10, инвариант 13 `AGENTS.md`).
 */
describe('событие memory.updated на записи плагина в память (инвариант 27)', () => {
  /** Записанное событие шины. */
  interface Published {
    channel: string;
    type: string;
    data: Record<string, unknown>;
  }

  /** Фейковая шина: инстансные события складываются в массив. */
  function makeBus(published: Published[]) {
    return {
      publishInstance: (type: string, data: Record<string, unknown> = {}) => {
        published.push({ channel: 'instance', type, data });
      },
    };
  }

  it('facts.save публикует: create для первой версии, update для следующей', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));

    await memory.facts.save(makeFact({ id: 'fact-1', version: 1 }));
    await memory.facts.save(makeFact({ id: 'fact-1', version: 2, text: 'исправлено' }));

    expect(published.map((event) => [event.channel, event.type, event.data])).toEqual([
      ['instance', 'memory.updated', { scope: 'facts', action: 'create', id: 'fact-1' }],
      ['instance', 'memory.updated', { scope: 'facts', action: 'update', id: 'fact-1' }],
    ]);
  });

  it('facts.save: в payload нет текста факта и эмбеддингов', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));

    await memory.facts.save(
      makeFact({
        id: 'fact-secret',
        text: 'деплой идёт через Fleet',
        embedding: [0.11, -0.22, 0.33],
      } as Partial<MemoryFactRecord>),
    );

    expect(published).toHaveLength(1);
    expect(Object.keys(published[0]!.data).sort()).toEqual(['action', 'id', 'scope']);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('деплой идёт через Fleet');
    expect(serialized).not.toContain('0.11');
  });

  it('facts.delete публикует только при успехе (чужой namespace/нет записи — тишина)', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const other = createScopedMemory('plugin-b', ports);
    await other.facts.save(makeFact({ id: 'foreign-fact' }));
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));

    // Чужой факт: обёртка отвечает «не найдено» — события нет.
    expect(await memory.facts.delete('foreign-fact')).toBe(false);
    expect(published).toEqual([]);

    // Свой факт: запись удалена — событие есть.
    await memory.facts.save(makeFact({ id: 'own-fact' }));
    published.length = 0;
    expect(await memory.facts.delete('own-fact')).toBe(true);
    expect(published.map((event) => event.data)).toEqual([
      { scope: 'facts', action: 'delete', id: 'own-fact' },
    ]);
  });

  it('facts.supersede публикует update только при успешной замене', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const other = createScopedMemory('plugin-b', ports);
    await other.facts.save(makeFact({ id: 'foreign-fact' }));
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));
    await memory.facts.save(makeFact({ id: 'v1', version: 1 }));
    await memory.facts.save(makeFact({ id: 'v2', version: 1 }));
    published.length = 0;

    // Заменяемый факт чужой — отказ, события нет.
    expect(await memory.facts.supersede('foreign-fact', 'v2')).toBe(false);
    expect(published).toEqual([]);

    expect(await memory.facts.supersede('v1', 'v2')).toBe(true);
    expect(published.map((event) => event.data)).toEqual([
      { scope: 'facts', action: 'update', id: 'v1' },
    ]);
  });

  it('indexes.saveIndex публикует create, затем update; содержимое корпуса не уходит', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));

    await memory.indexes.saveIndex(makeIndex({ id: 'index-1', name: 'корпус проекта demo' }));
    await memory.indexes.saveIndex(makeIndex({ id: 'index-1', name: 'корпус проекта demo' }));

    expect(published.map((event) => event.data)).toEqual([
      { scope: 'indexes', action: 'create', id: 'index-1' },
      { scope: 'indexes', action: 'update', id: 'index-1' },
    ]);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('корпус проекта demo');
    expect(serialized).not.toContain('text-embed');
  });

  it('indexes.deleteIndex и setState публикуют только при успехе', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const other = createScopedMemory('plugin-b', ports);
    await other.indexes.saveIndex(makeIndex({ id: 'foreign-index' }));
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));
    await memory.indexes.saveIndex(makeIndex({ id: 'index-1' }));
    published.length = 0;

    // Чужой индекс: «не найдено» — тишина.
    expect(await memory.indexes.setState('foreign-index', 'ready')).toBe(false);
    expect(await memory.indexes.deleteIndex('foreign-index')).toBe(false);
    expect(published).toEqual([]);

    expect(await memory.indexes.setState('index-1', 'ready')).toBe(true);
    expect(await memory.indexes.deleteIndex('index-1')).toBe(true);
    expect(published.map((event) => event.data)).toEqual([
      { scope: 'indexes', action: 'update', id: 'index-1' },
      { scope: 'indexes', action: 'delete', id: 'index-1' },
    ]);
  });

  it('чтение портов событий не публикует', async () => {
    const published: Published[] = [];
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports, makeBus(published));
    await memory.facts.save(makeFact({ id: 'fact-1' }));
    await memory.indexes.saveIndex(makeIndex({ id: 'index-1' }));
    published.length = 0;

    await memory.facts.get('fact-1');
    await memory.facts.list();
    await memory.facts.count();
    await memory.indexes.getIndex('index-1');
    await memory.indexes.listIndexes();
    await memory.indexes.listChunks('index-1');

    expect(published).toEqual([]);
  });

  it('без шины — публикации нет, мутации работают как раньше', async () => {
    const ports = makePorts();
    const memory = createScopedMemory('plugin-a', ports);

    await expect(memory.facts.save(makeFact({ id: 'fact-1' }))).resolves.toBeUndefined();
    expect(await memory.facts.delete('fact-1')).toBe(true);
    await expect(memory.indexes.saveIndex(makeIndex({ id: 'index-1' }))).resolves.toBeUndefined();
    expect(await memory.indexes.deleteIndex('index-1')).toBe(true);

    // `null` — тот же no-op (шина не задана точкой сборки).
    const nullBus = createScopedMemory('plugin-a', ports, null);
    await expect(nullBus.facts.save(makeFact({ id: 'fact-2' }))).resolves.toBeUndefined();
  });
});
