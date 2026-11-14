/**
 * ADR-140 Ф3: передача владения проектом (`POST /api/v2/projects/:id/transfer`).
 *
 * Матрица:
 * - право — текущий владелец или `ADMIN`; `LEAD`, участник с ролью `owner`,
 *   `EDITOR`/`VIEWER` и посторонний — 403;
 * - успех: `owner_id` — новый владелец, `members[новый]='owner'`,
 *   `members[прежний]='editor'`; новый владелец видит проект и управляет
 *   доступом, прежний — пишет контент, но доступом не управляет;
 * - отказы: передача самому себе, сервисная идентичность (`service:*`),
 *   неизвестный или неактивный получатель — 400 `VALIDATION_ERROR`;
 * - событие `project.updated` с видом `access` и запись аудита
 *   `scope:'projects'` с `owner_id` в before/after.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, FileProfileStore, MemorySecurityAuditRepository, ProjectStore } from '@itphx/synth-core';
import type { ProfileData, Project, User } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { createProjectRoutes } from './projects.js';

const USERS: Record<string, User> = {
  author: { id: 'author', username: 'author', roles: ['USER'] } as User,
  target: { id: 'target', username: 'target', roles: ['USER'] } as User,
  editor: { id: 'editor', username: 'editor', roles: ['USER'] } as User,
  viewer: { id: 'viewer', username: 'viewer', roles: ['USER'] } as User,
  lead: { id: 'lead', username: 'lead', roles: ['LEAD'] } as User,
  admin: { id: 'admin', username: 'admin', roles: ['ADMIN'] } as User,
  stranger: { id: 'stranger', username: 'stranger', roles: ['USER'] } as User,
};

function userFromHeader(header: string | undefined): User | null {
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
      ((c.get('user') as User | undefined)?.roles ?? []).includes('ADMIN'),
    hasRole: (c: { get(key: 'user'): unknown }, ...roles: string[]) =>
      roles.some((r) => ((c.get('user') as User | undefined)?.roles ?? []).includes(r)),
  };
}

interface ProjectDto {
  id: string;
  owner_id: string;
  members?: Record<string, string>;
}

let tmpDir: string;
let store: ProjectStore;
let profiles: FileProfileStore;
let audit: MemorySecurityAuditRepository;
let eventBus: EventBus;
let app: Hono;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-transfer-'));
  store = new ProjectStore({ dataDir: tmpDir });
  profiles = new FileProfileStore({ dataDir: tmpDir });
  audit = new MemorySecurityAuditRepository();
  eventBus = new EventBus();
  app = new Hono();
  app.route('/api/v2/projects', createProjectRoutes(
    createMockKit() as never,
    store,
    // Сессия проекта — чтобы публикация `project.updated` дошла до канала.
    { listSessions: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) } as never,
    tmpDir,
    undefined, // mcpManager
    undefined, // skillService
    undefined, // settingsStore
    undefined, // mcpRegistryStore
    undefined, // worktreeService
    eventBus,
    undefined, // executionProfileCatalog
    undefined, // browserProfileCatalog
    audit,
    undefined, // eventHub
    profiles,
  ));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Профиль пользователя (ADR-140 Ф3: получатель должен существовать и быть активен). */
async function seedProfile(id: string, isActive = true): Promise<void> {
  const now = new Date().toISOString();
  const profile: ProfileData = {
    id,
    username: id,
    roles: ['USER'],
    teamRoles: [],
    isActive,
    preferences: {},
    notes: '',
    interviewCompleted: true,
    createdAt: now,
    updatedAt: now,
  };
  await profiles.saveProfile(profile);
}

/** Проект автора `author` с заданным состоянием доступа. */
async function seedProject(
  name: string,
  access: { members?: Record<string, ProjectRole> } = {},
): Promise<Project> {
  const project = store.create(name, 'author');
  if (access.members) {
    for (const [userId, role] of Object.entries(access.members)) {
      project.members[userId] = role;
    }
  }
  await store.save(project);
  return project;
}

function auth(user: string): Record<string, string> {
  return { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' };
}

async function transfer(id: string, user: string, body: unknown) {
  return app.request(`/api/v2/projects/${id}/transfer`, {
    method: 'POST',
    headers: auth(user),
    body: JSON.stringify(body),
  });
}

async function putProject(id: string, user: string, body: unknown) {
  return app.request(`/api/v2/projects/${id}`, {
    method: 'PUT',
    headers: auth(user),
    body: JSON.stringify(body),
  });
}

async function listProjects(user: string): Promise<{ projects: Array<{ id: string }> }> {
  const res = await app.request('/api/v2/projects', { headers: auth(user) });
  expect(res.status).toBe(200);
  return (await res.json()) as { projects: Array<{ id: string }> };
}

// ---------------------------------------------------------------------------
// 1. Успешная передача
// ---------------------------------------------------------------------------

describe('ADR-140 Ф3: передача владения — успех', () => {
  it('автор передаёт владение (200): owner_id — новый владелец, прежний — editor', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'target' });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as ProjectDto;
    expect(dto.owner_id).toBe('target');
    expect(dto.members?.target).toBe('owner');
    expect(dto.members?.author).toBe('editor');

    // Состояние в хранилище — то же (запись атомарна).
    const stored = (await store.load(project.id))!;
    expect(stored.ownerId).toBe('target');
    expect(stored.members.target).toBe(ProjectRole.OWNER);
    expect(stored.members.author).toBe(ProjectRole.EDITOR);
  });

  it('новый владелец видит проект в списке и управляет доступом', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');
    expect((await transfer(project.id, 'author', { user_id: 'target' })).status).toBe(200);

    // Проект появился в списке нового владельца.
    const list = await listProjects('target');
    expect(list.projects.map((p) => p.id)).toContain(project.id);

    // Управление доступом — право владельца.
    const access = await putProject(project.id, 'target', { members: { stranger: 'viewer' } });
    expect(access.status).toBe(200);
    expect((await store.load(project.id))!.members.stranger).toBe(ProjectRole.VIEWER);
  });

  it('прежний владелец пишет контент, но доступом не управляет', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');
    expect((await transfer(project.id, 'author', { user_id: 'target' })).status).toBe(200);

    const content = await putProject(project.id, 'author', { description: 'Правка прежнего владельца' });
    expect(content.status).toBe(200);
    expect((await store.load(project.id))!.description).toBe('Правка прежнего владельца');

    const access = await putProject(project.id, 'author', { members: { stranger: 'viewer' } });
    expect(access.status).toBe(403);
    expect(((await access.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect((await store.load(project.id))!.members.stranger).toBeUndefined();
  });

  it('ADMIN передаёт чужой проект (200)', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'admin', { user_id: 'target' });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as ProjectDto;
    expect(dto.owner_id).toBe('target');
    expect(dto.members?.author).toBe('editor');
  });
});

