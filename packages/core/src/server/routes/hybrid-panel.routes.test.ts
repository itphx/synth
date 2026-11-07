/**
 * Гибрид (ADR-042): правая панель — память, MCP, скиллы, worktrees и
 * автоматизация (пайплайны) удалённых сущностей.
 *
 * Проверяется, что remote-ветки роутов:
 * - проксируют запрос в `RemoteBackendClient` (пути/параметры — без `remote:`);
 * - переписывают id ответа в `remote:` (индексы, пайплайны, прогоны);
 * - без клиента отвечают 502 `REMOTE_UNAVAILABLE`;
 * - для локальных id работают по-прежнему (локальный стор, клиент не зовётся).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { Project } from '@itphx/synth-shared';
import { createSessionRoutes } from './sessions.js';
import { createProjectRoutes } from './projects.js';
import { createProjectSkillScopeRoutes } from './skill-scope.js';
import { createPipelineProjectRoutes } from './pipeline-project-routes.js';
import { createMemoryRoutes } from './memory.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import {
  MemoryProjectPipelineRepository,
  MemoryPipelineRunRepository,
} from '../../storage/memory/pipelines.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

/** Имена методов клиента, которые подменяет фейк (все — шпионы). */
type FakeRemoteMethod =
  | 'getSessionMemory'
  | 'getProjectMcp' | 'updateProjectMcp'
  | 'getProjectSkills' | 'updateProjectSkills'
  | 'listProjectWorktrees' | 'createProjectWorktree'
  | 'pruneProjectWorktrees' | 'removeProjectWorktree'
  | 'listProjectPipelines' | 'createProjectPipeline' | 'getProjectPipeline'
  | 'updateProjectPipeline' | 'deleteProjectPipeline' | 'publishProjectPipeline'
  | 'listPipelineRuns' | 'startPipelineRun' | 'getPipelineRun'
  | 'resumePipelineRun' | 'cancelPipelineRun'
  | 'listPipelineTemplates' | 'instantiatePipelineTemplate'
  | 'createMemoryIndex' | 'updateMemoryIndex' | 'rebuildMemoryIndex' | 'deleteMemoryIndex';

/** Тип фейкового клиента: набор шпионов (зовётся через каст к контракту). */
type FakeRemote = Record<FakeRemoteMethod, ReturnType<typeof vi.fn>>;

/** Фейковый клиент: все методы — шпионы, ответы задаёт тест. */
function createFakeRemote(overrides: Record<string, unknown> = {}): FakeRemote {
  const fake = {
    getSessionMemory: vi.fn(),
    getProjectMcp: vi.fn(),
    updateProjectMcp: vi.fn(),
    getProjectSkills: vi.fn(),
    updateProjectSkills: vi.fn(),
    listProjectWorktrees: vi.fn(),
    createProjectWorktree: vi.fn(),
    pruneProjectWorktrees: vi.fn(),
    removeProjectWorktree: vi.fn(),
    listProjectPipelines: vi.fn(),
    createProjectPipeline: vi.fn(),
    getProjectPipeline: vi.fn(),
    updateProjectPipeline: vi.fn(),
    deleteProjectPipeline: vi.fn(),
    publishProjectPipeline: vi.fn(),
    listPipelineRuns: vi.fn(),
    startPipelineRun: vi.fn(),
    getPipelineRun: vi.fn(),
    resumePipelineRun: vi.fn(),
    cancelPipelineRun: vi.fn(),
    listPipelineTemplates: vi.fn(),
    instantiatePipelineTemplate: vi.fn(),
    createMemoryIndex: vi.fn(),
    updateMemoryIndex: vi.fn(),
    rebuildMemoryIndex: vi.fn(),
    deleteMemoryIndex: vi.fn(),
    ...overrides,
  };
  return fake;
}

/** Фейковый клиент как контракт `RemoteBackendClient` (для роутов). */
function asClient(remote: FakeRemote | null): RemoteBackendClient | null {
  return remote as unknown as RemoteBackendClient | null;
}

