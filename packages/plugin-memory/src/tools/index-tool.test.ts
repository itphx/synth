/**
 * М2: тесты тула `memory_index` (управление индексами памяти).
 *
 * Проверяются: создание/сборка/пересборка/удаление/статус, скоуп по проекту
 * (индексы чужих проектов не видны) и понятная ошибка, когда сервис памяти
 * недоступен.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IndexBusyError } from '../errors.js';
import { MemoryProviderLite } from '../provider.js';
import { createTestFacade, createTestStorage } from '../test-support.js';
import { createMemoryIndexTool, MEMORY_INDEX_TOOL_NAME } from './index-tool.js';

const tempDirs: string[] = [];

/** Временный каталог корпуса. */
async function makeCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-index-tool-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'readme.md'), '# Readme\n\nДеплой идёт через Fleet.\n', 'utf-8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Контекст тула (суженный контекст плагина, ADR-107). */
function ctx(
  projectId?: string,
  workingDir = '/ws',
  sessionId = 's1',
  abortSignal?: AbortSignal,
) {
  return {
    sessionId,
    messageId: 'm1',
    workingDir,
    ...(projectId ? { projectId } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  };
}

/** Контекст служебного вызова портала памяти. */
function portalCtx(projectId?: string, workingDir = '/ws') {
  return ctx(projectId, workingDir, 'system:memory-portal:test');
}

describe('тул memory_index', () => {
  it('имя тула и capability — как в манифесте', () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));
    expect(tool.name).toBe(MEMORY_INDEX_TOOL_NAME);
    expect(tool.capabilities).toEqual(['memory']);
  });

  it('create → индекс создан, сборка идёт в фоне и завершается успехом', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', name: 'project', source: { kind: 'files' } },
      ctx('p1', dir),
    );
    expect(created.isError).toBeUndefined();
    const indexId = String(created.metadata?.indexId);
    expect(indexId).toMatch(/^idx_/);
    expect(created.metadata?.state).toBe('building');

    await provider.indexManager.whenIdle();

    const status = await tool.execute({ action: 'status' }, ctx('p1', dir));
    expect(status.content).toContain(indexId);
    expect(status.content).toContain('ready');
    const indexes = status.metadata?.indexes as Array<Record<string, unknown>>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.state).toBe('ready');
    expect(indexes[0]!.generation).toBe(1);
  });

  it('rebuild → новое поколение, delete → индекс удалён', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create' }, ctx('p1', dir));
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const rebuilt = await tool.execute({ action: 'rebuild', indexId }, ctx('p1', dir));
    expect(rebuilt.isError).toBeUndefined();
    expect(rebuilt.metadata?.state).toBe('building');
    expect(rebuilt.metadata?.generation).toBe(2);
    await provider.indexManager.whenIdle();

    const status = await tool.execute({ action: 'status' }, ctx('p1', dir));
    const indexes = status.metadata?.indexes as Array<Record<string, unknown>>;
    expect(indexes[0]!.generation).toBe(2);

    const deleted = await tool.execute({ action: 'delete', indexId }, ctx('p1', dir));
    expect(deleted.isError).toBeUndefined();
    expect(deleted.metadata?.deleted).toBe(true);
    expect(await storage.memoryIndexes.getIndex(indexId)).toBeNull();

    const empty = await tool.execute({ action: 'status' }, ctx('p1', dir));
    expect(empty.content).toContain('Индексов памяти пока нет');
  });

  it('build/rebuild по имени индекса (без id)', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const rebuilt = await tool.execute({ action: 'build', name: 'docs' }, ctx('p1', dir));
    expect(rebuilt.isError).toBeUndefined();
    expect(rebuilt.metadata?.generation).toBe(2);
  });

  it('скоуп по проекту: индексы чужого проекта не видны и не удаляются', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create' }, ctx('p1', dir));
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const foreign = await tool.execute({ action: 'status' }, ctx('p2', dir));
    expect(foreign.content).toContain('Индексов памяти пока нет');

    const foreignDelete = await tool.execute({ action: 'delete', indexId }, ctx('p2', dir));
    expect(foreignDelete.isError).toBe(true);
    // Индекс чужого проекта на месте.
    expect(await storage.memoryIndexes.getIndex(indexId)).not.toBeNull();
  });

  it('неизвестный индекс → понятная ошибка', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'rebuild', indexId: 'idx_missing' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Индекс не найден');
  });

  it('некорректные аргументы → понятная ошибка', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'unknown' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('хранилище памяти недоступно → понятная ошибка (тул зарегистрирован)', async () => {
    const { facade } = createTestFacade({ withMemory: false });
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute({ action: 'status' }, ctx('p1'));
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });
});

