/**
 * PROP-133 Ф1: матрица доступа к проекту (managed-контур).
 *
 * Проверяется **единый** предикат (`resolveProjectAccess`) на HTTP-границе:
 *
 * - режим `author` (грантов нет) — чужой USER не видит проект ни в списке, ни
 *   по id (403); `ADMIN`/`LEAD` видят (сквозной обзор, ADR-089);
 * - режим `all` (`everyone_role='viewer'`) — чужой USER видит и читает проект,
 *   но не пишет контент (инвариант 21: видимость ≠ запись);
 * - режим `all` (`everyone_role='editor'`) — чужой USER пишет контент, но не
 *   управляет проектом (`DELETE`, смена `workspace` — только owner/LEAD/ADMIN);
 * - режим `selected` (`members[userId]='viewer'|'editor'`) — те же правила по
 *   роли;
 * - `EDITOR` меняет контент, но **не** состояние доступа (`members`/
 *   `group_members`/`everyone_role` — только `canManage`);
 * - грант по группе: принципал с группами видит проект, без группы — 403.
 *
 * Матрица построена на тех же фикстурах, что и `projects.test.ts`
 * (пользователь — из заголовка `Authorization`, роли — из фикстуры).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '@itphx/synth-core';
import type { Project, User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { createProjectRoutes } from './projects.js';

/** Пользователь с группами (PROP-133 Ф2: аддитивное поле, Ф1 — задел). */
interface MatrixUser extends User {
  groups?: string[];
}

const USERS: Record<string, MatrixUser> = {
  owner: { id: 'owner', username: 'owner', roles: ['USER'] } as MatrixUser,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as MatrixUser,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as MatrixUser,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as MatrixUser,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as MatrixUser,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as MatrixUser,
  // Принципал с грантом по группе (PROP-133 §1, п. 4 резолвера).
  grantee: { id: 'grantee', username: 'grantee', roles: ['USER'], groups: ['team-a'] } as MatrixUser,
  // Тот же пользователь без группы — гранта нет.
  noGroup: { id: 'noGroup', username: 'noGroup', roles: ['USER'] } as MatrixUser,
};

function userFromHeader(header: string | undefined): MatrixUser | null {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m ? USERS[m[1]!] ?? null : null;
}

function createMockKit() {
  return {
    requireAuth: async (c: Context, next: Next) => {
      const user = userFromHeader(c.req.header('Authorization'));
      if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
      c.set('user' as never, user as never);
      await next();
    },
    getCurrentUser: async (c: Context) => userFromHeader(c.req.header('Authorization')),
    isAdmin: (c: { get(key: 'user'): unknown }) =>
      ((c.get('user') as MatrixUser | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as MatrixUser | undefined)?.roles ?? []).includes(r)),
  };
}

interface ProjectListBody {
  projects: Array<{ id: string }>;
  total: number;
}

interface ProjectDto {
  id: string;
  name: string;
  workspace?: string;
  visibility?: string;
  members?: Record<string, string>;
  group_members?: Record<string, string> | null;
  everyone_role?: string | null;
}

let tmpDir: string;
let store: ProjectStore;
let app: Hono;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-proj-access-matrix-'));
  store = new ProjectStore({ dataDir: tmpDir });
  app = new Hono();
  app.route('/api/v2/projects', createProjectRoutes(
    createMockKit() as never,
    store,
    { listSessions: vi.fn().mockResolvedValue([]) } as never,
    tmpDir,
  ));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Создать проект автора `owner` с заданным состоянием доступа. */
async function seedProject(
  name: string,
  access: {
    members?: Record<string, ProjectRole>;
    groupMembers?: Record<string, ProjectRole>;
    everyoneRole?: ProjectRole | null;
  } = {},
): Promise<Project> {
  const project = store.create(name, 'owner');
  if (access.members) {
    for (const [userId, role] of Object.entries(access.members)) {
      project.members[userId] = role;
    }
  }
  if (access.groupMembers) project.groupMembers = access.groupMembers;
  if (access.everyoneRole !== undefined) project.everyoneRole = access.everyoneRole;
  await store.save(project);
  return project;
}

