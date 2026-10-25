/**
 * ADR-107 / PROP-047 §2.1: **инстансные индексы** в портале памяти.
 *
 * Область видимости индекса (`MemoryIndexRecord.scope`): `project` (по умолчанию —
 * индекс виден только своему проекту) или `instance` (**инстансный** индекс —
 * виден всем на инстансе).
 *
 * Матрица:
 * - **create**: `scope` не задан → `project` (прежнее поведение);
 *   `scope:'instance'` + `facts` → без `projectId` (202, `projectId` не уходит
 *   ни в тул, ни в запись); `scope:'instance'` + `files` → `projectId`
 *   обязателен (источник корпуса), workspace обязателен;
 * - **ACL**: для `instance` права проекта **не применяются** (счётчик вызовов
 *   `authorizeProject` — ноль), для `project` — применяются (403 при отказе);
 * - **list**: `scope` — фильтр порта (`project`/`instance`; мусор → 400
 *   `VALIDATION_ERROR`);
 * - **rebuild/delete**: у `instance` ACL не вызывается, у `project` — вызывается.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMemoryStorage } from '../../storage/storage-context.js';
import type { StorageContext } from '../../storage/storage-context.js';
import type { MemoryIndexRecord } from '../../storage/ports/memory-index-repository.js';
import { createMemoryRoutes, MEMORY_NAMESPACE, MEMORY_INDEX_TOOL_NAME } from './memory.js';
import type { MemoryToolInvokeInput, MemoryToolInvoker } from './memory.js';

const requireAuth = async (_c: Context, next: Next) => { await next(); };

const WORKSPACE = '/srv/workspaces/demo';
const DATA_DIR = '/srv/data';

/** Индекс памяти для наполнения порта. */
function makeIndex(overrides: Partial<MemoryIndexRecord> & { id: string }): MemoryIndexRecord {
  return {
    namespace: MEMORY_NAMESPACE,
    name: overrides.id,
    providerId: MEMORY_NAMESPACE,
    scope: 'project',
    source: { kind: 'files' },
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
  /** Права на проект: `false` — отказ (403). */
  access?: boolean;
  /** Проекты инстанса: id → workspace (нет workspace — у проекта его нет). */
  projects?: Record<string, { workspace?: string }>;
}

/**
 * Приложение с порталом памяти поверх in-memory портов хранения.
 *
 * Инвокер — **имитация плагина**: он пишет индекс в порт (область видимости
 * берётся из параметра `scope` тула — так же, как это делает настоящий плагин).
 */
function createApp(options: AppOptions = {}): {
  app: Hono;
  storage: StorageContext;
  calls: MemoryToolInvokeInput[];
  aclCalls: () => number;
} {
  const app = new Hono();
  const storage = createMemoryStorage();
  const calls: MemoryToolInvokeInput[] = [];
  let aclCalls = 0;

  const invokeTool: MemoryToolInvoker = async (input) => {
    calls.push(input);
    if (input.tool === MEMORY_INDEX_TOOL_NAME && input.params.action === 'create') {
      const scope = input.params.scope === 'instance' ? 'instance' : 'project';
      const source = input.params.source as { kind: string } | undefined;
      await storage.memoryIndexes.saveIndex(
        makeIndex({
          id: 'i-new',
          scope,
          ...(source ? { source } : {}),
          ...(typeof input.params.projectId === 'string'
            ? { projectId: input.params.projectId }
            : {}),
        }),
      );
    }
    return { content: 'ok', metadata: { indexId: 'i-new' } };
  };

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
      // Счётчик проверок прав: для instance-операций вызываться не должен.
      authorizeProject: async () => {
        aclCalls += 1;
        return options.access ?? true;
      },
    },
  ));
  return { app, storage, calls, aclCalls: () => aclCalls };
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
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