describe('тул memory_index: инстансный индекс (scope: instance)', () => {
  it('создание инстансного индекса без сессии портала → отказ', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      ctx('p1', dir),
    );
    expect(created.isError).toBe(true);
    expect(created.content).toBe('Инстансный индекс управляется через портал (ADMIN)');
    // Индекс не создан.
    expect(await storage.memoryIndexes.listIndexes()).toHaveLength(0);
  });

  it('создание инстансного индекса из портала → индекс создан', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    expect(created.isError).toBeUndefined();
    const indexId = String(created.metadata?.indexId);
    expect(indexId).toMatch(/^idx_/);
    expect(created.metadata?.scope).toBe('instance');

    await provider.indexManager.whenIdle();
    const status = await provider.getIndex(indexId);
    expect(status!.index.scope).toBe('instance');
    expect(status!.index.projectId).toBe('p1');
  });

  it('инстансный индекс по фактам: projectId не передаётся (владельца нет)', async () => {
    const storage = createTestStorage();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'facts' } },
      portalCtx('p1'),
    );
    expect(created.isError).toBeUndefined();

    await provider.indexManager.whenIdle();
    const status = await provider.getIndex(String(created.metadata?.indexId));
    expect(status!.index.scope).toBe('instance');
    expect(status!.index.projectId).toBeUndefined();
  });

  it('пересборка инстансного индекса без сессии портала → отказ', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const rebuilt = await tool.execute({ action: 'rebuild', indexId }, ctx('p1', dir));
    expect(rebuilt.isError).toBe(true);
    expect(rebuilt.content).toBe('Инстансный индекс управляется через портал (ADMIN)');
    // Поколение прежнее — пересборки не было.
    const status = await provider.getIndex(indexId);
    expect(status!.index.generation).toBe(1);
  });

  it('удаление инстансного индекса без сессии портала → отказ', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    const indexId = String(created.metadata?.indexId);
    await provider.indexManager.whenIdle();

    const removed = await tool.execute({ action: 'delete', indexId }, ctx('p1', dir));
    expect(removed.isError).toBe(true);
    expect(removed.content).toBe('Инстансный индекс управляется через портал (ADMIN)');
    expect(await storage.memoryIndexes.getIndex(indexId)).not.toBeNull();
  });

  it('статус: инстансный индекс виден и помечен областью видимости', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    await provider.indexManager.whenIdle();

    // Статус из сессии другого проекта — инстансный индекс виден.
    const status = await tool.execute({ action: 'status' }, ctx('p2', dir));
    expect(status.content).toContain('[instance]');
    const indexes = status.metadata?.indexes as Array<Record<string, unknown>>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.scope).toBe('instance');
  });
});