function auth(user: string): Record<string, string> {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

async function getProject(id: string, user: string) {
  return app.request(`/api/v2/projects/${id}`, { headers: auth(user) });
}

async function putProject(id: string, user: string, body: unknown) {
  return app.request(`/api/v2/projects/${id}`, {
    method: 'PUT',
    headers: auth(user),
    body: JSON.stringify(body),
  });
}

async function deleteProject(id: string, user: string) {
  return app.request(`/api/v2/projects/${id}`, { method: 'DELETE', headers: auth(user) });
}

async function listProjects(user: string): Promise<ProjectListBody> {
  const res = await app.request('/api/v2/projects', { headers: auth(user) });
  expect(res.status).toBe(200);
  return (await res.json()) as ProjectListBody;
}

// ---------------------------------------------------------------------------
// 1. Режим `author` — грантов нет
// ---------------------------------------------------------------------------

describe('PROP-133: режим `author` — только автор (+ADMIN/LEAD — сквозной обзор)', () => {
  it('чужой USER не видит проект в списке и получает 403 по id', async () => {
    const project = await seedProject('Author-only');

    const list = await listProjects('stranger');
    expect(list.projects.map((p) => p.id)).not.toContain(project.id);
    expect(list.total).toBe(0);

    const res = await getProject(project.id, 'stranger');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('ADMIN/LEAD видят проект в списке и читают его', async () => {
    const project = await seedProject('Author-only');

    for (const actor of ['admin', 'lead'] as const) {
      const list = await listProjects(actor);
      expect(list.projects.map((p) => p.id), actor).toContain(project.id);

      const res = await getProject(project.id, actor);
      expect(res.status, actor).toBe(200);
    }
  });

  it('автор видит и читает свой проект', async () => {
    const project = await seedProject('Author-only');
    const list = await listProjects('owner');
    expect(list.projects.map((p) => p.id)).toContain(project.id);
    expect((await getProject(project.id, 'owner')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. Режим `all` — «всем пользователям»
// ---------------------------------------------------------------------------

describe('PROP-133: режим `all` + everyone_role=viewer', () => {
  it('чужой USER видит проект в списке и читает его (200)', async () => {
    const project = await seedProject('Shared-read', { everyoneRole: ProjectRole.VIEWER });

    const list = await listProjects('stranger');
    expect(list.projects.map((p) => p.id)).toContain(project.id);

    const res = await getProject(project.id, 'stranger');
    expect(res.status).toBe(200);
    const dto = (await res.json()) as ProjectDto;
    expect(dto.visibility).toBe('all');
    expect(dto.everyone_role).toBe('viewer');
  });

  it('чужой USER не пишет контент (403), проект не изменён', async () => {
    const project = await seedProject('Shared-read', { everyoneRole: ProjectRole.VIEWER });

    const res = await putProject(project.id, 'stranger', { name: 'Взлом' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect((await store.load(project.id))!.name).toBe('Shared-read');
  });
});

describe('PROP-133: режим `all` + everyone_role=editor', () => {
  it('чужой USER меняет контент (200)', async () => {
    const project = await seedProject('Shared-write', { everyoneRole: ProjectRole.EDITOR });

    const res = await putProject(project.id, 'stranger', { description: 'Правка участника' });
    expect(res.status).toBe(200);
    expect((await store.load(project.id))!.description).toBe('Правка участника');
  });

  it('чужой USER не удаляет проект (403) — управление только owner/LEAD/ADMIN', async () => {
    const project = await seedProject('Shared-write', { everyoneRole: ProjectRole.EDITOR });

    const res = await deleteProject(project.id, 'stranger');
    expect(res.status).toBe(403);
    expect(await store.load(project.id)).not.toBeNull();
  });

  it('чужой USER не меняет workspace (403) — только owner/LEAD/ADMIN', async () => {
    const project = await seedProject('Shared-write', { everyoneRole: ProjectRole.EDITOR });

    const res = await putProject(project.id, 'stranger', { workspace: 'ws-stranger' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.workspace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Режим `selected` — гранты конкретным пользователям
// ---------------------------------------------------------------------------

describe('PROP-133: режим `selected` — members[userId]', () => {
  it('viewer читает проект, но не пишет контент', async () => {
    const project = await seedProject('Selected-viewer', {
      members: { viewer: ProjectRole.VIEWER },
    });

    const list = await listProjects('viewer');
    expect(list.projects.map((p) => p.id)).toContain(project.id);
    expect((await getProject(project.id, 'viewer')).status).toBe(200);

    const res = await putProject(project.id, 'viewer', { name: 'Не должен' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.name).toBe('Selected-viewer');
  });

  it('editor пишет контент, но не меняет доступ', async () => {
    const project = await seedProject('Selected-editor', {
      members: { editor: ProjectRole.EDITOR },
    });

    const content = await putProject(project.id, 'editor', { description: 'Правка редактора' });
    expect(content.status).toBe(200);
    expect((await store.load(project.id))!.description).toBe('Правка редактора');

    for (const body of [
      { members: { stranger: 'viewer' } },
      { group_members: { 'team-a': 'viewer' } },
      { everyone_role: 'viewer' },
    ]) {
      const res = await putProject(project.id, 'editor', body);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    const stored = (await store.load(project.id))!;
    expect(stored.members.stranger).toBeUndefined();
    expect(stored.groupMembers).toBeUndefined();
    expect(stored.everyoneRole ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Управление доступом — только canManage
// ---------------------------------------------------------------------------

describe('PROP-133: смена состояния доступа — только canManage', () => {
  it('EDITOR не меняет members / group_members / everyone_role (403)', async () => {
    const project = await seedProject('Managed', {
      members: { editor: ProjectRole.EDITOR },
    });

    for (const body of [
      { members: { stranger: 'viewer' } },
      { group_members: { 'team-a': 'viewer' } },
      { everyone_role: 'viewer' },
    ]) {
      const res = await putProject(project.id, 'editor', body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }

    const stored = (await store.load(project.id))!;
    expect(stored.members.stranger).toBeUndefined();
    expect(stored.groupMembers).toBeUndefined();
    expect(stored.everyoneRole ?? null).toBeNull();
  });

  it('viewer не меняет доступ (403)', async () => {
    const project = await seedProject('Managed', {
      members: { viewer: ProjectRole.VIEWER },
    });
    const res = await putProject(project.id, 'viewer', { everyone_role: 'editor' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.everyoneRole ?? null).toBeNull();
  });

  it('автор меняет доступ (200) — состояние доступа обновляется', async () => {
    const project = await seedProject('Managed');
    const res = await putProject(project.id, 'owner', {
      members: { stranger: 'viewer' },
      everyone_role: 'editor',
    });
    expect(res.status).toBe(200);
    const stored = (await store.load(project.id))!;
    expect(stored.members.stranger).toBe(ProjectRole.VIEWER);
    expect(stored.everyoneRole).toBe(ProjectRole.EDITOR);
  });
});

// ---------------------------------------------------------------------------
// 5. Грант по группе
// ---------------------------------------------------------------------------

describe('PROP-133: грант по группе', () => {
  it('принципал с группой читает проект (200), без группы — 403', async () => {
    const project = await seedProject('Group-shared', {
      groupMembers: { 'team-a': ProjectRole.VIEWER },
    });

    const granted = await getProject(project.id, 'grantee');
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as ProjectDto).visibility).toBe('selected');

    const denied = await getProject(project.id, 'noGroup');
    expect(denied.status).toBe(403);
  });

  it('принципал без группы не видит грантованный проект в списке', async () => {
    const project = await seedProject('Group-shared', {
      groupMembers: { 'team-a': ProjectRole.VIEWER },
    });
    const list = await listProjects('noGroup');
    expect(list.projects.map((p) => p.id)).not.toContain(project.id);
  });

  it('принципал с группой видит грантованный проект в списке', async () => {
    const project = await seedProject('Group-shared', {
      groupMembers: { 'team-a': ProjectRole.VIEWER },
    });
    const list = await listProjects('grantee');
    expect(list.projects.map((p) => p.id)).toContain(project.id);
  });
});