// ---------------------------------------------------------------------------
// 2. Право на передачу
// ---------------------------------------------------------------------------

describe('ADR-140 Ф3: передача владения — право', () => {
  it('LEAD — 403 (передача владения — не «сквозной обзор»)', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'lead', { user_id: 'target' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('EDITOR / VIEWER / посторонний — 403', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer', {
      members: { editor: ProjectRole.EDITOR, viewer: ProjectRole.VIEWER },
    });

    for (const actor of ['editor', 'viewer', 'stranger'] as const) {
      const res = await transfer(project.id, actor, { user_id: 'target' });
      expect(res.status, actor).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, actor).toBe('FORBIDDEN');
    }
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('участник с ролью owner — 403 (передавать может только текущий владелец)', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer', {
      members: { editor: ProjectRole.OWNER },
    });

    const res = await transfer(project.id, 'editor', { user_id: 'target' });
    expect(res.status).toBe(403);
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('несуществующий проект — 404', async () => {
    await seedProfile('target');
    const res = await transfer('00000000-0000-4000-8000-000000000000', 'author', { user_id: 'target' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 3. Отказы по цели передачи
// ---------------------------------------------------------------------------

describe('ADR-140 Ф3: передача владения — отказы', () => {
  it('передача самому себе — 400', async () => {
    await seedProfile('author');
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'author' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('сервисная идентичность (`service:*`) — 400', async () => {
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'service:abc123' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('неизвестный получатель — 400', async () => {
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'ghost' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('получатель ищется по ACL-id (auth-идентичность), а не по profile.id — ADR-140', async () => {
    const now = new Date().toISOString();
    await profiles.saveProfile({
      id: 'profile-uuid-1',
      username: 'target',
      roles: ['USER'],
      teamRoles: [],
      isActive: true,
      preferences: {},
      notes: '',
      interviewCompleted: true,
      identities: [{ provider: 'auth', externalId: 'oidc-sub-1', linkedAt: now }],
      createdAt: now,
      updatedAt: now,
    });
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'oidc-sub-1' });
    expect(res.status).toBe(200);

    const stored = (await store.load(project.id))!;
    expect(stored.ownerId).toBe('oidc-sub-1');
    expect(stored.members['oidc-sub-1']).toBe(ProjectRole.OWNER);
    expect(stored.members['author']).toBe(ProjectRole.EDITOR);
  });

  it('неактивный получатель — 400', async () => {
    await seedProfile('target', false);
    const project = await seedProject('Transfer');

    const res = await transfer(project.id, 'author', { user_id: 'target' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });

  it('тело без `user_id` и с лишним полем — 400', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    for (const body of [{}, { user_id: '' }, { user_id: 'target', extra: 1 }]) {
      const res = await transfer(project.id, 'author', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
    expect((await store.load(project.id))!.ownerId).toBe('author');
  });
});

// ---------------------------------------------------------------------------
// 4. Событие и аудит
// ---------------------------------------------------------------------------

describe('ADR-140 Ф3: передача владения — событие и аудит', () => {
  it('публикуется `project.updated` с видом `access`', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe('sess-1', (event) => {
      events.push({ type: event.type, data: event.data as Record<string, unknown> });
    });

    expect((await transfer(project.id, 'author', { user_id: 'target' })).status).toBe(200);
    unsubscribe();

    const updated = events.find((e) => e.type === 'project.updated');
    expect(updated).toBeDefined();
    expect(updated!.data.project_id).toBe(project.id);
    expect(updated!.data.kind).toBe('access');
  });

  it('аудит `scope:projects` содержит `owner_id` в before/after', async () => {
    await seedProfile('target');
    const project = await seedProject('Transfer');

    expect((await transfer(project.id, 'author', { user_id: 'target' })).status).toBe(200);

    const records = await audit.list();
    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.scope).toBe('projects');
    expect(entry.actor).toBe('author');
    const before = entry.before as { owner_id: string; members: Record<string, string> };
    const after = entry.after as { owner_id: string; members: Record<string, string> };
    expect(before.owner_id).toBe('author');
    expect(before.members.author).toBe('owner');
    expect(after.owner_id).toBe('target');
    expect(after.members.target).toBe('owner');
    expect(after.members.author).toBe('editor');
  });
});
