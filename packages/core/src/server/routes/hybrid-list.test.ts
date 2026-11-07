// Гибридный merge списков (ADR-042 + ADR-118 §4): страница `GET /sessions`,
// `GET /projects` и история `GET /sessions/:id/messages` в режиме «локальный
// core + удалённый backend».
//
// Проверяется:
// - объединение обоих миров **до** нарезки страницы (общий порядок по времени);
// - `next_offset` в merged-списке (раньше всегда был `null` при наличии
//   удалённых записей);
// - нарезка истории удалённой сессии, когда старый сервер отдал **всю**
//   историю вместо страницы.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createSessionRoutes } from './sessions.js';
import { createProjectRoutes } from './projects.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { RemoteAllList } from '../../remote/client.js';

function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

/** Мок удалённого клиента: списки по умолчанию пустые. */
function makeRemote(overrides: Partial<RemoteBackendClient>): RemoteBackendClient {
  const base = {
    listAllSessions: async (): Promise<RemoteAllList> => ({ items: [], total: 0, truncated: false }),
    listAllProjects: async (): Promise<RemoteAllList> => ({ items: [], total: 0, truncated: false }),
    getSessionMessages: async (): Promise<{ messages: Array<Record<string, unknown>> }> => ({ messages: [] }),
  };
  return { ...base, ...overrides } as unknown as RemoteBackendClient;
}

interface SessionListPage {
  sessions: Array<{ id?: string; origin?: string; updated_at?: string }>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

interface ProjectListPage {
  projects: Array<{ id?: string; origin?: string }>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

interface MessagePage {
  messages: Array<{ id?: string; seq?: number }>;
  session_id: string;
  has_more: boolean;
  next_before: number | null;
}

describe('Гибрид: merge списков и пагинация', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-hybrid-list-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Приложение сессий с подключённым удалённым миром. */
  function makeSessionApp(remote: RemoteBackendClient): {
    app: Hono;
    sessionManager: SessionManager;
  } {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();
    app.route(
      '/api/v2/sessions',
      createSessionRoutes(
        createMockAuth() as never,
        {
          sessionManager,
          eventBus: new EventBus(),
          queueManager: queueManager as never,
          processMessage: orchestrator.createProcessMessage(),
          orchestrator: orchestrator as never,
          projectStore: new ProjectStore({ dataDir: tmpDir }),
          getRemoteClient: () => remote,
        },
        {},
      ),
    );
    return { app, sessionManager };
  }

  /** Приложение проектов с подключённым удалённым миром. */
  function makeProjectApp(remote: RemoteBackendClient): { app: Hono; store: ProjectStore } {
    const app = new Hono();
    const store = new ProjectStore({ dataDir: tmpDir });
    app.route(
      '/api/v2/projects',
      createProjectRoutes(createMockAuth() as never, store, () => remote, {}),
    );
    return { app, store };
  }

  /** Локальная сессия с заданным временем обновления. */
  async function seedSession(
    sessionManager: SessionManager,
    title: string,
    updatedAt: string,
  ): Promise<string> {
    const session = await sessionManager.createSession({ title, userId: 'local' });
    session.updatedAt = updatedAt;
    await sessionManager.saveSession(session);
    return session.id;
  }

  it('сессии: оба мира объединяются и сортируются по времени (новые сверху)', async () => {
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [
          { id: 'r-new', updated_at: '2026-01-03T00:00:00.000Z' },
          { id: 'r-old', updated_at: '2026-01-01T00:00:00.000Z' },
        ],
        total: 2,
        truncated: false,
      }),
    });
    const { app, sessionManager } = makeSessionApp(remote);
    await seedSession(sessionManager, 'Локальная', '2026-01-02T00:00:00.000Z');

