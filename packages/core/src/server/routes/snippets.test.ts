/**
 * ADR-141 §4: HTTP-контур сниппетов (`#`) — CRUD по трём уровням, RBAC,
 * раскрытие и коды ошибок.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next, MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectRole,
  canWriteWithProjectRole,
  resolveProjectAccess,
} from '@itphx/synth-shared';
import type { Project } from '@itphx/synth-shared';
import { createSnippetRoutes } from './snippets.js';
import { SnippetService } from '../../engine/snippets/service.js';
import {
  instanceSnippetsDir,
  projectSnippetsDir,
  userSnippetsDir,
} from '../../engine/snippets/discovery.js';
import type { AuthKit } from '../../auth/local.js';

const ADMIN = 'admin-1';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Guard инстанс-уровня: запись разрешена только ADMIN (как `requireAdmin` в backend). */
const adminGuard: MiddlewareHandler = async (c, next) => {
  const userId = c.req.header('x-user-id') ?? '';
  if (userId !== ADMIN) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'нужна роль ADMIN' } }, 403);
  }
  await next();
};

interface TestProject {
  id: string;
  ownerId: string;
  members: Record<string, ProjectRole>;
  workspace: string;
}

let dataDir: string;
let workspace: string;
let projects: Map<string, TestProject>;

function projectOf(p: TestProject): Project {
  return {
    id: p.id,
    name: p.id,
    ownerId: p.ownerId,
    members: p.members,
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspace: p.workspace,
  };
}

function makeApp(opts?: { trusted?: boolean; writeGuard?: MiddlewareHandler }) {
  const app = new Hono();
  const service = new SnippetService({
    dataDir,
    trustedProjectDirs: opts?.trusted === false ? [] : [workspace],
  });
  app.route(
    '/api/v2/snippets',
    createSnippetRoutes(
      createMockAuth(),
      {
        snippetService: service,
        projectStore: {
          load: async (id: string) => {
            const found = projects.get(id);
            return found ? projectOf(found) : null;
          },
        },
        resolveProjectWorkspace: async (id: string) => projects.get(id)?.workspace,
      },
      {
        writeGuard: opts?.writeGuard ?? adminGuard,
        resolveUserId: (c) => c.req.header('x-user-id') ?? '',
        // Правила проекта — те же, что в managed (единый резолвер доступа).
        canReadProject: (_c, project, userId) =>
          resolveProjectAccess(project, { userId }).read,
        canEditProject: (_c, project, userId) =>
          canWriteWithProjectRole(resolveProjectAccess(project, { userId }).role),
      },
    ),
  );
  return { app, service };
}