/** Тестовый проект (локальный). */
function project(id = 'p1'): Project {
  return {
    id,
    name: 'P',
    ownerId: 'local',
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    mcp: { enabled: [], defaultOn: [] },
    skills: { enabled: ['s1'], defaultOn: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('Гибрид: правая панель (remote-ветки роутов)', () => {
  let root: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-hybrid-panel-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: root }));
    projectStore = new ProjectStore({ dataDir: root });
    eventBus = new EventBus();
    await projectStore.save(project());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Приложение сессий (память сессии). */
  function sessionsApp(remote: FakeRemote | null): Hono {
    const app = new Hono();
    app.route('/api/v2/sessions', createSessionRoutes(createMockAuth() as never, {
      sessionManager,
      eventBus,
      queueManager: { isRunning: () => false, stop: () => {}, requestStop: () => false } as never,
      processMessage: (async () => undefined) as never,
      orchestrator: {
        createProcessMessage: () => async () => undefined,
        cancel: () => {},
        getPromptInfo: async () => ({}),
        getModelPricing: () => null,
      } as never,
      projectStore,
      getRemoteClient: () => asClient(remote),
    }));
    return app;
  }

  /** Приложение проектов (MCP + worktrees). */
  function projectsApp(remote: FakeRemote | null): Hono {
    const worktrees = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      prune: vi.fn(async () => ({ recordsRemoved: 0, gitPruned: false })),
      remove: vi.fn(),
    };
    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(
      createMockAuth() as never,
      projectStore,
      remote ? () => asClient(remote) : undefined,
      {
        getMcpServers: () => ['local-srv'],
        // PROP-125: источник сервера (`local`/`server`).
        getMcpServerSources: () => ({ 'local-srv': 'local' }),
        worktrees: worktrees as never,
      },
    ));
    return app;
  }

  /** Приложение проектного скоупа скиллов. */
  function skillsApp(remote: FakeRemote | null): Hono {
    const app = new Hono();
    app.route('/api/v2/projects', createProjectSkillScopeRoutes(
      createMockAuth() as never,
      { sessionManager, projectStore },
      { getRemoteClient: () => asClient(remote) },
    ));
    return app;
  }

  /** Приложение пайплайнов проекта/прогонов/шаблонов. */
  function pipelinesApp(remote: FakeRemote | null): Hono {
    const app = new Hono();
    app.route('/api/v2', createPipelineProjectRoutes(
      createMockAuth() as never,
      {
        pipelines: new MemoryProjectPipelineRepository(),
        runs: new MemoryPipelineRunRepository(),
        engine: {} as never,
        projects: projectStore,
        getRemoteClient: () => asClient(remote),
      },
    ));
    return app;
  }

  /** Приложение портала памяти (мутации индексов). */
  function memoryApp(remote: FakeRemote | null, indexes?: unknown): Hono {
    const app = new Hono();
    app.route('/api/v2/memory', createMemoryRoutes(
      { requireAuth: createMockAuth().requireAuth } as never,
      {
        ...(indexes ? { memory: { indexes: indexes as never } } : {}),
        isPluginActive: () => true,
        getRemoteClient: () => asClient(remote),
      },
    ));
    return app;
  }

  // ─────────────── Память сессии ───────────────

  describe('GET /sessions/:id/memory', () => {
    it('remote: проксирует и переписывает scope/индексы в remote:', async () => {
      const remote = createFakeRemote();
      remote.getSessionMemory.mockResolvedValue({
        provider: { active: true },
        scope: { projectId: 'p1' },
        indexes: { total: 1, items: [{ id: 'idx-1', projectId: 'p1', name: 'docs' }] },
        facts: { active: 1 },
        readiness: 'ready',
      });

      const res = await sessionsApp(remote).request('/api/v2/sessions/remote:s1/memory');
      expect(res.status).toBe(200);
      expect(remote.getSessionMemory).toHaveBeenCalledWith('s1');
      const body = (await res.json()) as {
        origin?: string;
        scope?: { projectId?: string };
        indexes: { items: Array<{ id?: string; projectId?: string }> };
      };
      expect(body.origin).toBe('remote');
      expect(body.scope?.projectId).toBe('remote:p1');
      expect(body.indexes.items[0]?.id).toBe('remote:idx-1');
      expect(body.indexes.items[0]?.projectId).toBe('remote:p1');
    });

    it('remote: 404 удалённой стороны пробрасывается', async () => {
      const remote = createFakeRemote();
      remote.getSessionMemory.mockRejectedValue(new RemoteError('не найдено', 'HTTP_404'));
      const res = await sessionsApp(remote).request('/api/v2/sessions/remote:s1/memory');
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('HTTP_404');
    });

    it('remote без клиента → 502 REMOTE_UNAVAILABLE', async () => {
      const res = await sessionsApp(null).request('/api/v2/sessions/remote:s1/memory');
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });

    it('локальный id: прежнее поведение (404 для отсутствующей сессии)', async () => {
      const remote = createFakeRemote();
      const res = await sessionsApp(remote).request('/api/v2/sessions/unknown/memory');
      expect(res.status).toBe(404);
      expect(remote.getSessionMemory).not.toHaveBeenCalled();
    });
  });

  // ─────────────── MCP проекта ───────────────

  describe('GET/PUT /projects/:id/mcp', () => {
    it('remote: GET проксирует, knownServers — из ответа сервера', async () => {
      const remote = createFakeRemote();
      remote.getProjectMcp.mockResolvedValue({ enabled: ['srv'], defaultOn: [], knownServers: ['srv'] });
      const res = await projectsApp(remote).request('/api/v2/projects/remote:p1/mcp');
      expect(res.status).toBe(200);
      expect(remote.getProjectMcp).toHaveBeenCalledWith('p1');
      expect((await res.json()) as unknown).toEqual({ enabled: ['srv'], defaultOn: [], knownServers: ['srv'] });
    });

    it('remote: PUT проксирует тело без префикса', async () => {
      const remote = createFakeRemote();
      remote.updateProjectMcp.mockResolvedValue({ enabled: ['srv'], defaultOn: [], knownServers: ['srv'] });
      const res = await projectsApp(remote).request('/api/v2/projects/remote:p1/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: ['srv'] }),
      });
      expect(res.status).toBe(200);
      expect(remote.updateProjectMcp).toHaveBeenCalledWith('p1', { enabled: ['srv'] });
    });

    it('локальный проект: стор, клиент не зовётся', async () => {
      const remote = createFakeRemote();
      const res = await projectsApp(remote).request('/api/v2/projects/p1/mcp');
      expect(res.status).toBe(200);
      expect(remote.getProjectMcp).not.toHaveBeenCalled();
      expect((await res.json()) as unknown).toEqual({
        enabled: [],
        defaultOn: [],
        knownServers: ['local-srv'],
        // PROP-125: источник сервера — локальный (серверный отдал бы свой).
        sources: { 'local-srv': 'local' },
      });
    });

    it('remote без клиента → 502', async () => {
      const res = await projectsApp(null).request('/api/v2/projects/remote:p1/mcp');
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });

  // ─────────────── Скиллы проекта ───────────────

  describe('GET/PUT /projects/:id/skills', () => {
    it('remote: GET проксирует и переписывает project_id', async () => {
      const remote = createFakeRemote();
      remote.getProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: [], defaultOn: [] });
      const res = await skillsApp(remote).request('/api/v2/projects/remote:p1/skills');
      expect(res.status).toBe(200);
      expect(remote.getProjectSkills).toHaveBeenCalledWith('p1');
      const body = (await res.json()) as { project_id?: string; origin?: string };
      expect(body.project_id).toBe('remote:p1');
      expect(body.origin).toBe('remote');
    });

    it('remote: PUT проксирует тело', async () => {
      const remote = createFakeRemote();
      remote.updateProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: ['s1'], defaultOn: [] });
      const res = await skillsApp(remote).request('/api/v2/projects/remote:p1/skills', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: ['s1'] }),
      });
      expect(res.status).toBe(200);
      expect(remote.updateProjectSkills).toHaveBeenCalledWith('p1', { enabled: ['s1'] });
    });

    it('локальный проект: из стора, клиент не зовётся', async () => {
      const remote = createFakeRemote();
      const res = await skillsApp(remote).request('/api/v2/projects/p1/skills');
      expect(res.status).toBe(200);
      expect(remote.getProjectSkills).not.toHaveBeenCalled();
      const body = (await res.json()) as { project_id?: string; enabled?: string[] };
      expect(body.project_id).toBe('p1');
      expect(body.enabled).toEqual(['s1']);
    });
  });

  // ─────────────── Worktrees ───────────────

  describe('worktrees удалённого проекта', () => {
    it('list/create/prune/delete идут в клиент с локальным id проекта', async () => {
      const remote = createFakeRemote();
      remote.listProjectWorktrees.mockResolvedValue({
        worktrees: [{ id: 'wt-1', projectId: 'p1', attachedSessionId: 's1' }],
      });
      remote.createProjectWorktree.mockResolvedValue({ worktree: { id: 'wt-2', projectId: 'p1' } });
      remote.pruneProjectWorktrees.mockResolvedValue({ recordsRemoved: 1, gitPruned: true });
      remote.removeProjectWorktree.mockResolvedValue(undefined);

      const app = projectsApp(remote);

      const list = await app.request('/api/v2/projects/remote:p1/worktrees');
      expect(list.status).toBe(200);
      expect(remote.listProjectWorktrees).toHaveBeenCalledWith('p1');
      const listBody = (await list.json()) as { worktrees: Array<{ id?: string; projectId?: string; attachedSessionId?: string }> };
      expect(listBody.worktrees[0]?.id).toBe('wt-1');
      expect(listBody.worktrees[0]?.projectId).toBe('remote:p1');
      expect(listBody.worktrees[0]?.attachedSessionId).toBe('remote:s1');

      const create = await app.request('/api/v2/projects/remote:p1/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'feature' }),
      });
      expect(create.status).toBe(201);
      expect(remote.createProjectWorktree).toHaveBeenCalledWith('p1', { branch: 'feature' });
      const createBody = (await create.json()) as { worktree: { id?: string; projectId?: string } };
      expect(createBody.worktree.id).toBe('wt-2');
      expect(createBody.worktree.projectId).toBe('remote:p1');

      const prune = await app.request('/api/v2/projects/remote:p1/worktrees/prune', { method: 'POST' });
      expect(prune.status).toBe(200);
      expect(remote.pruneProjectWorktrees).toHaveBeenCalledWith('p1');

      const del = await app.request('/api/v2/projects/remote:p1/worktrees/wt-1?force=true', {
        method: 'DELETE',
      });
      expect(del.status).toBe(204);
      expect(remote.removeProjectWorktree).toHaveBeenCalledWith('p1', 'wt-1', { force: true });
    });

    it('remote без клиента → 502 на list', async () => {
      const res = await projectsApp(null).request('/api/v2/projects/remote:p1/worktrees');
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });

  // ─────────────── Пайплайны/прогоны/шаблоны ───────────────

  describe('пайплайны удалённого проекта', () => {
    it('список/публикация/запуск проксируются, id — remote:', async () => {
      const remote = createFakeRemote();
      remote.listProjectPipelines.mockResolvedValue({
        pipelines: [{ id: 'pl-1', projectId: 'p1' }],
        total: 1,
        offset: 0,
        limit: 100,
        next_offset: null,
      });
      remote.publishProjectPipeline.mockResolvedValue({ pipeline: { id: 'pl-1', projectId: 'p1' } });
      remote.startPipelineRun.mockResolvedValue({ run: { id: 'run-1', projectId: 'p1', pipelineId: 'pl-1' } });

      const app = pipelinesApp(remote);

      const list = await app.request('/api/v2/projects/remote:p1/pipelines?limit=10');
      expect(list.status).toBe(200);
      expect(remote.listProjectPipelines).toHaveBeenCalledWith('p1', { limit: 10, offset: 0 });
      const listBody = (await list.json()) as { pipelines: Array<{ id?: string; projectId?: string }> };
      expect(listBody.pipelines[0]?.id).toBe('remote:pl-1');
      expect(listBody.pipelines[0]?.projectId).toBe('remote:p1');

      const publish = await app.request('/api/v2/projects/remote:p1/pipelines/remote:pl-1/publish', {
        method: 'POST',
      });
      expect(publish.status).toBe(200);
      expect(remote.publishProjectPipeline).toHaveBeenCalledWith('p1', 'pl-1');
      const publishBody = (await publish.json()) as { pipeline: { id?: string } };
      expect(publishBody.pipeline.id).toBe('remote:pl-1');

      const run = await app.request('/api/v2/projects/remote:p1/pipelines/remote:pl-1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(run.status).toBe(201);
      expect(remote.startPipelineRun).toHaveBeenCalledWith('p1', 'pl-1', {});
      const runBody = (await run.json()) as { run: { id?: string; pipelineId?: string } };
      expect(runBody.run.id).toBe('remote:run-1');
      expect(runBody.run.pipelineId).toBe('remote:pl-1');
    });

    it('GET /pipeline-runs/:runId — remote-прогон проксируется', async () => {
      const remote = createFakeRemote();
      remote.getPipelineRun.mockResolvedValue({
        run: { id: 'run-1', projectId: 'p1', pipelineId: 'pl-1' },
        events: [],
      });
      const res = await pipelinesApp(remote).request('/api/v2/pipeline-runs/remote:run-1');
      expect(res.status).toBe(200);
      expect(remote.getPipelineRun).toHaveBeenCalledWith('run-1', {});
      const body = (await res.json()) as { run: { id?: string } };
      expect(body.run.id).toBe('remote:run-1');
    });

    it('?project_id=remote:… → шаблоны берутся с сервера', async () => {
      const remote = createFakeRemote();
      remote.listPipelineTemplates.mockResolvedValue({ templates: [] });
      const res = await pipelinesApp(remote).request('/api/v2/pipeline-templates?project_id=remote:p1');
      expect(res.status).toBe(200);
      expect(remote.listPipelineTemplates).toHaveBeenCalled();
    });

    it('локальный проект: список из локального порта, клиент не зовётся', async () => {
      const remote = createFakeRemote();
      const res = await pipelinesApp(remote).request('/api/v2/projects/p1/pipelines');
      expect(res.status).toBe(200);
      expect(remote.listProjectPipelines).not.toHaveBeenCalled();
      expect(((await res.json()) as { pipelines: unknown[] }).pipelines).toEqual([]);
    });

    it('remote без клиента → 502 на guard', async () => {
      const res = await pipelinesApp(null).request('/api/v2/projects/remote:p1/pipelines');
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });

  // ─────────────── Портал памяти (мутации индексов) ───────────────

  describe('портал памяти: мутации индексов', () => {
    it('POST /indexes: projectId снимается, id индекса — remote:', async () => {
      const remote = createFakeRemote();
      remote.createMemoryIndex.mockResolvedValue({ index: { id: 'idx-1', projectId: 'p1' }, message: 'ok' });
      const res = await memoryApp(remote).request('/api/v2/memory/indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'docs', source: { kind: 'files' }, projectId: 'remote:p1' }),
      });
      expect(res.status).toBe(202);
      expect(remote.createMemoryIndex).toHaveBeenCalledWith({
        name: 'docs',
        source: { kind: 'files' },
        projectId: 'p1',
      });
      const body = (await res.json()) as { index: { id?: string; projectId?: string } };
      expect(body.index.id).toBe('remote:idx-1');
      expect(body.index.projectId).toBe('remote:p1');
    });

    it('PATCH /indexes/:id — remote id снимается, ответ с префиксом', async () => {
      const remote = createFakeRemote();
      remote.updateMemoryIndex.mockResolvedValue({ index: { id: 'idx-1', projectId: 'p1', enabled: false } });
      const res = await memoryApp(remote).request('/api/v2/memory/indexes/remote:idx-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(remote.updateMemoryIndex).toHaveBeenCalledWith('idx-1', { enabled: false });
      const body = (await res.json()) as { index: { id?: string } };
      expect(body.index.id).toBe('remote:idx-1');
    });

    it('POST /indexes/:id/rebuild и DELETE — remote id снимается', async () => {
      const remote = createFakeRemote();
      remote.rebuildMemoryIndex.mockResolvedValue({ index: { id: 'idx-1' } });
      remote.deleteMemoryIndex.mockResolvedValue(undefined);
      const app = memoryApp(remote);

      const rebuild = await app.request('/api/v2/memory/indexes/remote:idx-1/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(rebuild.status).toBe(202);
      expect(remote.rebuildMemoryIndex).toHaveBeenCalledWith('idx-1', {});

      const del = await app.request('/api/v2/memory/indexes/remote:idx-1', { method: 'DELETE' });
      expect(del.status).toBe(204);
      expect(remote.deleteMemoryIndex).toHaveBeenCalledWith('idx-1');
    });

    it('локальный id: прежняя логика порта (404 для неизвестного индекса)', async () => {
      const remote = createFakeRemote();
      const indexes = { getIndex: vi.fn(async () => null) };
      const res = await memoryApp(remote, indexes).request('/api/v2/memory/indexes/idx-local', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MEMORY_INDEX_NOT_FOUND');
      expect(remote.deleteMemoryIndex).not.toHaveBeenCalled();
    });

    it('remote без клиента → 502', async () => {
      const res = await memoryApp(null).request('/api/v2/memory/indexes/remote:idx-1', {
        method: 'DELETE',
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REMOTE_UNAVAILABLE');
    });
  });
});
