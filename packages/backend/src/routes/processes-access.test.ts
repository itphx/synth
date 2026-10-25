/**
 * Managed-доступ к единому реестру фоновых прогонов (PROP-096/097).
 *
 * Ресурс — не сессия, а запись реестра, поэтому матрица сессий
 * (`session-idor-matrix.test.ts`) здесь неприменима: своя матрица.
 *
 * Правило (ADR-089 §5.5/§5.8 + инвариант 21): право на прогон — право на его
 * **сессию-владельца**:
 *
 * | Актор                          | чтение | stop/delete |
 * |--------------------------------|--------|-------------|
 * | владелец сессии                | да     | да          |
 * | `ADMIN`                        | да     | да          |
 * | `LEAD`                         | да     | да          |
 * | участник проекта (`VIEWER`)    | да     | **403**     |
 * | участник проекта (`EDITOR`)    | да     | да          |
 * | владелец проекта               | да     | да          |
 * | чужой `USER`                   | **403**| **403**     |
 *
 * Тест идёт по **реально смонтированному** backend-приложению
 * (`createBackendApp`): цель — ловить ослабление правил (сняли проверку
 * владельца/роли — тест красный), а не «фабрика позвали». Правило доступа
 * берётся из production-модуля `routes/processes.ts` — тот же, что монтирует
 * `mount-routes.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackgroundRunService,
  EventBus,
  MemoryBackgroundRunRepository,
  ProjectStore,
  createProcessRoutes,
} from '@itphx/synth-core';
import type { ProcessService, SessionManager } from '@itphx/synth-core';
import { ProjectRole } from '@itphx/synth-shared';
import type { BackgroundRunRecord, Project, User } from '@itphx/synth-shared';
import { createBackendProcessAccess } from './processes.js';
import type { AuthKit } from '../auth/middleware.js';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

// ---------------------------------------------------------------------------
// Акторы и мок-AuthKit
// ---------------------------------------------------------------------------

type MockUser = User & { roles: string[] };

const USERS: Record<string, MockUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MockUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MockUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MockUser,
  projectOwner: { id: 'projectOwner', username: 'projectOwner', roles: ['USER'] } as MockUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MockUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MockUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MockUser,
};

function userFromHeader(header: string | undefined): MockUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

/** Мок-AuthKit: пользователь из `Authorization`, роли из фикстуры. */
function createMockKit() {
  const requireAuth = async (c: Context, next: Next) => {
    const user = userFromHeader(c.req.header('Authorization'));
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
    c.set('user' as never, user as never);
    await next();
  };
  return {
    requireAuth,
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const user = c.get('user') as MockUser | undefined;
      if (!user || !roles.some((r) => user.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);
      }
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  };
}

// ---------------------------------------------------------------------------
// Песочница
// ---------------------------------------------------------------------------

