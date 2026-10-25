/**
 * Телеметрия recall/search-запросов памяти (ADR-107).
 *
 * Плагин **только сообщает** хосту: вид запроса, исход, число найденных
 * фрагментов и длительность. Проверяется:
 * - блок recall: `kind: 'recall'`, исход `hit`/`empty`, хиты = число строк
 *   выдачи, длительность неотрицательна;
 * - тул `memory_search`: `kind: 'search'`, исход `hit`/`empty`/`error`, тул
 *   по-прежнему отвечает `isError` при недоступной памяти;
 * - сбой телеметрии не ломает ни блок, ни тул.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecallBlock } from './blocks/recall-block.js';
import { MemoryProviderLite } from './provider.js';
import { createMemorySearchTool } from './tools/search.js';
import { blockCtx, createTestFacade, createTestStorage, toolCtx } from './test-support.js';
import type { MemoryTelemetryInput } from './telemetry.js';

const tempDirs: string[] = [];

/**
 * Корпус из двух фрагментов (два markdown-блока → два чанка).
 *
 * Заголовок идёт **без** пустой строки после себя — иначе чанкер режет его
 * отдельным блоком и корпус даёт четыре чанка вместо двух.
 */
const CORPUS =
  '# Проект\nДеплой проекта идёт через Fleet.\n\n## Инстанс\nДеплой инстанса идёт через Fleet.\n';

/** Каталог корпуса с одним файлом `deploy.md`. */
async function makeCorpus(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-telemetry-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'deploy.md'), text, 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Провайдер, тул и блок над настоящим in-memory хранилищем + телеметрия. */
function makeMemory(options: { withMemory?: boolean } = {}) {
  const storage = createTestStorage();
  const events: MemoryTelemetryInput[] = [];
  const { facade } = createTestFacade({
    storage,
    ...(options.withMemory === false ? { withMemory: false } : {}),
    memoryTelemetry: (input) => {
      events.push(input);
    },
  });
  const provider = new MemoryProviderLite(facade);
  return {
    events,
    provider,
    block: createRecallBlock(provider),
    search: createMemorySearchTool(provider),
  };
}

/** Провайдер с индексом по корпусу из двух фрагментов. */
async function makeIndexed(): Promise<Awaited<ReturnType<typeof makeMemory>>> {
  const memory = makeMemory();
  const dir = await makeCorpus(CORPUS);
  await memory.provider.createIndex({
    source: { kind: 'files' },
    projectId: 'p1',
    workingDir: dir,
  });
  await memory.provider.indexManager.whenIdle();
  return memory;
}

