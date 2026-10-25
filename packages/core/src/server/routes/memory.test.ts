/**
 * ADR-107 / PROP-047 §2.1: портал памяти в ядре (`/api/v2/memory`).
 *
 * Проверяем контракт: форма ответов всех четырёх эндпоинтов, 404 на
 * несуществующий факт, 503 без портов, невозможность подменить `namespace`
 * query-параметром, валидацию `status`/`state`/`limit`/`offset`, счётчик
 * `total` по фильтрам (а не по длине страницы) и регистронезависимый поиск
 * по подстроке.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { StorageContext } from '../../storage/storage-context.js';
import type { MemoryFactRecord } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRecord } from '../../storage/ports/memory-index-repository.js';
import {
  createMemoryRoutes,
  MEMORY_NAMESPACE,
  MEMORY_PLUGIN_NAME,
  MEMORY_INDEX_TOOL_NAME,
  MEMORY_CONSOLIDATE_TOOL_NAME,
  MEMORY_GRAPH_TOOL_NAME,
} from './memory.js';
import type { MemoryToolInvokeInput, MemoryToolInvoker } from './memory.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };
const deny = async (c: Context) => c.json({ error: { code: 'FORBIDDEN', message: 'deny' } }, 403);

/** Факт памяти для наполнения порта. */
function makeFact(overrides: Partial<MemoryFactRecord> & { id: string }): MemoryFactRecord {
  return {
    namespace: MEMORY_NAMESPACE,
    version: 1,
    text: 'Деплой в test идёт через Fleet',
    kind: 'decision',
    provenance: { sourceKind: 'session', sourceId: 's-42', capturedAt: '2026-10-12T00:00:00.000Z' },
    confidence: 0.9,
    status: 'active',
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

/** Индекс памяти для наполнения порта. */
function makeIndex(overrides: Partial<MemoryIndexRecord> & { id: string }): MemoryIndexRecord {
  return {
    namespace: MEMORY_NAMESPACE,
    name: overrides.id,
    providerId: MEMORY_NAMESPACE,
    scope: 'project',
    source: { kind: 'project' },
    state: 'ready',
    generation: 1,
    fingerprint: { model: 'text-embed', dimension: 8, chunkerVersion: 'v1' },
    stats: { documents: 2, chunks: 5, updatedAt: '2026-10-12T00:00:00.000Z' },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

interface AppOptions {
  withPorts?: boolean;
  guard?: (c: Context, next: Next) => Promise<Response | void>;
  active?: boolean;
  /** Инвокер админ-тула плагина памяти (реестр тулов). */
  invokeTool?: MemoryToolInvoker;
  /** Проекты инстанса: id → workspace (нет workspace — у проекта его нет). */
  projects?: Record<string, { workspace?: string }>;
  /** Каталог данных инстанса. */
  dataDir?: string;
}

/** Приложение с порталом памяти поверх in-memory портов хранения. */
function createApp(options: AppOptions = {}): { app: Hono; storage: StorageContext } {
  const app = new Hono();
  const storage = createMemoryStorage();
  const ports = options.withPorts === false
    ? undefined
    : { facts: storage.memoryFacts, indexes: storage.memoryIndexes };
  app.route('/api/v2/memory', createMemoryRoutes(
    { requireAuth },
    {
      ...(ports ? { memory: ports } : {}),
      ...(options.guard ? { guard: options.guard as never } : {}),
      isPluginActive: () => options.active ?? true,
      ...(options.invokeTool ? { invokeTool: options.invokeTool } : {}),
      ...(options.projects
        ? {
          resolveProject: async (projectId: string) => {
            const project = options.projects?.[projectId];
            if (!project) return null;
            return {
              id: projectId,
              ...(project.workspace ? { workspace: project.workspace } : {}),
            };
          },
        }
        : {}),
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    },
  ));
  return { app, storage };
}

/** In-memory порты, наполненные фикстурами. */
async function seed(storage: StorageContext): Promise<void> {
  await storage.memoryFacts.save(makeFact({ id: 'f-1' }));
  await storage.memoryFacts.save(makeFact({ id: 'f-2', text: 'Fleet НЕ используется', status: 'candidate' }));
  await storage.memoryFacts.save(makeFact({ id: 'f-3', text: 'Релиз собирается тегом', status: 'retracted', projectId: 'p-1' }));
  await storage.memoryFacts.save(makeFact({ id: 'f-4', namespace: 'plugin:other-plugin' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-2', state: 'stale' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-3', state: 'failed', projectId: 'p-1' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-4', namespace: 'plugin:other-plugin' }));
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

/** Инвокер-заглушка: запоминает вызовы и отвечает результатом. */
function makeInvoker(
  result: { content?: string; isError?: boolean; metadata?: Record<string, unknown> } = {},
): { invoke: MemoryToolInvoker; calls: MemoryToolInvokeInput[] } {
  const calls: MemoryToolInvokeInput[] = [];
  return {
    calls,
    invoke: async (input) => {
      calls.push(input);
      return { content: 'ok', ...result };
    },
  };
}

/** POST с JSON-телом. */
async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createMemoryRoutes — статус портала', () => {
  it('GET /status: провайдер, готовность, сводные счётчики', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/status');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.provider).toEqual({ id: MEMORY_NAMESPACE, mode: 'inline', active: true });
    expect(body.namespace).toBe(MEMORY_NAMESPACE);
    expect(body.readiness).toBe('degraded');
    // Чужие записи (другой namespace) не видны.
    expect(body.facts).toEqual({ total: 3, active: 1 });
    expect(body.indexes).toEqual({ total: 3, ready: 1, stale: 1, failed: 1, building: 0 });
  });

  it('GET /status: без плагина — mode=null, active=false', async () => {
    const { app } = createApp({ active: false });
    const body = await json(await app.request('/api/v2/memory/status'));
    expect(body.provider).toEqual({ id: MEMORY_NAMESPACE, mode: null, active: false });
  });

  it('GET /status: без индексов failed/stale — readiness=ready', async () => {
    const { app, storage } = createApp();
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1' }));
    const body = await json(await app.request('/api/v2/memory/status'));
    expect(body.readiness).toBe('ready');
  });

  it('GET /status: без портов — readiness=unavailable (200, не 503)', async () => {
    const { app } = createApp({ withPorts: false });
    const res = await app.request('/api/v2/memory/status');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.readiness).toBe('unavailable');
    expect(body.facts).toEqual({ total: 0, active: 0 });
    expect(body.indexes).toEqual({ total: 0, ready: 0, stale: 0, failed: 0, building: 0 });
  });

  it('guard: доступ к порталу закрыт без прав', async () => {
    const { app } = createApp({ guard: deny });
    expect((await app.request('/api/v2/memory/status')).status).toBe(403);
    expect((await app.request('/api/v2/memory/facts')).status).toBe(403);
    expect((await app.request('/api/v2/memory/indexes')).status).toBe(403);
  });
});

describe('createMemoryRoutes — факты', () => {
  it('GET /facts: по умолчанию — только активные, форма страницы', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/facts');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('f-1');
    expect(body.items[0].namespace).toBe(MEMORY_NAMESPACE);
  });

  it('GET /facts?status=all — все статусы namespace', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const body = await json(await app.request('/api/v2/memory/facts?status=all'));
    expect(body.total).toBe(3);
    expect(body.items.map((f: MemoryFactRecord) => f.id).sort()).toEqual(['f-1', 'f-2', 'f-3']);
  });

  it('GET /facts: total считается по фильтрам, а не по длине страницы', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const body = await json(await app.request('/api/v2/memory/facts?status=all&limit=1'));
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
  });

  it('GET /facts: фильтр по kind и projectId', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const byProject = await json(await app.request('/api/v2/memory/facts?status=all&projectId=p-1'));
    expect(byProject.total).toBe(1);
    expect(byProject.items[0].id).toBe('f-3');
    const byKind = await json(await app.request('/api/v2/memory/facts?status=all&kind=decision'));
    expect(byKind.total).toBe(3);
    const byUnknownKind = await json(await app.request('/api/v2/memory/facts?status=all&kind=constraint'));
    expect(byUnknownKind.total).toBe(0);
  });

  it('GET /facts?query= — поиск по подстроке (регистронезависимо)', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const body = await json(await app.request('/api/v2/memory/facts?status=all&query=fleet'));
    expect(body.total).toBe(2);
    expect(body.items.map((f: MemoryFactRecord) => f.id).sort()).toEqual(['f-1', 'f-2']);
    const upper = await json(await app.request('/api/v2/memory/facts?status=all&query=FLEET'));
    expect(upper.total).toBe(2);
    const none = await json(await app.request('/api/v2/memory/facts?status=all&query=нетакого'));
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
  });

  it('GET /facts: namespace нельзя подменить query-параметром', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const body = await json(await app.request('/api/v2/memory/facts?status=all&namespace=plugin:other-plugin'));
    // Чужие записи не видны — namespace подставляет сервер.
    expect(body.total).toBe(3);
    expect(body.items.every((f: MemoryFactRecord) => f.namespace === MEMORY_NAMESPACE)).toBe(true);
  });

  it('GET /facts: невалидные status/limit/offset → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp();
    for (const query of ['status=unknown', 'limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'offset=x']) {
      const res = await app.request(`/api/v2/memory/facts?${query}`);
      expect(res.status, query).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('GET /facts/:id — запись факта', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/facts/f-1');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe('f-1');
    expect(body.text).toBe('Деплой в test идёт через Fleet');
  });

  it('GET /facts/:id — несуществующий → 404 MEMORY_FACT_NOT_FOUND', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/facts/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('MEMORY_FACT_NOT_FOUND');
  });

  it('GET /facts/:id — чужой namespace выглядит как «не найдено»', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/facts/f-4');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('MEMORY_FACT_NOT_FOUND');
  });

  it('без портов — 503 MEMORY_UNAVAILABLE', async () => {
    const { app } = createApp({ withPorts: false });
    for (const path of ['/api/v2/memory/facts', '/api/v2/memory/facts/f-1', '/api/v2/memory/indexes']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect((await json(res)).error.code).toBe('MEMORY_UNAVAILABLE');
    }
  });
});