async function send(
  app: Hono,
  method: string,
  url: string,
  body?: unknown,
  userId = 'user-1',
): Promise<Response> {
  return app.request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-snippets-routes-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-snippets-routes-ws-'));
  projects = new Map<string, TestProject>([
    ['p1', { id: 'p1', ownerId: 'owner-1', members: {}, workspace }],
    ['p2', { id: 'p2', ownerId: 'owner-2', members: { 'viewer-1': ProjectRole.VIEWER }, workspace }],
  ]);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('POST/GET/PATCH/DELETE /api/v2/snippets — CRUD по уровням', () => {
  it('instance: создание → чтение → правка → удаление', async () => {
    const { app } = makeApp();

    const created = await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'Привет, #name',
      description: 'приветствие',
      aliases: ['hello'],
      scope: 'instance',
    }, ADMIN);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { name: string; scope: string; trusted: boolean };
    expect(createdBody.name).toBe('greet');
    expect(createdBody.scope).toBe('instance');
    expect(createdBody.trusted).toBe(true);

    const list = (await (await send(app, 'GET', '/api/v2/snippets')).json()) as {
      snippets: Array<{ name: string; scope: string }>;
      diagnostics: unknown[];
    };
    expect(list.snippets.map((s) => s.name)).toContain('greet');
    expect(list.diagnostics).toBeDefined();

    const patched = await send(app, 'PATCH', '/api/v2/snippets/greet', { body: 'Пока' }, ADMIN);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { body: string }).body).toBe('Пока');

    const removed = await send(app, 'DELETE', '/api/v2/snippets/greet', undefined, ADMIN);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { status: string }).status).toBe('deleted');

    const listAfter = (await (await send(app, 'GET', '/api/v2/snippets')).json()) as {
      snippets: Array<{ name: string }>;
    };
    expect(listAfter.snippets.map((s) => s.name)).not.toContain('greet');
  });

  it('user: сниппет пишется в каталог пользователя и не виден чужому', async () => {
    const { app } = makeApp();

    const created = await send(app, 'POST', '/api/v2/snippets', {
      name: 'mine',
      body: 'своё',
      scope: 'user',
    }, 'user-1');
    expect(created.status).toBe(201);
    expect(((await created.json()) as { scope: string }).scope).toBe('user');

    const own = (await (await send(app, 'GET', '/api/v2/snippets', undefined, 'user-1')).json()) as {
      snippets: Array<{ name: string }>;
    };
    expect(own.snippets.map((s) => s.name)).toContain('mine');

    const foreign = (await (await send(app, 'GET', '/api/v2/snippets', undefined, 'user-2')).json()) as {
      snippets: Array<{ name: string }>;
    };
    expect(foreign.snippets.map((s) => s.name)).not.toContain('mine');
  });

  it('project: сниппет пишется в workspace проекта и виден при доступе', async () => {
    const { app } = makeApp();

    const created = await send(app, 'POST', '/api/v2/snippets', {
      name: 'proj-snippet',
      body: 'проектное',
      scope: 'project',
      projectId: 'p1',
    }, 'owner-1');
    expect(created.status).toBe(201);
    expect(((await created.json()) as { scope: string }).scope).toBe('project');

    // Файл лежит в `.synth/snippets` рабочего каталога проекта.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(projectSnippetsDir(workspace), 'proj-snippet.md'))).toBe(true);

    const list = (await (await send(app, 'GET', '/api/v2/snippets?projectId=p1', undefined, 'owner-1')).json()) as {
      snippets: Array<{ name: string; scope: string }>;
    };
    expect(list.snippets.some((s) => s.name === 'proj-snippet' && s.scope === 'project')).toBe(true);
  });

  it('переименование и перенос уровня: PATCH переносит сниппет и убирает старый', async () => {
    const { app } = makeApp();
    // Сниппет пользователя переносит его владелец (user-уровень изолирован по
    // `userId`); запись в instance-уровень — только ADMIN.
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'movable',
      body: 'текст',
      scope: 'user',
    }, ADMIN);

    const patched = await send(app, 'PATCH', '/api/v2/snippets/movable', {
      name: 'moved',
      scope: 'instance',
    }, ADMIN);
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { name: string; scope: string };
    expect(body.name).toBe('moved');
    expect(body.scope).toBe('instance');

    const list = (await (await send(app, 'GET', '/api/v2/snippets')).json()) as {
      snippets: Array<{ name: string; scope: string }>;
    };
    expect(list.snippets.some((s) => s.name === 'movable')).toBe(false);
    expect(list.snippets.some((s) => s.name === 'moved' && s.scope === 'instance')).toBe(true);
  });

  it('перенос из user-уровня в instance-уровень: не-ADMIN не может (403)', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'movable',
      body: 'текст',
      scope: 'user',
    }, 'user-1');

    const patched = await send(app, 'PATCH', '/api/v2/snippets/movable', {
      scope: 'instance',
    }, 'user-1');
    expect(patched.status).toBe(403);
  });

  it('чужой user-сниппет не виден и не переносится (404)', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'movable',
      body: 'текст',
      scope: 'user',
    }, 'user-1');

    // Даже ADMIN не видит сниппет чужого user-уровня: каталог изолирован.
    const patched = await send(app, 'PATCH', '/api/v2/snippets/movable', {
      scope: 'instance',
    }, ADMIN);
    expect(patched.status).toBe(404);
  });
});