describe('createMemoryRoutes — инстансный индекс (scope=instance), создание', () => {
  it('scope=instance + facts без projectId → 202: scope в теле, projectId отсутствует', async () => {
    const { app, calls, aclCalls } = createApp({ access: false });
    const res = await post(app, '/api/v2/memory/indexes', {
      name: 'global-facts',
      scope: 'instance',
      source: { kind: 'facts' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(typeof body.message).toBe('string');
    // Тело индекса — запись из порта: область видимости и отсутствие проекта.
    expect(body.index.scope).toBe('instance');
    expect(body.index.projectId).toBeUndefined();
    // Тул получил `scope` и **не** получил `projectId` (ни в параметрах, ни в
    // контексте вызова).
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.tool).toBe(MEMORY_INDEX_TOOL_NAME);
    expect(call?.params.action).toBe('create');
    expect(call?.params.scope).toBe('instance');
    expect(call?.params.projectId).toBeUndefined();
    expect(call?.projectId).toBeUndefined();
    // Рабочий каталог вызова — каталог данных инстанса (workspace проекта нет).
    expect(call?.workingDir).toBe(DATA_DIR);
    // Права проекта не применялись.
    expect(aclCalls()).toBe(0);
  });

  it('scope=instance + facts с projectId → projectId не используется (в тул не уходит)', async () => {
    const { app, calls } = createApp({ projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      projectId: 'p-1',
      source: { kind: 'facts' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.index.scope).toBe('instance');
    expect(body.index.projectId).toBeUndefined();
    const [call] = calls;
    expect(call?.params.scope).toBe('instance');
    expect(call?.params.projectId).toBeUndefined();
    expect(call?.projectId).toBeUndefined();
  });

  it('scope=instance + files без projectId → 400 MEMORY_PROJECT_REQUIRED', async () => {
    const { app, calls } = createApp({ projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      source: { kind: 'files' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('MEMORY_PROJECT_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('scope=instance + files с projectId и workspace → 202: тул получил projectId и workingDir', async () => {
    const { app, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      projectId: 'p-1',
      source: { kind: 'files', filter: '**/*.md' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.index.scope).toBe('instance');
    // `projectId` инстансного индекса — источник корпуса (он в записи есть).
    expect(body.index.projectId).toBe('p-1');
    const [call] = calls;
    expect(call?.params.scope).toBe('instance');
    expect(call?.params.projectId).toBe('p-1');
    expect(call?.projectId).toBe('p-1');
    expect(call?.workingDir).toBe(WORKSPACE);
    // ACL проекта к инстансной операции не применяется.
    expect(aclCalls()).toBe(0);
  });

  it('scope=instance + files: несуществующий проект → 404 PROJECT_NOT_FOUND', async () => {
    const { app, calls } = createApp({ projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      projectId: 'p-nope',
      source: { kind: 'files' },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('PROJECT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('scope=instance + files: проект без workspace → 400 MEMORY_WORKSPACE_REQUIRED', async () => {
    const { app, calls } = createApp({ projects: { 'p-1': {} } });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      projectId: 'p-1',
      source: { kind: 'files' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('MEMORY_WORKSPACE_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('scope=instance при отказе в правах → 202 (ACL проекта не применяется)', async () => {
    const { app, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', {
      scope: 'instance',
      source: { kind: 'facts' },
    });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(aclCalls()).toBe(0);
  });

  it('scope=project (по умолчанию) при отказе в правах → 403 FORBIDDEN', async () => {
    const { app, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(0);
    expect(aclCalls()).toBe(1);
  });

  it('scope=project (явно) — поведение прежнее: проект обязателен, ACL применяется', async () => {
    const { app, calls, aclCalls } = createApp({ projects: PROJECTS });
    const withoutProject = await post(app, '/api/v2/memory/indexes', { scope: 'project' });
    expect(withoutProject.status).toBe(400);
    expect((await json(withoutProject)).error.code).toBe('MEMORY_PROJECT_REQUIRED');

    const unknownProject = await post(app, '/api/v2/memory/indexes', {
      scope: 'project',
      projectId: 'p-nope',
    });
    expect(unknownProject.status).toBe(404);
    expect((await json(unknownProject)).error.code).toBe('PROJECT_NOT_FOUND');

    expect(calls).toHaveLength(0);
    expect(aclCalls()).toBe(0);
  });

  it('scope=project (по умолчанию) — в тул уходит scope=project? Нет: дефолт плагина', async () => {
    const { app, calls } = createApp({ projects: PROJECTS });
    const res = await post(app, '/api/v2/memory/indexes', { projectId: 'p-1' });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.index.scope).toBe('project');
    const [call] = calls;
    // Проектный индекс — поведение плагина по умолчанию, `scope` не передаётся.
    expect(call?.params.scope).toBeUndefined();
    expect(call?.params.projectId).toBe('p-1');
  });

  it('неизвестный scope в теле → 400 VALIDATION_ERROR', async () => {
    const { app, calls } = createApp({ projects: PROJECTS });
    for (const scope of ['bogus', 'PROJECT', 1, true, {}]) {
      const res = await post(app, '/api/v2/memory/indexes', { scope, projectId: 'p-1' });
      expect(res.status, JSON.stringify(scope)).toBe(400);
      expect((await json(res)).error.code, JSON.stringify(scope)).toBe('VALIDATION_ERROR');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('createMemoryRoutes — список индексов: фильтр scope', () => {
  it('GET /indexes?scope=instance — фильтр уходит в порт', async () => {
    const { app, storage } = createApp({ projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-project', scope: 'project' }));
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-instance', scope: 'instance' }));

    const spy = vi.spyOn(storage.memoryIndexes, 'listIndexes');
    const res = await app.request('/api/v2/memory/indexes?scope=instance');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: 'instance' }));
    const body = await json(res);
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('i-instance');
    // Область видимости — в ответе.
    expect(body.items[0].scope).toBe('instance');
  });

  it('GET /indexes?scope=project — фильтр уходит в порт', async () => {
    const { app, storage } = createApp({ projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-project', scope: 'project' }));
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-instance', scope: 'instance' }));

    const spy = vi.spyOn(storage.memoryIndexes, 'listIndexes');
    const res = await app.request('/api/v2/memory/indexes?scope=project');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project' }));
    const body = await json(res);
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('i-project');
  });

  it('GET /indexes без scope — без фильтра (обе области видны)', async () => {
    const { app, storage } = createApp({ projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-project', scope: 'project' }));
    await storage.memoryIndexes.saveIndex(makeIndex({ id: 'i-instance', scope: 'instance' }));

    const spy = vi.spyOn(storage.memoryIndexes, 'listIndexes');
    const res = await app.request('/api/v2/memory/indexes');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({ scope: expect.anything() }));
    const body = await json(res);
    expect(body.total).toBe(2);
  });

  it('GET /indexes?scope=instance&projectId= — фильтр projectId работает как раньше', async () => {
    const { app, storage } = createApp({ projects: PROJECTS });
    // Инстансный индекс с source-проектом — projectId-фильтр совпадёт (осознанно).
    await storage.memoryIndexes.saveIndex(
      makeIndex({ id: 'i-instance', scope: 'instance', projectId: 'p-1' }),
    );
    const res = await app.request('/api/v2/memory/indexes?scope=instance&projectId=p-1');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('i-instance');
  });

  it('GET /indexes?scope=bogus → 400 VALIDATION_ERROR', async () => {
    const { app } = createApp({ projects: PROJECTS });
    for (const scope of ['bogus', 'instance%20x']) {
      const res = await app.request(`/api/v2/memory/indexes?scope=${scope}`);
      expect(res.status, scope).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('createMemoryRoutes — инстансный индекс: rebuild/delete', () => {
  it('rebuild инстансного индекса — ACL не вызывается, тул получил action/indexId', async () => {
    const { app, storage, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(
      makeIndex({ id: 'i-1', scope: 'instance', source: { kind: 'facts' } }),
    );
    const res = await post(app, '/api/v2/memory/indexes/i-1/rebuild', { force: true });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.index.scope).toBe('instance');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params.action).toBe('rebuild');
    expect(call?.params.indexId).toBe('i-1');
    expect(call?.params.force).toBe(true);
    // Инстансный индекс без проекта: проект не передаётся, каталог данных.
    expect(call?.projectId).toBeUndefined();
    expect(call?.workingDir).toBe(DATA_DIR);
    expect(aclCalls()).toBe(0);
  });

  it('rebuild инстансного индекса по файлам — workspace источника корпуса', async () => {
    const { app, storage, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(
      makeIndex({
        id: 'i-1',
        scope: 'instance',
        projectId: 'p-1',
        source: { kind: 'files' },
      }),
    );
    const res = await post(app, '/api/v2/memory/indexes/i-1/rebuild', {});
    expect(res.status).toBe(202);
    const [call] = calls;
    expect(call?.workingDir).toBe(WORKSPACE);
    expect(aclCalls()).toBe(0);
  });

  it('rebuild инстансного индекса по файлам: проект-источник исчез → 404 PROJECT_NOT_FOUND', async () => {
    const { app, storage, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(
      makeIndex({
        id: 'i-1',
        scope: 'instance',
        projectId: 'p-nope',
        source: { kind: 'files' },
      }),
    );
    const res = await post(app, '/api/v2/memory/indexes/i-1/rebuild', {});
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('PROJECT_NOT_FOUND');
    expect(calls).toHaveLength(0);
    expect(aclCalls()).toBe(0);
  });

  it('delete инстансного индекса — ACL не вызывается, тул получил action/indexId', async () => {
    const { app, storage, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(
      makeIndex({ id: 'i-1', scope: 'instance', source: { kind: 'facts' } }),
    );
    const res = await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params.action).toBe('delete');
    expect(call?.params.indexId).toBe('i-1');
    expect(aclCalls()).toBe(0);
  });

  it('rebuild/delete проектного индекса — ACL применяется (403 при отказе)', async () => {
    const { app, storage, calls, aclCalls } = createApp({ access: false, projects: PROJECTS });
    await storage.memoryIndexes.saveIndex(
      makeIndex({ id: 'i-1', scope: 'project', projectId: 'p-1' }),
    );
    const rebuild = await post(app, '/api/v2/memory/indexes/i-1/rebuild', {});
    expect(rebuild.status).toBe(403);
    expect((await json(rebuild)).error.code).toBe('FORBIDDEN');
    const remove = await app.request('/api/v2/memory/indexes/i-1', { method: 'DELETE' });
    expect(remove.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(aclCalls()).toBe(2);
  });
});