/** Запись реестра для тестов. */
function run(id: string, overrides: Partial<BackgroundRunRecord> = {}): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 'session-owner',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('backend: доступ к реестру фоновых прогонов (PROP-096/097)', () => {
  let tmpDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-processes-'));
    backend = await createBackendApp({
      dataDir: tmpDir,
      authDebug: true,
      env: { SYNTH_METRICS_ENABLED: 'false' },
    });
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    backend.stopWebhookService();
    backend.stopWebhookDeliveryPruner();
    backend.stopMetrics();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * Песочница managed-контура: та же фабрика core и то же правило доступа,
   * что монтирует `mount-routes.ts` (модуль `routes/processes.ts`).
   */
  async function createSandbox() {
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const project: Project = await projectStore.create('Shared', 'projectOwner');
    project.members['viewer'] = ProjectRole.VIEWER;
    project.members['editor'] = ProjectRole.EDITOR;
    await projectStore.save(project);

    const backgroundRuns = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    const background = new BackgroundRunService({
      repository: backgroundRuns,
      eventBus,
      limits: {
        maxSubagentsPerSession: 5,
        maxProcessesPerSession: 5,
        maxRunsPerSession: 20,
      },
    });
    // Чтение лога в матрице доступа не участвует — достаточно заглушки.
    const processes = { logs: async () => null } as unknown as ProcessService;

    const sessions = new Map<string, { id: string; ownerId?: string; projectId?: string }>([
      ['session-owner', { id: 'session-owner', ownerId: 'owner', projectId: project.id }],
      ['session-stranger', { id: 'session-stranger', ownerId: 'stranger' }],
    ]);
    const sessionManager = {
      getSession: async (id: string) => (sessions.get(id) ?? null) as never,
    } as unknown as Pick<SessionManager, 'getSession'>;

    const kit = createMockKit();
    const app = new Hono();
    app.use('*', async (c, next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (user) c.set('user' as never, user as never);
      await next();
    });
    app.route(
      '/api/v2/processes',
      createProcessRoutes(
        { requireAuth: kit.requireAuth },
        { backgroundRuns, background, processes, sessionManager },
        {
          isAllowed: createBackendProcessAccess({
            auth: kit as unknown as AuthKit,
            projectStore,
          }),
          resolveUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
        },
      ),
    );

    return { app, backgroundRuns, background };
  }

  const req = (
    app: Hono,
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      }),
    );

  // ─────────────────────────── матрица доступа ───────────────────────────

  it('владелец сессии — читает прогон и останавливает его', async () => {
    const { app, backgroundRuns, background } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));
    background.registerAbort('bgr_owner', () => undefined);

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'owner');
    expect(detail.status).toBe(200);

    const stop = await req(app, '/api/v2/processes/bgr_owner/stop', 'owner', { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { status: string }).status).toBe('stopping');
  });

  it('участник проекта с ролью VIEWER — читает, но не останавливает и не удаляет', async () => {
    const { app, backgroundRuns } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'viewer');
    expect(detail.status).toBe(200);

    const stop = await req(app, '/api/v2/processes/bgr_owner/stop', 'viewer', { method: 'POST' });
    expect(stop.status).toBe(403);
    expect(((await stop.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const remove = await req(app, '/api/v2/processes/bgr_owner', 'viewer', { method: 'DELETE' });
    expect(remove.status).toBe(403);
  });

  it('участник проекта с ролью EDITOR — читает и останавливает', async () => {
    const { app, backgroundRuns, background } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));
    background.registerAbort('bgr_owner', () => undefined);

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'editor');
    expect(detail.status).toBe(200);

    const stop = await req(app, '/api/v2/processes/bgr_owner/stop', 'editor', { method: 'POST' });
    expect(stop.status).toBe(200);
  });

  it('владелец проекта — читает и останавливает прогон своей сессии', async () => {
    const { app, backgroundRuns, background } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));
    background.registerAbort('bgr_owner', () => undefined);

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'projectOwner');
    expect(detail.status).toBe(200);

    const stop = await req(app, '/api/v2/processes/bgr_owner/stop', 'projectOwner', { method: 'POST' });
    expect(stop.status).toBe(200);
  });

  it('ADMIN — сквозной доступ к чужому прогону', async () => {
    const { app, backgroundRuns } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'admin');
    expect(detail.status).toBe(200);

    const remove = await req(app, '/api/v2/processes/bgr_owner', 'admin', { method: 'DELETE' });
    // Прогон идёт → удаление запрещено (409), но право доступа есть.
    expect(remove.status).toBe(409);
  });

  it('LEAD — сквозной доступ к содержимому проекта', async () => {
    const { app, backgroundRuns } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));

    const detail = await req(app, '/api/v2/processes/bgr_owner', 'lead');
    expect(detail.status).toBe(200);
  });

  it('чужой USER — 403 на всех маршрутах ресурса', async () => {
    const { app, backgroundRuns } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));

    expect((await req(app, '/api/v2/processes/bgr_owner', 'stranger')).status).toBe(403);
    expect((await req(app, '/api/v2/processes/bgr_owner/logs', 'stranger')).status).toBe(403);
    expect((await req(app, '/api/v2/processes/bgr_owner/stop', 'stranger', { method: 'POST' })).status)
      .toBe(403);
    expect((await req(app, '/api/v2/processes/bgr_owner', 'stranger', { method: 'DELETE' })).status)
      .toBe(403);
  });

  it('список — чужие прогоны не видны, свои видны', async () => {
    const { app, backgroundRuns } = await createSandbox();
    await backgroundRuns.save(run('bgr_owner'));
    await backgroundRuns.save(run('bgr_stranger', { sessionId: 'session-stranger' }));

    const own = await req(app, '/api/v2/processes', 'owner');
    const ownBody = (await own.json()) as { runs: BackgroundRunRecord[] };
    expect(ownBody.runs.map((r) => r.id)).toEqual(['bgr_owner']);

    const stranger = await req(app, '/api/v2/processes', 'stranger');
    const strangerBody = (await stranger.json()) as { runs: BackgroundRunRecord[] };
    expect(strangerBody.runs.map((r) => r.id)).toEqual(['bgr_stranger']);
  });

  it('без аутентификации — 401', async () => {
    const { app } = await createSandbox();
    const res = await app.request('/api/v2/processes');
    expect(res.status).toBe(401);
  });

  // ─────────────────────────── монтирование в backend ───────────────────────────

  it('контур смонтирован в backend (/api/v2/processes отвечает)', async () => {
    const res = await backend.app.request('/api/v2/processes', {
      headers: { Authorization: 'Bearer admin-key-123' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: BackgroundRunRecord[] };
    expect(Array.isArray(body.runs)).toBe(true);
  });
});