describe('createMemoryRoutes — индексы', () => {
  it('GET /indexes: все индексы namespace, без чанков', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const res = await app.request('/api/v2/memory/indexes');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i: MemoryIndexRecord) => i.id).sort()).toEqual(['i-1', 'i-2', 'i-3']);
    expect(body.items[0]).not.toHaveProperty('chunks');
  });

  it('GET /indexes: фильтр по state и projectId', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const stale = await json(await app.request('/api/v2/memory/indexes?state=stale'));
    expect(stale.total).toBe(1);
    expect(stale.items[0].id).toBe('i-2');
    const failed = await json(await app.request('/api/v2/memory/indexes?state=failed'));
    expect(failed.total).toBe(1);
    const byProject = await json(await app.request('/api/v2/memory/indexes?projectId=p-1'));
    expect(byProject.total).toBe(1);
    expect(byProject.items[0].id).toBe('i-3');
  });

  it('GET /indexes: невалидный state → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp();
    const res = await app.request('/api/v2/memory/indexes?state=unknown');
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('namespace нельзя подменить query-параметром', async () => {
    const { app, storage } = createApp();
    await seed(storage);
    const body = await json(await app.request('/api/v2/memory/indexes?namespace=plugin:other-plugin'));
    expect(body.total).toBe(3);
  });
});

