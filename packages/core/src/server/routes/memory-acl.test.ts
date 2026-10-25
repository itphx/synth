/**
 * ADR-089 §5.8 / инвариант 16: **проектная авторизация портала памяти**.
 *
 * `projectId` — обычный параметр запроса, поэтому права на проект проверяются
 * **на границе** (до обращения к порту/тулу) через `opts.authorizeProject`:
 * `read` — чтение, `write` — изменение содержимого.
 *
 * Матрица:
 * - `read` разрешён (участник) → 200 на facts/indexes/graph;
 * - `read` запрещён (чужой) → 403 (и write-операции тоже 403);
 * - `write` запрещён (`VIEWER`: read=true, write=false) → GET 200, POST/DELETE 403;
 * - `POST /indexes` без `projectId` → 400 `MEMORY_PROJECT_REQUIRED` (не 403);
 * - `GET /status` — вне проверки (агрегат по инстансу, без projectId);
 * - callback бросил исключение → 403 (fail-closed);
 * - `:id`-операции: чужой индекс → 403; несуществующий → 404 (404 раньше 403).
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { StorageContext } from '../../storage/storage-context.js';
import type { MemoryFactRecord } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRecord } from '../../storage/ports/memory-index-repository.js';
import { createMemoryRoutes, MEMORY_NAMESPACE, MEMORY_INDEX_TOOL_NAME, MEMORY_CONSOLIDATE_TOOL_NAME } from './memory.js';
import type { MemoryToolInvokeInput, MemoryToolInvoker } from './memory.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

const WORKSPACE = '/srv/workspaces/demo';
const DATA_DIR = '/srv/data';

/** Права по проекту: `read`/`write`. */
type Access = { read: boolean; write: boolean };

/** Правило доступа: проект → права. Проекта нет — доступа нет. */
const READ_ONLY: Access = { read: true, write: false };
const FULL: Access = { read: true, write: true };
const NONE: Access = { read: false, write: false };

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
  /** Правило доступа по проекту (`mode` → право). */
  access?: (projectId: string, mode: 'read' | 'write') => boolean;
  /** Правило, бросающее исключение (fail-closed). */
  throwing?: boolean;
  /** Проекты инстанса: id → workspace. */
  projects?: Record<string, { workspace?: string }>;
  /** Инвокер админ-тула плагина памяти. */
  invokeTool?: MemoryToolInvoker;
  /** Задать `authorizeProject` (по умолчанию — задан). */
  withAuthorize?: boolean;
}

/** Приложение с порталом памяти поверх in-memory портов хранения. */
function createApp(options: AppOptions = {}): { app: Hono; storage: StorageContext; calls: MemoryToolInvokeInput[] } {
  const app = new Hono();
  const storage = createMemoryStorage();
  const calls: MemoryToolInvokeInput[] = [];
  const invokeTool: MemoryToolInvoker = options.invokeTool ?? (async (input) => {
    calls.push(input);
    return { content: 'ok', metadata: { indexId: 'i-new', nodes: [], edges: [] } };
  });
  const withAuthorize = options.withAuthorize ?? true;

  app.route('/api/v2/memory', createMemoryRoutes(
    { requireAuth },
    {
      memory: { facts: storage.memoryFacts, indexes: storage.memoryIndexes },
      isPluginActive: () => true,
      invokeTool,
      dataDir: DATA_DIR,
      resolveProject: async (projectId: string) => {
        const project = options.projects?.[projectId];
        if (!project) return null;
        return {
          id: projectId,
          ...(project.workspace ? { workspace: project.workspace } : {}),
        };
      },
      ...(withAuthorize
        ? {
          authorizeProject: async (
            _c: Context,
            projectId: string,
            mode: 'read' | 'write',
          ) => {
            if (options.throwing) throw new Error('проверка прав сломалась');
            const rule = options.access?.(projectId, mode);
            return rule === true;
          },
        }
        : {}),
    },
  ));
  return { app, storage, calls };
}