    const res = await app.request('/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionListPage;
    expect(body.sessions.map((s) => s.id)).toEqual(['remote:r-new', body.sessions[1]!.id, 'remote:r-old']);
    expect(body.sessions[0]!.origin).toBe('remote');
    expect(body.sessions[1]!.origin).toBe('local');
    expect(body.sessions[2]!.origin).toBe('remote');
    expect(body.total).toBe(3);
  });

  it('сессии: при равном времени локальная запись идёт раньше удалённой', async () => {
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [{ id: 'r-1', updated_at: '2026-01-02T00:00:00.000Z' }],
        total: 1,
        truncated: false,
      }),
    });
    const { app, sessionManager } = makeSessionApp(remote);
    const localId = await seedSession(sessionManager, 'Локальная', '2026-01-02T00:00:00.000Z');

    const body = (await (await app.request('/api/v2/sessions')).json()) as SessionListPage;
    expect(body.sessions.map((s) => s.id)).toEqual([localId, 'remote:r-1']);
  });

  it('сессии: next_offset не null, пока merged-список не кончился', async () => {
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [
          { id: 'r-1', updated_at: '2026-01-03T00:00:00.000Z' },
          { id: 'r-2', updated_at: '2026-01-02T00:00:00.000Z' },
        ],
        total: 2,
        truncated: false,
      }),
    });
    const { app, sessionManager } = makeSessionApp(remote);
    await seedSession(sessionManager, 'Локальная', '2026-01-04T00:00:00.000Z');
    await seedSession(sessionManager, 'Локальная 2', '2026-01-01T00:00:00.000Z');

    const first = (await (await app.request('/api/v2/sessions?limit=2')).json()) as SessionListPage;
    expect(first.sessions).toHaveLength(2);
    expect(first.total).toBe(4);
    expect(first.next_offset).toBe(2);

    const second = (await (await app.request('/api/v2/sessions?limit=2&offset=2')).json()) as SessionListPage;
    expect(second.sessions).toHaveLength(2);
    expect(second.next_offset).toBeNull();
  });

  it('сессии: старый удалённый сервер (массив) — merge работает, next_offset выдаётся', async () => {
    // Старый сервер отдаёт массив: клиент нормализует его в полный список.
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [
          { id: 'r-1', updated_at: '2026-01-02T00:00:00.000Z' },
          { id: 'r-2', updated_at: '2026-01-01T00:00:00.000Z' },
        ],
        total: 2,
        truncated: false,
      }),
    });
    const { app, sessionManager } = makeSessionApp(remote);
    await seedSession(sessionManager, 'Локальная', '2026-01-03T00:00:00.000Z');

    const body = (await (await app.request('/api/v2/sessions?limit=2')).json()) as SessionListPage;
    expect(body.sessions).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.next_offset).toBe(2);
  });

  it('сессии: обрезанный удалённый список (кап страниц) → next_offset = null', async () => {
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [{ id: 'r-1', updated_at: '2026-01-02T00:00:00.000Z' }],
        total: 1000,
        truncated: true,
      }),
    });
    const { app } = makeSessionApp(remote);

    const body = (await (await app.request('/api/v2/sessions')).json()) as SessionListPage;
    expect(body.sessions).toHaveLength(1);
    expect(body.next_offset).toBeNull();
  });

  it('сессии: фильтр по удалённому проекту — только его сессии', async () => {
    const remote = makeRemote({
      listAllSessions: async () => ({
        items: [
          { id: 'r-1', project_id: 'p-1', updated_at: '2026-01-02T00:00:00.000Z' },
          { id: 'r-2', project_id: 'p-2', updated_at: '2026-01-01T00:00:00.000Z' },
        ],
        total: 2,
        truncated: false,
      }),
    });
    const { app } = makeSessionApp(remote);

    const body = (await (await app.request('/api/v2/sessions?project_id=remote:p-1')).json()) as SessionListPage;
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe('remote:r-1');
  });

  it('проекты: оба мира объединяются, next_offset выдаётся', async () => {
    const remote = makeRemote({
      listAllProjects: async () => ({
        items: [{ id: 'r-1', updated_at: '2026-01-03T00:00:00.000Z' }],
        total: 1,
        truncated: false,
      }),
    });
    const { app, store } = makeProjectApp(remote);
    const local = store.create('Локальный', 'local');
    local.updatedAt = '2026-01-02T00:00:00.000Z';
    await store.save(local);

    const body = (await (await app.request('/api/v2/projects')).json()) as ProjectListPage;
    expect(body.projects.map((p) => p.id)).toEqual(['remote:r-1', local.id]);
    expect(body.projects[0]!.origin).toBe('remote');
    expect(body.projects[1]!.origin).toBe('local');
    expect(body.total).toBe(2);
    expect(body.next_offset).toBeNull();

    // Ограничение страницы → курсор по merged-списку.
    const limited = (await (await app.request('/api/v2/projects?limit=1')).json()) as ProjectListPage;
    expect(limited.projects).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(limited.next_offset).toBe(1);
  });

  it('проекты: обрезанный удалённый список (кап страниц) → next_offset = null', async () => {
    const remote = makeRemote({
      listAllProjects: async () => ({
        items: [{ id: 'r-1' }],
        total: 1000,
        truncated: true,
      }),
    });
    const { app } = makeProjectApp(remote);

    const body = (await (await app.request('/api/v2/projects')).json()) as ProjectListPage;
    expect(body.next_offset).toBeNull();
  });

  describe('история удалённой сессии', () => {
    /** Удалённая сессия с историей из `count` сообщений (seq 1..count). */
    function historyMessages(count: number): Array<Record<string, unknown>> {
      return Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1 }));
    }

    it('старый сервер отдал всю историю — нарезка по limit делается локально', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: historyMessages(5),
          session_id: 's-remote',
        }),
      });
      const { app } = makeSessionApp(remote);

      const body = (await (await app.request('/api/v2/sessions/remote:s-remote/messages?limit=2')).json()) as MessagePage;
      expect(body.messages.map((m) => m.seq)).toEqual([4, 5]);
      expect(body.has_more).toBe(true);
      expect(body.next_before).toBe(4);
      expect(body.session_id).toBe('remote:s-remote');
    });

    it('старый сервер отдал всю историю — фильтр before применяется локально', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: historyMessages(5),
          session_id: 's-remote',
        }),
      });
      const { app } = makeSessionApp(remote);

      const body = (await (await app.request('/api/v2/sessions/remote:s-remote/messages?limit=10&before=3')).json()) as MessagePage;
      expect(body.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(body.has_more).toBe(false);
      expect(body.next_before).toBeNull();
    });

    it('новый сервер вернул страницу — его has_more/next_before сохраняются', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: historyMessages(5).slice(3),
          session_id: 's-remote',
          has_more: true,
          next_before: 4,
        }),
      });
      const { app } = makeSessionApp(remote);

      const body = (await (await app.request('/api/v2/sessions/remote:s-remote/messages?limit=2')).json()) as MessagePage;
      expect(body.messages.map((m) => m.seq)).toEqual([4, 5]);
      expect(body.has_more).toBe(true);
      expect(body.next_before).toBe(4);
    });

    it('новый сервер: страница с дублями seq не пересортировывается, метаданные сохраняются', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: [
            { id: 'a', seq: 5 },
            { id: 'b', seq: 0 },
            { id: 'c', seq: 5 },
          ],
          session_id: 's-remote',
          has_more: true,
          next_before: 3,
        }),
      });
      const { app } = makeSessionApp(remote);

      const body = (await (await app.request('/api/v2/sessions/remote:s-remote/messages?limit=10')).json()) as MessagePage;
      // Порядок сервера сохранён (по `seq` не сортируем — дубли перемешались бы).
      expect(body.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(body.has_more).toBe(true);
      expect(body.next_before).toBe(3);
    });

    it('старый сервер: дубли seq, но абсолютный index — нарезка по index без пустых страниц', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: [
            { id: 'm1', seq: 0, index: 0 },
            { id: 'm2', seq: 0, index: 1 },
            { id: 'm3', seq: 0, index: 2 },
            { id: 'm4', seq: 1, index: 3 },
            { id: 'm5', seq: 2, index: 4 },
            { id: 'm6', seq: 3, index: 5 },
          ],
          session_id: 's-remote',
        }),
      });
      const { app } = makeSessionApp(remote);

      const pages: string[][] = [];
      let before: number | undefined;
      for (let step = 0; step < 6; step += 1) {
        const query = before === undefined ? '?limit=2' : `?limit=2&before=${before}`;
        const body = (await (await app.request(`/api/v2/sessions/remote:s-remote/messages${query}`)).json()) as MessagePage;
        expect(body.messages.length).toBeGreaterThan(0);
        pages.push(body.messages.map((m) => String(m.id)));
        if (!body.has_more || body.next_before === null) break;
        before = body.next_before;
      }

      expect(pages.flat()).toEqual(['m5', 'm6', 'm3', 'm4', 'm1', 'm2']);
      expect(pages).toHaveLength(3);
    });

    it('новая страница сервера без has_more — has_more=false, next_before=null', async () => {
      const remote = makeRemote({
        getSessionMessages: async () => ({
          messages: historyMessages(2),
          session_id: 's-remote',
        }),
      });
      const { app } = makeSessionApp(remote);

      const body = (await (await app.request('/api/v2/sessions/remote:s-remote/messages?limit=10')).json()) as MessagePage;
      expect(body.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(body.has_more).toBe(false);
      expect(body.next_before).toBeNull();
    });
  });
});