describe('телеметрия памяти: блок recall', () => {
  it('индекс с двумя фрагментами → kind=recall, outcome=hit, hits = число строк', async () => {
    const { block, events } = await makeIndexed();

    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));
    expect(content).toContain('Деплой проекта идёт через Fleet.');
    expect(content).toContain('Деплой инстанса идёт через Fleet.');

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe('recall');
    expect(event?.outcome).toBe('hit');
    // Два фрагмента корпуса → две строки выдачи (заголовки не считаются).
    const lines = content.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(event?.hits).toBe(lines.length);
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('пустая память (нет индекса и фактов) → outcome=empty, hits=0', async () => {
    const { block, events } = makeMemory();

    const content = await block.load(blockCtx({ query: 'деплой' }));
    expect(content).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('recall');
    expect(events[0]?.outcome).toBe('empty');
    expect(events[0]?.hits).toBe(0);
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('сервис памяти недоступен → блок не грузится и телеметрии нет', async () => {
    const { block, events } = makeMemory({ withMemory: false });

    expect(await block.load(blockCtx({ query: 'деплой' }))).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('пустой индекс (нет чанков) и нет фактов → outcome=empty, hits=0', async () => {
    const { provider, block, events } = makeMemory();
    // Индекс без чанков: корпус пуст.
    const emptyDir = await makeCorpus('');
    await provider.createIndex({
      source: { kind: 'files' },
      projectId: 'p1',
      workingDir: emptyDir,
    });
    await provider.indexManager.whenIdle();

    const content = await block.load(blockCtx({ projectId: 'p1', query: 'деплой' }));
    expect(content).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('recall');
    expect(events[0]?.outcome).toBe('empty');
    expect(events[0]?.hits).toBe(0);
  });

  it('фасад без телеметрии — блок работает как обычно', async () => {
    const storage = createTestStorage();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const dir = await makeCorpus(CORPUS);
    await provider.createIndex({ source: { kind: 'files' }, projectId: 'p1', workingDir: dir });
    await provider.indexManager.whenIdle();

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));
    expect(content).toContain('Деплой проекта идёт через Fleet.');
  });

  it('сбой телеметрии не ломает блок', async () => {
    const storage = createTestStorage();
    const { facade } = createTestFacade({
      storage,
      memoryTelemetry: () => {
        throw new Error('телеметрия сломалась');
      },
    });
    const provider = new MemoryProviderLite(facade);
    const dir = await makeCorpus(CORPUS);
    await provider.createIndex({ source: { kind: 'files' }, projectId: 'p1', workingDir: dir });
    await provider.indexManager.whenIdle();

    const block = createRecallBlock(provider);
    const content = String(await block.load(blockCtx({ projectId: 'p1', query: 'деплой' })));
    expect(content).toContain('Деплой проекта идёт через Fleet.');
  });

  it('ошибка порта памяти → outcome=error, ошибка пробрасывается как раньше', async () => {
    const storage = createTestStorage();
    const events: MemoryTelemetryInput[] = [];
    const { facade } = createTestFacade({
      storage,
      memoryTelemetry: (input) => {
        events.push(input);
      },
    });
    vi.spyOn(facade.memory!.facts, 'list').mockRejectedValue(new Error('порт упал'));
    const provider = new MemoryProviderLite(facade);
    const block = createRecallBlock(provider);

    await expect(block.load(blockCtx({ query: 'деплой' }))).rejects.toThrow('порт упал');

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('recall');
    expect(events[0]?.outcome).toBe('error');
    expect(events[0]?.hits).toBe(0);
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('телеметрия памяти: тул memory_search', () => {
  it('найденные фрагменты → kind=search, outcome=hit, hits = число строк', async () => {
    const { search, events } = await makeIndexed();

    const found = await search.execute({ query: 'деплой', limit: 10 }, toolCtx('s1', 'p1'));
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain('Деплой проекта идёт через Fleet.');

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe('search');
    expect(event?.outcome).toBe('hit');
    // Хиты — число строк выдачи (фрагменты корпуса).
    const lines = found.content.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(event?.hits).toBe(lines.length);
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ничего не найдено → outcome=empty, hits=0', async () => {
    const { search, events } = makeMemory();

    const found = await search.execute({ query: 'деплой' }, toolCtx());
    expect(found.content).toBe('Ничего не найдено.');

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('search');
    expect(events[0]?.outcome).toBe('empty');
    expect(events[0]?.hits).toBe(0);
  });

  it('лимит режет выдачу — hits считается по оставшимся строкам', async () => {
    const { search, events } = await makeIndexed();

    const found = await search.execute({ query: 'деплой', limit: 1 }, toolCtx('s1', 'p1'));
    const lines = found.content.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(1);

    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('hit');
    expect(events[0]?.hits).toBe(1);
  });

  it('некорректные аргументы — поиск не выполнялся, телеметрии нет', async () => {
    const { search, events } = makeMemory();

    const found = await search.execute({ query: '' }, toolCtx());
    expect(found.isError).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('недоступная память → outcome=error, тул отвечает isError', async () => {
    const { search, events } = makeMemory({ withMemory: false });

    const found = await search.execute({ query: 'деплой' }, toolCtx());
    expect(found.isError).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('search');
    expect(events[0]?.outcome).toBe('error');
    expect(events[0]?.hits).toBe(0);
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('сбой телеметрии не ломает тул', async () => {
    const storage = createTestStorage();
    const { facade } = createTestFacade({
      storage,
      memoryTelemetry: () => {
        throw new Error('телеметрия сломалась');
      },
    });
    const provider = new MemoryProviderLite(facade);
    const write = createMemorySearchTool(provider);
    const dir = await makeCorpus(CORPUS);
    await provider.createIndex({ source: { kind: 'files' }, projectId: 'p1', workingDir: dir });
    await provider.indexManager.whenIdle();

    const found = await write.execute({ query: 'деплой', limit: 10 }, toolCtx('s1', 'p1'));
    expect(found.isError).toBeUndefined();
    expect(found.content).toContain('Деплой проекта идёт через Fleet.');
  });
});