/** In-memory порты, наполненные фикстурами. */
async function seed(storage: StorageContext): Promise<void> {
  await storage.memoryFacts.save(makeFact({ id: 'f-1' }));
  await storage.memoryFacts.save(makeFact({ id: 'f-3', projectId: 'p-1' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-1', projectId: 'p-1' }));
  await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-2' }));
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Код ошибки из тела ответа (`{error:{code}}`). */
async function errorCode(res: Response): Promise<string> {
  const body = await json(res);
  const error = body.error as { code?: string } | undefined;
  return error?.code ?? '';
}

/** POST с JSON-телом. */
async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const PROJECTS = { 'p-1': { workspace: WORKSPACE } };

describe('createMemoryRoutes — проектная авторизация (инвариант 16)', () => {
  it('read разрешён (участник) → 200 на facts/indexes/graph', async () => {
    const { app, storage } = createApp({ access: () => true, projects: PROJECTS });
    await seed(storage);

    const facts = await app.request('/api/v2/memory/facts?status=all&projectId=p-1');
    expect(facts.status).toBe(200);
    const factsBody = await json(facts);
    expect((factsBody.items as MemoryFactRecord[]).map((f) => f.id)).toEqual(['f-3']);

    const indexes = await app.request('/api/v2/memory/indexes?projectId=p-1');
    expect(indexes.status).toBe(200);
    const indexesBody = await json(indexes);
    expect((indexesBody.items as MemoryIndexRecord[]).map((i) => i.id)).toEqual(['i-1']);

    const graph = await app.request('/api/v2/memory/graph?projectId=p-1');
    expect(graph.status).toBe(200);
  });

  it('read запрещён (чужой) → 403 на чтении и на записи', async () => {
    const { app, storage, calls } = createApp({ access: () => false, projects: PROJECTS });
    await seed(storage);

    for (const path of [
      '/api/v2/memory/facts?status=all&projectId=p-1',
      '/api/v2/memory/facts/f-3',
      '/api/v2/memory/indexes?projectId=p-1',
      '/api/v2/memory/graph?projectId=p-1',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(403);
      // Формат ошибки — общий `{error:{code, message}}`.
      const body = await json(res);
      expect((body.error as { code?: string }).code, path).toBe('FORBIDDEN');
      expect((body.error as { message?: string }).message, path).toBeTruthy();
    }

    // Write-операции — тоже 403, тул не вызывается.
    expect((await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' })).status).toBe(403);
    expect((await post(app, '/api/v2/memory/indexes/i-1/rebuild', {})).status).toBe(403);
    expect((await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('write запрещён (VIEWER: read=true, write=false) → GET 200, POST/DELETE 403', async () => {
    const { app, storage, calls } = createApp({
      access: (_projectId, mode) => mode === 'read',
      projects: PROJECTS,
    });
    await seed(storage);

    // Чтение проекта — разрешено.
    expect((await app.request('/api/v2/memory/facts?status=all&projectId=p-1')).status).toBe(200);
    expect((await app.request('/api/v2/memory/indexes?projectId=p-1')).status).toBe(200);
    expect((await app.request('/api/v2/memory/graph?projectId=p-1')).status).toBe(200);
    expect((await app.request('/api/v2/memory/facts/f-3')).status).toBe(200);

    // Изменение содержимого — запрещено.
    const created = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(created.status).toBe(403);
    expect(await errorCode(created)).toBe('FORBIDDEN');
    expect((await post(app, '/api/v2/memory/indexes/i-1/rebuild', {})).status).toBe(403);
    expect((await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, '/api/v2/memory/consolidate', { projectId: 'p-1' })).status).toBe(403);
    // Мутирующие тулы не вызывались (чтение графа — вызов тула, он разрешён).
    const mutations = calls.filter(
      (call) => call.tool === MEMORY_INDEX_TOOL_NAME || call.tool === MEMORY_CONSOLIDATE_TOOL_NAME,
    );
    expect(mutations).toHaveLength(0);
  });

  it('POST /indexes без projectId → 400 MEMORY_PROJECT_REQUIRED (не 403)', async () => {
    const { app, calls } = createApp({ access: () => false, projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', { name: 'demo' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('MEMORY_PROJECT_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('GET /status — вне проверки (агрегат по инстансу, без projectId)', async () => {
    const { app, storage } = createApp({ access: () => false, projects: PROJECTS });
    await seed(storage);
    const res = await app.request('/api/v2/memory/status');
    expect(res.status).toBe(200);
    const statusBody = await json(res);
    expect((statusBody.provider as { id?: string }).id).toBe(MEMORY_NAMESPACE);
  });

  it('callback бросил исключение → 403 (fail-closed)', async () => {
    const { app, storage, calls } = createApp({ throwing: true, projects: PROJECTS });
    await seed(storage);

    const res = await app.request('/api/v2/memory/facts?status=all&projectId=p-1');
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
    expect((await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('`:id`-операции: чужой индекс → 403, несуществующий → 404 (404 раньше 403)', async () => {
    const { app, storage } = createApp({ access: () => false, projects: PROJECTS });
    await seed(storage);

    // Индекс чужого проекта (существует) → 403.
    const rebuild = await post(app, '/api/v2/memory/indexes/i-1/rebuild', {});
    expect(rebuild.status).toBe(403);
    expect(await errorCode(rebuild)).toBe('FORBIDDEN');

    const remove = await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' });
    expect(remove.status).toBe(403);

    // Несуществующий индекс → 404 (и права не проверяются — сущности нет).
    const missing = await post(app, '/api/v2/memory/indexes/nope/rebuild', {});
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('MEMORY_INDEX_NOT_FOUND');

    // Факт чужого проекта → 403; несуществующий факт → 404.
    const fact = await app.request('/api/v2/memory/facts/f-3');
    expect(fact.status).toBe(403);
    const noFact = await app.request('/api/v2/memory/facts/nope');
    expect(noFact.status).toBe(404);
    expect(await errorCode(noFact)).toBe('MEMORY_FACT_NOT_FOUND');
  });

  it('запись без проекта (инстансная) — проектной проверки нет', async () => {
    const { app, storage } = createApp({ access: () => false, projects: PROJECTS });
    await seed(storage);

    // Факт инстанса (без projectId) — права на проект не проверяются.
    expect((await app.request('/api/v2/memory/facts/f-1')).status).toBe(200);
    // Индекс инстанса (без projectId) — аналогично.
    expect((await post(app, '/api/v2/memory/indexes/i-2/rebuild', {})).status).toBe(202);
    // Консолидация без проекта — операция по инстансу (scope-проверка guard'а).
    expect((await post(app, '/api/v2/memory/consolidate', {})).status).toBe(200);
    // Граф без проекта — скоуп инстанса.
    expect((await app.request('/api/v2/memory/graph')).status).toBe(200);
  });

  it('проверка не задана (standalone) → доступ разрешён, поведение прежнее', async () => {
    const { app, storage } = createApp({ withAuthorize: false, projects: PROJECTS });
    await seed(storage);

    expect((await app.request('/api/v2/memory/facts?status=all&projectId=p-1')).status).toBe(200);
    expect((await app.request('/api/v2/memory/indexes?projectId=p-1')).status).toBe(200);
    expect((await app.request('/api/v2/memory/graph?projectId=p-1')).status).toBe(200);
    expect((await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' })).status).toBe(202);
  });

  it('несуществующий проект → 404 PROJECT_NOT_FOUND (404 раньше 403)', async () => {
    const { app } = createApp({ access: () => false, projects: PROJECTS });
    const created = await post(app, '/api/v2/memory/indexes', { projectId: 'p-nope' });
    expect(created.status).toBe(404);
    expect(await errorCode(created)).toBe('PROJECT_NOT_FOUND');

    const consolidated = await post(app, '/api/v2/memory/consolidate', { projectId: 'p-nope' });
    expect(consolidated.status).toBe(404);
    expect(await errorCode(consolidated)).toBe('PROJECT_NOT_FOUND');

    const graph = await app.request('/api/v2/memory/graph?projectId=p-nope');
    expect(graph.status).toBe(404);
    expect(await errorCode(graph)).toBe('PROJECT_NOT_FOUND');
  });

  it('режим доступа доходит до callback: read ≠ write', async () => {
    const seen: Array<{ projectId: string; mode: string }> = [];
    const { app } = createApp({
      access: (projectId, mode) => {
        seen.push({ projectId, mode });
        return mode === 'read';
      },
      projects: PROJECTS,
    });

    await app.request('/api/v2/memory/facts?projectId=p-1');
    await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(seen).toEqual([
      { projectId: 'p-1', mode: 'read' },
      { projectId: 'p-1', mode: 'write' },
    ]);
  });
});

describe('createMemoryRoutes — матрица ролей проекта (read/write)', () => {
  /** Матрица «роль участника → права на портал». */
  const cases: Array<{ role: string; access: Access; read: boolean; write: boolean }> = [
    { role: 'чужой (не участник)', access: NONE, read: false, write: false },
    { role: 'VIEWER', access: READ_ONLY, read: true, write: false },
    { role: 'EDITOR/OWNER', access: FULL, read: true, write: true },
  ];

  for (const { role, access, read, write } of cases) {
    it(`${role}: чтение ${read ? 'разрешено' : 'запрещено'}, запись ${write ? 'разрешена' : 'запрещена'}`, async () => {
      const { app, storage } = createApp({
        access: (_projectId, mode) => (mode === 'read' ? access.read : access.write),
        projects: PROJECTS,
      });
      await seed(storage);

      const readRes = await app.request('/api/v2/memory/facts?status=all&projectId=p-1');
      expect(readRes.status, 'read facts').toBe(read ? 200 : 403);

      const writeRes = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
      expect(writeRes.status, 'write indexes').toBe(write ? 202 : 403);
    });
  }
});