describe('createMemoryRoutes — мутации индексов (портал → админ-тул плагина)', () => {
  const WORKSPACE = '/srv/workspaces/demo';
  const DATA_DIR = '/srv/data';

  it('POST /indexes: без проекта → 400 MEMORY_PROJECT_REQUIRED', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', { name: 'demo' });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('MEMORY_PROJECT_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes: несуществующий проект → 404 PROJECT_NOT_FOUND', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-nope' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('PROJECT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes: проект без workspace при files → 400 MEMORY_WORKSPACE_REQUIRED', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': {} } });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('MEMORY_WORKSPACE_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes: успех → 202, тул вызван с action=create, projectId и workingDir', async () => {
    const { invoke, calls } = makeInvoker({ metadata: { indexId: 'i-new' } });
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', {
      name: 'demo',
      projectId: 'p-1',
      source: { kind: 'files', filter: '**/*.md' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(typeof body.message).toBe('string');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.tool).toBe(MEMORY_INDEX_TOOL_NAME);
    expect(call?.projectId).toBe('p-1');
    expect(call?.workingDir).toBe(WORKSPACE);
    expect(call?.params.action).toBe('create');
    expect(call?.params.name).toBe('demo');
    expect(call?.params.projectId).toBe('p-1');
    expect(call?.params.source).toEqual({ kind: 'files', filter: '**/*.md' });
  });

  it('POST /indexes: тело индекса — запись из порта', async () => {
    const { invoke } = makeInvoker({ metadata: { indexId: 'i-new' } });
    const { app, storage } = createApp({
      invokeTool: invoke,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-new', name: 'demo' }));
    const body = await json(await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' }));
    expect(body.index.id).toBe('i-new');
    expect(body.index.name).toBe('demo');
    expect(body.index.namespace).toBe(MEMORY_NAMESPACE);
  });

  it('POST /indexes: без инвокера → 409 MEMORY_PROVIDER_UNAVAILABLE', async () => {
    const { app } = createApp({ projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('MEMORY_PROVIDER_UNAVAILABLE');
  });

  it('POST /indexes: плагин не активен → 409 MEMORY_PROVIDER_UNAVAILABLE', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({
      invokeTool: invoke,
      active: false,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('MEMORY_PROVIDER_UNAVAILABLE');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes: ошибка тула → 422 MEMORY_INDEX_FAILED с текстом тула', async () => {
    const { invoke } = makeInvoker({ content: 'Индекс не собран: нет файлов', isError: true });
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('MEMORY_INDEX_FAILED');
    expect(body.error.message).toBe('Индекс не собран: нет файлов');
  });

  it('POST /indexes: внутренние пути в тексте ошибки маскируются', async () => {
    const { invoke } = makeInvoker({
      content: `не удалось прочитать ${DATA_DIR}/secrets/master.key в ${WORKSPACE}/docs`,
      isError: true,
    });
    const { app } = createApp({
      invokeTool: invoke,
      dataDir: DATA_DIR,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(422);
    const message = (await json(res)).error.message as string;
    expect(message).not.toContain(DATA_DIR);
    expect(message).not.toContain(WORKSPACE);
    expect(message).toContain('<data>');
  });

  it('POST /indexes: источник facts без workspace → рабочий каталог = каталог данных', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({
      invokeTool: invoke,
      dataDir: DATA_DIR,
      projects: { 'p-1': {} },
    });
    const res = await post(app, '/api/v2/memory/indexes', {
      projectId: 'p-1',
      source: { kind: 'facts' },
    });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.workingDir).toBe(DATA_DIR);
    expect(call?.params.source).toEqual({ kind: 'facts' });
  });

  it('POST /indexes: недопустимый источник → 400 VALIDATION_ERROR', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes', {
      projectId: 'p-1',
      source: { kind: 'bogus' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes/:id/rebuild: несуществующий индекс → 404 MEMORY_INDEX_NOT_FOUND', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/indexes/nope/rebuild', {});
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('MEMORY_INDEX_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('POST /indexes/:id/rebuild: успех → 202, тул вызван с action=rebuild', async () => {
    const { invoke, calls } = makeInvoker();
    const { app, storage } = createApp({
      invokeTool: invoke,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));
    const res = await post(app, '/api/v2/memory/indexes/i-1/rebuild', { force: true });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.index.id).toBe('i-1');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params.action).toBe('rebuild');
    expect(call?.params.indexId).toBe('i-1');
    expect(call?.params.force).toBe(true);
    expect(call?.projectId).toBe('p-1');
    expect(call?.workingDir).toBe(WORKSPACE);
  });

  it('POST /indexes/:id/rebuild: индекс чужого namespace → 404', async () => {
    const { invoke, calls } = makeInvoker();
    const { app, storage } = createApp({
      invokeTool: invoke,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-x', namespace: 'plugin:other-plugin' }));
    const res = await post(app, '/api/v2/memory/indexes/i-x/rebuild', {});
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('MEMORY_INDEX_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('DELETE /indexes/:id: успех → 204, тул вызван с action=delete', async () => {
    const { invoke, calls } = makeInvoker();
    const { app, storage } = createApp({
      invokeTool: invoke,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));
    const res = await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params.action).toBe('delete');
    expect(call?.params.indexId).toBe('i-1');
    expect(call?.projectId).toBe('p-1');
  });

  it('DELETE /indexes/:id: несуществующий индекс → 404 MEMORY_INDEX_NOT_FOUND', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await app.request('/api/v2/memory/indexes/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('MEMORY_INDEX_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('guard: мутации индексов закрыты без прав', async () => {
    const { invoke } = makeInvoker();
    const { app } = createApp({
      invokeTool: invoke,
      guard: deny,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    expect((await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' })).status).toBe(403);
    expect((await post(app, '/api/v2/memory/indexes/i-1/rebuild', {})).status).toBe(403);
    expect((await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' })).status).toBe(403);
  });
});

describe('createMemoryRoutes — консолидация фактов (портал → админ-тул плагина)', () => {
  const WORKSPACE = '/srv/workspaces/demo';
  const DATA_DIR = '/srv/data';

  const REPORT_METADATA = {
    clusters: 2,
    superseded: 3,
    kept: 2,
    items: [
      { keptId: 'f-1', supersededIds: ['f-2', 'f-3'], similarity: 0.93 },
      { keptId: 'f-4', supersededIds: [], similarity: 0.81 },
    ],
  };

  it('POST /consolidate: успех → 200 с отчётом, тул вызван с projectId/dryRun/threshold', async () => {
    const { invoke, calls } = makeInvoker({ metadata: REPORT_METADATA });
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/consolidate', {
      projectId: 'p-1',
      threshold: 0.85,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.report).toEqual(REPORT_METADATA);
    expect(typeof body.message).toBe('string');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.tool).toBe(MEMORY_CONSOLIDATE_TOOL_NAME);
    expect(call?.projectId).toBe('p-1');
    expect(call?.workingDir).toBe(WORKSPACE);
    expect(call?.params.projectId).toBe('p-1');
    expect(call?.params.threshold).toBe(0.85);
    expect(call?.params.dryRun).toBe(true);
    // У консолидации нет `action` — это операция без вида.
    expect(call?.params.action).toBeUndefined();
  });

  it('POST /consolidate: порог вне 0.5..0.99 → 400 VALIDATION_ERROR', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    for (const threshold of [0.2, 1, -0.5, 1.5, '0.8']) {
      const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1', threshold });
      expect(res.status, String(threshold)).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
    expect(calls).toHaveLength(0);
    // Границы диапазона допустимы.
    for (const threshold of [0.5, 0.99]) {
      const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1', threshold });
      expect(res.status, String(threshold)).toBe(200);
    }
  });

  it('POST /consolidate: несуществующий проект → 404 PROJECT_NOT_FOUND', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-nope' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('PROJECT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('POST /consolidate: без инвокера → 409 MEMORY_PROVIDER_UNAVAILABLE', async () => {
    const { app } = createApp({ projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('MEMORY_PROVIDER_UNAVAILABLE');
  });

  it('POST /consolidate: ошибка тула → 422 MEMORY_CONSOLIDATION_FAILED с кодом в details', async () => {
    const { invoke } = makeInvoker({
      content: `Эмбеддинги не настроены: ${DATA_DIR}/secrets`,
      isError: true,
      metadata: { code: 'plugin.embedding_not_configured' },
    });
    const { app } = createApp({
      invokeTool: invoke,
      dataDir: DATA_DIR,
      projects: { 'p-1': { workspace: WORKSPACE } },
    });
    const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1' });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('MEMORY_CONSOLIDATION_FAILED');
    expect(body.error.details.code).toBe('plugin.embedding_not_configured');
    // Внутренние пути в тексте ошибки маскируются.
    expect(body.error.message).not.toContain(DATA_DIR);
    expect(body.error.message).toContain('<data>');
  });

  it('POST /consolidate: проект без workspace не мешает (200, рабочий каталог = каталог данных)', async () => {
    const { invoke, calls } = makeInvoker({ metadata: REPORT_METADATA });
    const { app } = createApp({
      invokeTool: invoke,
      dataDir: DATA_DIR,
      projects: { 'p-1': {} },
    });
    const res = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1' });
    expect(res.status).toBe(200);
    expect((await json(res)).report).toEqual(REPORT_METADATA);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.workingDir).toBe(DATA_DIR);
  });
});

describe('createMemoryRoutes — граф памяти (портал → админ-тул плагина)', () => {
  const WORKSPACE = '/srv/workspaces/demo';
  const DATA_DIR = '/srv/data';

  const GRAPH_METADATA = {
    nodes: [
      { id: 'e-1', kind: 'entity', name: 'Fleet' },
      {
        id: 'f-1',
        kind: 'fact',
        factId: 'fact-1',
        text: 'Деплой в test идёт через Fleet',
        entity: 'Fleet',
      },
    ],
    edges: [{ from: 'f-1', to: 'e-1', relation: 'упоминается' }],
    stats: { entities: 1, facts: 1, edges: 1 },
  };

  it('GET /graph: успех → 200, форма {nodes, edges, stats}', async () => {
    const { invoke, calls } = makeInvoker({ metadata: GRAPH_METADATA });
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await app.request('/api/v2/memory/graph?entity=Fleet&depth=2&limit=50&projectId=p-1');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.nodes).toEqual(GRAPH_METADATA.nodes);
    expect(body.edges).toEqual(GRAPH_METADATA.edges);
    expect(body.stats).toEqual({ entities: 1, facts: 1, edges: 1 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.tool).toBe(MEMORY_GRAPH_TOOL_NAME);
    expect(call?.params).toEqual({ entity: 'Fleet', depth: 2, limit: 50 });
    expect(call?.workingDir).toBe(WORKSPACE);
    expect(call?.projectId).toBe('p-1');

    // Без параметров — дефолты (depth 1, limit 100), сущность не передаётся.
    await app.request('/api/v2/memory/graph');
    expect(calls[1]?.params).toEqual({ depth: 1, limit: 100 });

    // Недоверенные метаданные не ломают форму ответа.
    const { invoke: badInvoke } = makeInvoker({
      metadata: { nodes: 'nope', edges: [{ from: 'a' }, { from: 'b', to: 'c' }] },
    });
    const { app: badApp } = createApp({ invokeTool: badInvoke });
    const badBody = await json(await badApp.request('/api/v2/memory/graph'));
    expect(badBody.nodes).toEqual([]);
    expect(badBody.edges).toEqual([{ from: 'b', to: 'c' }]);
    expect(badBody.stats).toEqual({ entities: 0, facts: 0, edges: 1 });
  });

  it('GET /graph: depth/limit вне диапазона → 400 VALIDATION_ERROR', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke });
    const badQueries = [
      'depth=0',
      'depth=4',
      'depth=abc',
      'limit=0',
      'limit=201',
      'limit=x',
      // Мусор в сущности — длиннее контракта тула (1..200 символов).
      `entity=${'x'.repeat(201)}`,
    ];
    for (const query of badQueries) {
      const res = await app.request(`/api/v2/memory/graph?${query}`);
      expect(res.status, query).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
    expect(calls).toHaveLength(0);
    // Границы диапазона допустимы.
    for (const query of ['depth=1', 'depth=3', 'limit=1', 'limit=200', `entity=${'x'.repeat(200)}`]) {
      const res = await app.request(`/api/v2/memory/graph?${query}`);
      expect(res.status, query).toBe(200);
    }
  });

  it('GET /graph: несуществующий проект → 404 PROJECT_NOT_FOUND', async () => {
    const { invoke, calls } = makeInvoker();
    const { app } = createApp({ invokeTool: invoke, projects: { 'p-1': { workspace: WORKSPACE } } });
    const res = await app.request('/api/v2/memory/graph?projectId=p-nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('PROJECT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('GET /graph: без инвокера → 409 MEMORY_PROVIDER_UNAVAILABLE', async () => {
    const { app } = createApp();
    const res = await app.request('/api/v2/memory/graph');
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('MEMORY_PROVIDER_UNAVAILABLE');
  });

  it('GET /graph: ошибка тула → 422 MEMORY_GRAPH_FAILED с кодом в details', async () => {
    const { invoke } = makeInvoker({
      content: `Граф не построен: ${DATA_DIR}/memory`,
      isError: true,
      metadata: { code: 'plugin.graph_not_ready' },
    });
    const { app } = createApp({ invokeTool: invoke, dataDir: DATA_DIR });
    const res = await app.request('/api/v2/memory/graph');
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('MEMORY_GRAPH_FAILED');
    expect(body.error.details.code).toBe('plugin.graph_not_ready');
    // Внутренние пути в тексте ошибки маскируются.
    expect(body.error.message).not.toContain(DATA_DIR);
    expect(body.error.message).toContain('<data>');
  });

  it('GET /graph: проект без workspace не мешает (200, рабочий каталог = каталог данных)', async () => {
    const { invoke, calls } = makeInvoker({ metadata: GRAPH_METADATA });
    const { app } = createApp({
      invokeTool: invoke,
      dataDir: DATA_DIR,
      projects: { 'p-1': {} },
    });
    const res = await app.request('/api/v2/memory/graph?projectId=p-1');
    expect(res.status).toBe(200);
    expect((await json(res)).nodes).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.workingDir).toBe(DATA_DIR);
    // Скоуп проекта уходит в контекст вызова, а не в параметры тула.
    expect(calls[0]?.projectId).toBe('p-1');
    expect(calls[0]?.params.projectId).toBeUndefined();
  });
});

describe('константы портала', () => {
  it('имя плагина и namespace совпадают с правилом хоста', () => {
    expect(MEMORY_PLUGIN_NAME).toBe('synth-plugin-memory');
    expect(MEMORY_NAMESPACE).toBe('plugin:synth-plugin-memory');
  });
});
