/**
 * Managed-доступ к терминалам (PROP-132, Ф3б).
 *
 * Ресурс — не сессия, а **проектный** терминал, поэтому матрица сессий
 * (`session-idor-matrix.test.ts`) здесь неприменима: своя матрица (как у
 * фоновых прогонов — `processes-access.test.ts`).
 *
 * Правило доступа (ADR-089 §5.5/§5.8 + инвариант 21): право на терминал —
 * право на его **проект**:
 *
 * | Актор                       | чтение | ввод/resize/правка/закрытие |
 * |-----------------------------|---------|-----------------------------|
 * | владелец проекта             | да      | да                          |
 * | участник проекта (`EDITOR`)  | да      | да                          |
 * | участник проекта (`VIEWER`)  | да      | **403**                     |
 * | `ADMIN`/`LEAD`               | да      | да                          |
 * | `AUDITOR`                    | **403** | **403**                     |
 * | чужой `USER`                 | **403** | **403**                     |
 *
 * Проверка — **на границе** (инвариант 16): guard фабрики резолвит терминал и
 * проект ОДИН раз; в обработчиках проверок доступа нет. Правило доступа берётся
 * из production-модуля `routes/projects.ts` (`createProjectAccess`) — тот же,
 * что монтирует `mount-routes.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProjectStore,
  TerminalService,
  createTerminalRoutes,
} from '@itphx/synth-core';
import type { ExecRequest, ExecResult, ExecutionPort, PtyHandle, PtyOpenRequest } from '@itphx/synth-core';
import { ProjectRole } from '@itphx/synth-shared';
import type { Project, User } from '@itphx/synth-shared';
import { createProjectAccess } from './projects.js';
import type { AuthKit } from '../auth/middleware.js';

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
  auditor: { id: 'auditor', username: 'auditor', roles: ['AUDITOR'] } as MockUser,
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
// Эмулятор PTY
// ---------------------------------------------------------------------------

/** Эмулятор PTY-сессии: пишет только то, что в него отправили. */
class FakePtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid = 4242;
  readonly writes: string[] = [];

  private _dataCbs = new Set<(chunk: string) => void>();
  private _exitCbs = new Set<(e: { exitCode?: number; signal?: string }) => void>();

  constructor(id: string) {
    this.id = id;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // размер в тестах не меняется
  }

  onData(cb: (chunk: string) => void): () => void {
    this._dataCbs.add(cb);
    return () => {
      this._dataCbs.delete(cb);
    };
  }

  onExit(cb: (e: { exitCode?: number; signal?: string }) => void): () => void {
    this._exitCbs.add(cb);
    return () => {
      this._exitCbs.delete(cb);
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Эмулятор порта исполнения: PTY без реального процесса. */
class FakeExecutionPort implements ExecutionPort {
  readonly pty = true;
  readonly handles: FakePtyHandle[] = [];

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('execute не используется в тестах терминалов');
  }

  async openPty(_req: PtyOpenRequest): Promise<PtyHandle> {
    const handle = new FakePtyHandle(`pty_${this.handles.length + 1}`);
    this.handles.push(handle);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Песочница
// ---------------------------------------------------------------------------

describe('backend: доступ к терминалам (PROP-132, Ф3б)', () => {
  let tmpDir: string;
  let projectStore: ProjectStore;
  let project: Project;
  let service: TerminalService;
  let port: FakeExecutionPort;
  let app: Hono;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-terminals-'));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    project = await projectStore.create('Shared', 'projectOwner');
    project.members['viewer'] = ProjectRole.VIEWER;
    project.members['editor'] = ProjectRole.EDITOR;
    project.workspace = join(tmpDir, 'work');
    await projectStore.save(project);

    port = new FakeExecutionPort();
    service = new TerminalService({ port });

    const kit = createMockKit();
    const access = createProjectAccess(kit as unknown as AuthKit);
    app = new Hono();
    app.use('*', async (c, next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (user) c.set('user' as never, user as never);
      await next();
    });
    app.route(
      '/api/v2/terminals',
      createTerminalRoutes(
        { requireAuth: kit.requireAuth },
        {
          terminal: service,
          projects: { load: async (id: string) => projectStore.load(id) },
        },
        {
          getCurrentUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
          canReadProject: async (c, p, userId) => access.canReadProject(c as never, p, userId),
          canEditProjectContent: async (c, p, userId) =>
            access.canEditProjectContent(c as never, p, userId),
          workspacesRoot: tmpDir,
        },
      ),
    );
  });

  afterAll(async () => {
    service.dispose();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (
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

  /** Создать терминал напрямую в сервисе (обход HTTP — для матрицы доступа). */
  async function createTerminal(): Promise<string> {
    const record = await service.create({
      projectId: project.id,
      ownerId: 'projectOwner',
      cwd: join(tmpDir, 'work'),
      cols: 80,
      rows: 24,
    });
    return record.id;
  }

  // ─────────────────────────── матрица доступа ───────────────────────────

  it('владелец проекта читает терминал и пишет в него', async () => {
    const id = await createTerminal();

    const detail = await req(`/api/v2/terminals/${id}`, 'projectOwner');
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { terminal: { can_write: boolean } };
    expect(body.terminal.can_write).toBe(true);

    const input = await req(`/api/v2/terminals/${id}/input`, 'projectOwner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'ls\n' }),
    });
    expect(input.status).toBe(204);
    expect(port.handles[port.handles.length - 1]?.writes).toEqual(['ls\n']);
  });

  it('участник проекта с ролью EDITOR читает и пишет', async () => {
    const id = await createTerminal();
    expect((await req(`/api/v2/terminals/${id}`, 'editor')).status).toBe(200);
    const input = await req(`/api/v2/terminals/${id}/input`, 'editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x' }),
    });
    expect(input.status).toBe(204);
  });

  it('участник проекта с ролью VIEWER читает, но не пишет (инвариант 21)', async () => {
    const id = await createTerminal();

    const detail = await req(`/api/v2/terminals/${id}`, 'viewer');
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { terminal: { can_write: boolean } };
    expect(body.terminal.can_write).toBe(false);

    const input = await req(`/api/v2/terminals/${id}/input`, 'viewer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'ls\n' }),
    });
    expect(input.status).toBe(403);
    expect(((await input.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('ADMIN и LEAD — сквозной доступ', async () => {
    const id = await createTerminal();
    for (const actor of ['admin', 'lead']) {
      expect((await req(`/api/v2/terminals/${id}`, actor)).status, actor).toBe(200);
      const input = await req(`/api/v2/terminals/${id}/input`, actor, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'x' }),
      });
      expect(input.status, actor).toBe(204);
    }
  });

  it('чужой пользователь и AUDITOR не видят терминал', async () => {
    const id = await createTerminal();
    for (const actor of ['stranger', 'auditor']) {
      const detail = await req(`/api/v2/terminals/${id}`, actor);
      expect(detail.status, actor).toBe(403);
      const input = await req(`/api/v2/terminals/${id}/input`, actor, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'x' }),
      });
      expect(input.status, actor).toBe(403);
    }
  });

  it('чужой терминал не попадает в список, а свой проект — попадает', async () => {
    await createTerminal();
    const strangerList = await req('/api/v2/terminals', 'stranger');
    expect(strangerList.status).toBe(200);
    expect(((await strangerList.json()) as { terminals: unknown[] }).terminals).toHaveLength(0);

    const ownerList = await req('/api/v2/terminals?project_id=' + project.id, 'projectOwner');
    expect(ownerList.status).toBe(200);
    expect(((await ownerList.json()) as { terminals: unknown[] }).terminals.length).toBeGreaterThan(0);
  });

  it('несуществующий терминал — 404 TERMINAL_NOT_FOUND', async () => {
    const res = await req('/api/v2/terminals/term_missing', 'projectOwner');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TERMINAL_NOT_FOUND');
  });

  it('создание терминала требует права изменения содержимого проекта', async () => {
    const body = JSON.stringify({ project_id: project.id, cols: 80, rows: 24 });

    const denied = await req('/api/v2/terminals', 'viewer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(denied.status).toBe(403);

    const allowed = await req('/api/v2/terminals', 'editor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(allowed.status).toBe(201);
  });
});