describe('тул memory_index: массовая пересборка (rebuild_all)', () => {
  it('запускает только проектные индексы, инстансный не трогает', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const docs = await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    const code = await tool.execute({ action: 'create', name: 'code' }, ctx('p1', dir));
    const shared = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    await provider.indexManager.whenIdle();

    const docsId = String(docs.metadata?.indexId);
    const codeId = String(code.metadata?.indexId);
    const sharedId = String(shared.metadata?.indexId);

    const result = await tool.execute({ action: 'rebuild_all' }, ctx('p1', dir));
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.action).toBe('rebuild_all');

    const started = result.metadata?.started as string[];
    const skipped = result.metadata?.skipped as string[];
    expect(started).toHaveLength(2);
    expect(started).toEqual(expect.arrayContaining([docsId, codeId]));
    expect(started).not.toContain(sharedId);
    expect(skipped).toEqual([]);
    expect(result.content).toContain('запущено 2');

    await provider.indexManager.whenIdle();
    expect((await provider.getIndex(docsId))!.index.generation).toBe(2);
    expect((await provider.getIndex(codeId))!.index.generation).toBe(2);
    // Инстансный корпус — ресурс портала: поколение прежнее.
    expect((await provider.getIndex(sharedId))!.index.generation).toBe(1);
  });

  it('индекс в состоянии building пропускается', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const docs = await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    const code = await tool.execute({ action: 'create', name: 'code' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const docsId = String(docs.metadata?.indexId);
    const codeId = String(code.metadata?.indexId);

    // Имитация идущей сборки: запись порта в состоянии building.
    const record = await storage.memoryIndexes.getIndex(codeId);
    await storage.memoryIndexes.saveIndex({ ...record!, state: 'building' });

    const result = await tool.execute({ action: 'rebuild_all' }, ctx('p1', dir));
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.started).toEqual([docsId]);
    expect(result.metadata?.skipped).toEqual([codeId]);
    expect(result.content).toContain('пропущено 1');

    await provider.indexManager.whenIdle();
    // Пересборки пропущенного индекса не было.
    expect((await provider.getIndex(codeId))!.index.generation).toBe(1);
  });

  it('IndexBusyError по одному индексу не валит весь вызов', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const docs = await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    const code = await tool.execute({ action: 'create', name: 'code' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const docsId = String(docs.metadata?.indexId);
    const busyId = String(code.metadata?.indexId);
    const rebuild = provider.rebuildIndex.bind(provider);
    Object.assign(provider, {
      rebuildIndex: async (id: string, opts?: { force?: boolean; workingDir?: string }) => {
        if (id === busyId) throw new IndexBusyError();
        return rebuild(id, opts);
      },
    });

    const result = await tool.execute({ action: 'rebuild_all' }, ctx('p1', dir));
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.started).toEqual([docsId]);
    expect(result.metadata?.skipped).toEqual([busyId]);
    await provider.indexManager.whenIdle();
  });

  it('wait:true дожидается ready/failed и отдаёт их в metadata', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await tool.execute({ action: 'create', name: 'code' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const statuses = await provider.listIndexes({ projectId: 'p1' });
    const docs = statuses.find((status) => status.index.name === 'docs')!;
    const code = statuses.find((status) => status.index.name === 'code')!;
    const docsId = docs.index.id;
    const codeId = code.index.id;

    // Фейковое завершение: первый опрос — building, второй — ready/failed.
    const polls = new Map<string, number>();
    Object.assign(provider, {
      rebuildIndex: async (id: string) => {
        const base = id === docsId ? docs : code;
        return { index: { ...base.index, state: 'building' }, state: 'building', stale: false };
      },
      getIndex: async (id: string) => {
        const base = id === docsId ? docs : code;
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        if (count < 2) {
          return { index: { ...base.index, state: 'building' }, state: 'building', stale: false };
        }
        const state = id === docsId ? ('ready' as const) : ('failed' as const);
        return { index: { ...base.index, state }, state, stale: false };
      },
    });

    const result = await tool.execute(
      { action: 'rebuild_all', wait: true, timeoutMs: 5000 },
      ctx('p1', dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.started).toHaveLength(2);
    expect(result.metadata?.started).toEqual(expect.arrayContaining([docsId, codeId]));
    expect(result.metadata?.ready).toEqual([docsId]);
    expect(result.metadata?.failed).toEqual([codeId]);
    expect(result.metadata?.timedOut).toEqual([]);
    expect(result.content).toContain('ready');
    expect(result.content).toContain('failed');
  });

  it('wait:true по таймауту возвращает timedOut и не зависает', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();
    const indexId = String(created.metadata?.indexId);
    const status = (await provider.getIndex(indexId))!;

    // Сборка «никогда» не завершается — проверяем бюджет ожидания.
    Object.assign(provider, {
      rebuildIndex: async () => ({
        index: { ...status.index, state: 'building' },
        state: 'building',
        stale: false,
      }),
      getIndex: async () => ({
        index: { ...status.index, state: 'building' },
        state: 'building',
        stale: false,
      }),
    });

    const startedAt = Date.now();
    const result = await tool.execute(
      { action: 'rebuild_all', wait: true, timeoutMs: 1000 },
      ctx('p1', dir),
    );
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.timedOut).toEqual([indexId]);
    expect(result.metadata?.ready).toEqual([]);
    expect(result.content).toContain('timedOut');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it('abortSignal прерывает ожидание', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const created = await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();
    const indexId = String(created.metadata?.indexId);
    const status = (await provider.getIndex(indexId))!;

    Object.assign(provider, {
      rebuildIndex: async () => ({
        index: { ...status.index, state: 'building' },
        state: 'building',
        stale: false,
      }),
      getIndex: async () => ({
        index: { ...status.index, state: 'building' },
        state: 'building',
        stale: false,
      }),
    });

    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    const result = await tool.execute(
      { action: 'rebuild_all', wait: true, timeoutMs: 600_000 },
      ctx('p1', dir, 's1', controller.signal),
    );
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.timedOut).toEqual([indexId]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('нет проектных индексов → информативный текст, инстансный не трогается', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    const shared = await tool.execute(
      { action: 'create', scope: 'instance', source: { kind: 'files' } },
      portalCtx('p1', dir),
    );
    await provider.indexManager.whenIdle();
    const sharedId = String(shared.metadata?.indexId);

    const result = await tool.execute({ action: 'rebuild_all' }, ctx('p1', dir));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('пересобирать нечего');
    expect(result.metadata?.started).toEqual([]);
    expect(result.metadata?.skipped).toEqual([]);
    expect((await provider.getIndex(sharedId))!.index.generation).toBe(1);
  });

  it('timeoutMs вне диапазона → ошибка аргументов', async () => {
    const { facade } = createTestFacade();
    const tool = createMemoryIndexTool(new MemoryProviderLite(facade));

    const result = await tool.execute(
      { action: 'rebuild_all', wait: true, timeoutMs: 100 },
      ctx('p1'),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Некорректные аргументы');
  });

  it('force передаётся в rebuildIndex', async () => {
    const storage = createTestStorage();
    const dir = await makeCorpus();
    const { facade } = createTestFacade({ storage });
    const provider = new MemoryProviderLite(facade);
    const tool = createMemoryIndexTool(provider);

    await tool.execute({ action: 'create', name: 'docs' }, ctx('p1', dir));
    await provider.indexManager.whenIdle();

    const calls: Array<{ id: string; options?: { force?: boolean; workingDir?: string } }> = [];
    Object.assign(provider, {
      rebuildIndex: async (id: string, options?: { force?: boolean; workingDir?: string }) => {
        calls.push({ id, options });
        return (await provider.getIndex(id))!;
      },
    });

    const result = await tool.execute({ action: 'rebuild_all', force: true }, ctx('p1', dir));
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.force).toBe(true);
    expect(calls[0]!.options?.workingDir).toBe(dir);
  });
});