describe('RBAC /api/v2/snippets', () => {
  it('чужой user-уровень: запись в каталог другого пользователя — 403', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'foreign',
      body: 'чужое',
      scope: 'user',
      userId: 'user-2',
    }, 'user-1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('не-ADMIN не пишет instance-уровень — 403', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'inst',
      body: 'инстанс',
      scope: 'instance',
    }, 'user-1');
    expect(res.status).toBe(403);
  });

  it('не-ADMIN не правит и не удаляет instance-сниппет — 403', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'inst',
      body: 'инстанс',
      scope: 'instance',
    }, ADMIN);

    const patched = await send(app, 'PATCH', '/api/v2/snippets/inst', { body: 'правка' }, 'user-1');
    expect(patched.status).toBe(403);
    const removed = await send(app, 'DELETE', '/api/v2/snippets/inst', undefined, 'user-1');
    expect(removed.status).toBe(403);
  });

  it('VIEWER не мутирует проектный сниппет — 403', async () => {
    const { app } = makeApp();
    const created = await send(app, 'POST', '/api/v2/snippets', {
      name: 'proj-snippet',
      body: 'проектное',
      scope: 'project',
      projectId: 'p2',
    }, 'owner-2');
    expect(created.status).toBe(201);

    const patched = await send(app, 'PATCH', '/api/v2/snippets/proj-snippet', {
      body: 'правка',
      scope: 'project',
      projectId: 'p2',
    }, 'viewer-1');
    expect(patched.status).toBe(403);

    const removed = await send(app, 'DELETE', '/api/v2/snippets/proj-snippet?projectId=p2', undefined, 'viewer-1');
    expect(removed.status).toBe(403);

    // Чтение проекта доступно VIEWER (право чтения не расширяет запись).
    const list = await send(app, 'GET', '/api/v2/snippets?projectId=p2', undefined, 'viewer-1');
    expect(list.status).toBe(200);
  });

  it('чужой проект: список и запись — 403/404', async () => {
    const { app } = makeApp();
    const list = await send(app, 'GET', '/api/v2/snippets?projectId=p1', undefined, 'outsider');
    expect(list.status).toBe(403);

    const create = await send(app, 'POST', '/api/v2/snippets', {
      name: 'x',
      body: 'x',
      scope: 'project',
      projectId: 'p1',
    }, 'outsider');
    expect(create.status).toBe(403);

    const missing = await send(app, 'GET', '/api/v2/snippets?projectId=nope', undefined, 'owner-1');
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/v2/snippets/expand — раскрытие', () => {
  it('раскрывает #name и оставляет неизвестный токен текстом', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'Привет!',
      scope: 'instance',
    }, ADMIN);

    const res = await send(app, 'POST', '/api/v2/snippets/expand', { text: 'скажи #greet и #unknown' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; applied: string[]; diagnostics: unknown[] };
    expect(body.text).toBe('скажи Привет! и #unknown');
    expect(body.applied).toEqual(['greet']);
    expect(body.diagnostics).toEqual([]);
  });

  it('недоверенный проект: сниппет не раскрывается (diagnostics untrusted)', async () => {
    const { app } = makeApp({ trusted: false });
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'untrusted-snippet',
      body: 'СЕКРЕТ',
      scope: 'project',
      projectId: 'p1',
    }, 'owner-1');

    const res = await send(app, 'POST', '/api/v2/snippets/expand', {
      text: 'покажи #untrusted-snippet',
      projectId: 'p1',
    }, 'owner-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; applied: string[]; diagnostics: Array<{ code: string }> };
    expect(body.text).toBe('покажи #untrusted-snippet');
    expect(body.applied).toEqual([]);
    expect(body.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
  });
});

describe('Коды ошибок /api/v2/snippets', () => {
  it('невалидное имя — 400 VALIDATION_ERROR', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'Bad Name',
      body: 'x',
      scope: 'instance',
    }, ADMIN);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('неизвестное поле в теле — 400 VALIDATION_ERROR', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'ok-name',
      body: 'x',
      scope: 'instance',
      unexpected: true,
    }, ADMIN);
    expect(res.status).toBe(400);
  });

  it('дубликат имени — 409 CONFLICT', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'dup',
      body: 'x',
      scope: 'instance',
    }, ADMIN);
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'dup',
      body: 'y',
      scope: 'instance',
    }, ADMIN);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('несуществующий сниппет — 404 NOT_FOUND', async () => {
    const { app } = makeApp();
    const patched = await send(app, 'PATCH', '/api/v2/snippets/missing', { body: 'x' }, ADMIN);
    expect(patched.status).toBe(404);
    expect(((await patched.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const removed = await send(app, 'DELETE', '/api/v2/snippets/missing', undefined, ADMIN);
    expect(removed.status).toBe(404);
  });

  it('project-уровень без projectId — 400 VALIDATION_ERROR', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'no-project',
      body: 'x',
      scope: 'project',
    }, ADMIN);
    expect(res.status).toBe(400);
  });

  it('неизвестный уровень в теле — 400; неизвестный scope в query — 400', async () => {
    const { app } = makeApp();
    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'bad-scope',
      body: 'x',
      scope: 'global',
    }, ADMIN);
    expect(res.status).toBe(400);

    const list = await send(app, 'GET', '/api/v2/snippets?scope=global');
    expect(list.status).toBe(400);
  });
});

describe('Файлы сниппетов по уровням', () => {
  it('instance/user каталоги — в dataDir, project — в workspace', async () => {
    const { app } = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'inst-file',
      body: 'x',
      scope: 'instance',
    }, ADMIN);
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'user-file',
      body: 'x',
      scope: 'user',
    }, 'user-1');
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'project-file',
      body: 'x',
      scope: 'project',
      projectId: 'p1',
    }, 'owner-1');

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(instanceSnippetsDir(dataDir), 'inst-file.md'))).toBe(true);
    expect(existsSync(join(userSnippetsDir(dataDir, 'user-1'), 'user-file.md'))).toBe(true);
    expect(existsSync(join(projectSnippetsDir(workspace), 'project-file.md'))).toBe(true);
  });
});
