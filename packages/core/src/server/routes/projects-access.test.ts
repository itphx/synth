/**
 * PROP-133 §3.1/§3.2: состояние доступа к проекту — приём/замена/снятие и
 * права на изменение.
 *
 * Матрица: владелец меняет доступ; `EDITOR`/`viewer` — 403 (инвариант 21:
 * read/контент ≠ доступ); понижение автора — 400; `visibility` — только
 * чтение (400 при попытке записи); `everyone_role: null` снимает публикацию.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '../../storage/project-store.js';
import { MemorySecurityAuditRepository } from '../../storage/memory/security-audit.js';
import type { AuthKit } from '../../auth/local.js';
import { ProjectRole } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

const OWNER = 'owner-user';
const EDITOR = 'editor-user';
const VIEWER = 'viewer-user';
const STRANGER = 'stranger-user';

interface AuditEntry {
  scope: string;
  action: string;
  actor: string;
  before: unknown;
  after: unknown;
}

describe('PROP-133: состояние доступа к проекту (core-фабрика)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;
  let audit: MemorySecurityAuditRepository;
  let projectChanges: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-access-'));
    store = new ProjectStore({ dataDir: tmpDir });
    audit = new MemorySecurityAuditRepository();
    projectChanges = [];
    app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store, undefined, {
      getCurrentUserId: (c) => c.req.header('x-user-id') ?? OWNER,
      // `canManage` — автор / LEAD (управление доступом).
      canManage: (_c, project, userId) =>
        project.ownerId === userId || userId === 'lead-user',
      // `canEditContent` — дополнительно `EDITOR` (контент, но не доступ).
      canEditContent: (_c, project, userId) =>
        project.ownerId === userId
        || userId === 'lead-user'
        || project.members?.[userId] === ProjectRole.EDITOR,
      canRead: (_c, project, userId) =>
        project.ownerId === userId
        || userId === 'lead-user'
        || userId in (project.members ?? {}),
      onProjectChanged: (projectId, kind) => {
        projectChanges.push(`${projectId}:${kind}`);
      },
      securityAudit: audit,
    }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Записи журнала аудита (порт `SecurityAuditRepository`) — плоская проекция. */
  const auditRecords = async (): Promise<AuditEntry[]> =>
    (await audit.list()).map((entry) => ({
      scope: entry.scope,
      action: entry.action,
      actor: entry.actor,
      before: entry.before,
      after: entry.after,
    }));

  const post = (body: unknown, userId = OWNER): Promise<Response> =>
    Promise.resolve(app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify(body),
    }));

  const put = (id: string, body: unknown, userId = OWNER): Promise<Response> =>
    Promise.resolve(app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify(body),
    }));

  async function createOwned(): Promise<string> {
    const res = await post({ name: 'P' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it('POST: состояние доступа принимается и попадает в DTO', async () => {
    const res = await post({
      name: 'P',
      members: { [EDITOR]: 'editor' },
      group_members: { 'team-a': 'viewer' },
      everyone_role: 'viewer',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      members: Record<string, string>;
      group_members: Record<string, string> | null;
      everyone_role: string | null;
      visibility: string;
    };
    expect(body.members[EDITOR]).toBe('editor');
    expect(body.members[OWNER]).toBe('owner');
    expect(body.group_members).toEqual({ 'team-a': 'viewer' });
    expect(body.everyone_role).toBe('viewer');
    expect(body.visibility).toBe('all');
  });

  it('POST: без состояния доступа — видимость `author`', async () => {
    const res = await post({ name: 'P' });
    const body = (await res.json()) as { visibility: string; everyone_role: string | null };
    expect(body.visibility).toBe('author');
    expect(body.everyone_role).toBeNull();
  });

  it('POST: попытка записать `visibility` → 400 VALIDATION_ERROR', async () => {
    const res = await post({ name: 'P', visibility: 'all' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('visibility');
  });

  it('POST: неизвестная роль → 400', async () => {
    const res = await post({ name: 'P', members: { [EDITOR]: 'admin' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST: понижение автора в `members` → 400', async () => {
    const res = await post({ name: 'P', members: { [OWNER]: 'viewer' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT: владелец меняет доступ (200), набор участников — полная замена', async () => {
    const id = await createOwned();
    const first = await put(id, {
      members: { [EDITOR]: 'editor', [VIEWER]: 'viewer' },
      group_members: { 'team-a': 'viewer' },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      members: Record<string, string>;
      group_members: Record<string, string> | null;
      visibility: string;
    };
    expect(firstBody.members[EDITOR]).toBe('editor');
    expect(firstBody.members[VIEWER]).toBe('viewer');
    expect(firstBody.group_members).toEqual({ 'team-a': 'viewer' });
    expect(firstBody.visibility).toBe('selected');

    // Полная замена: прежние участники исчезают, новые появляются.
    const second = await put(id, { members: { [STRANGER]: 'viewer' }, group_members: {} });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      members: Record<string, string>;
      group_members: Record<string, string> | null;
      visibility: string;
    };
    expect(secondBody.members[EDITOR]).toBeUndefined();
    expect(secondBody.members[VIEWER]).toBeUndefined();
    expect(secondBody.members[STRANGER]).toBe('viewer');
    // Владелец остаётся `owner` в списке участников.
    expect(secondBody.members[OWNER]).toBe('owner');
    // Пустой набор групп — грантов нет.
    expect(secondBody.group_members).toBeNull();
  });

  it('PUT: поля доступа, не заданные в теле, не меняются', async () => {
    const id = await createOwned();
    await put(id, { group_members: { 'team-a': 'viewer' } });
    const res = await put(id, { description: 'текст' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { group_members: Record<string, string> | null };
    expect(body.group_members).toEqual({ 'team-a': 'viewer' });
  });

  it('PUT: EDITOR меняет контент, но не доступ (403)', async () => {
    const id = await createOwned();
    await put(id, { members: { [EDITOR]: 'editor' } });

    const content = await put(id, { description: 'можно' }, EDITOR);
    expect(content.status).toBe(200);

    const access = await put(id, { members: { [STRANGER]: 'viewer' } }, EDITOR);
    expect(access.status).toBe(403);
    const body = (await access.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');

    // Проект не изменился.
    const stored = await store.load(id);
    expect(stored?.members[STRANGER]).toBeUndefined();
  });

  it('PUT: viewer не меняет доступ (403)', async () => {
    const id = await createOwned();
    await put(id, { members: { [VIEWER]: 'viewer' } });

    const res = await put(id, { members: { [STRANGER]: 'viewer' } }, VIEWER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('PUT: чужой пользователь не меняет доступ (403)', async () => {
    const id = await createOwned();
    const res = await put(id, { members: { [STRANGER]: 'viewer' } }, STRANGER);
    expect(res.status).toBe(403);
  });

  it('PUT: понижение роли автора → 400', async () => {
    const id = await createOwned();
    const res = await put(id, { members: { [OWNER]: 'viewer' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PUT: `everyone_role: null` снимает публикацию', async () => {
    const id = await createOwned();
    const published = await put(id, { everyone_role: 'viewer' });
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as { everyone_role: string | null; visibility: string };
    expect(publishedBody.everyone_role).toBe('viewer');
    expect(publishedBody.visibility).toBe('all');

    const unpublished = await put(id, { everyone_role: null });
    expect(unpublished.status).toBe(200);
    const unpublishedBody = (await unpublished.json()) as { everyone_role: string | null; visibility: string };
    expect(unpublishedBody.everyone_role).toBeNull();
    expect(unpublishedBody.visibility).toBe('author');
  });

  it('PUT: попытка записать `visibility` → 400', async () => {
    const id = await createOwned();
    const res = await put(id, { visibility: 'selected' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('visibility');
  });

  it('PUT: неизвестная роль → 400', async () => {
    const id = await createOwned();
    const res = await put(id, { members: { [EDITOR]: 'root' } });
    expect(res.status).toBe(400);
  });

  it('PUT: роль `owner` для режима «всем пользователям» → 400', async () => {
    const id = await createOwned();
    const res = await put(id, { everyone_role: 'owner' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('owner');
  });

  it('POST: роль `owner` для режима «всем пользователям» → 400', async () => {
    const res = await post({ name: 'P', everyone_role: 'owner' });
    expect(res.status).toBe(400);
  });

  it('изменение доступа публикует `project.updated` с видом `access` и пишет аудит', async () => {
    const id = await createOwned();
    projectChanges.length = 0;
    await audit.clear();

    const res = await put(id, { members: { [VIEWER]: 'viewer' } });
    expect(res.status).toBe(200);
    // ADR-140 Ф2: изменение состояния доступа — вид `access` (одно событие),
    // чтобы подписки клиентов пересчитывались.
    expect(projectChanges).toContain(`${id}:access`);
    const records = await auditRecords();
    expect(records).toHaveLength(1);
    const entry = records[0];
    expect(entry?.scope).toBe('projects');
    expect(entry?.actor).toBe(OWNER);
    const after = entry?.after as { members: Record<string, string> };
    expect(after.members[VIEWER]).toBe('viewer');
  });

  it('снятие публикации (`everyone_role: null`) — тоже вид `access`', async () => {
    const id = await createOwned();
    await put(id, { everyone_role: 'viewer' });
    projectChanges.length = 0;

    const res = await put(id, { everyone_role: null });
    expect(res.status).toBe(200);
    // Снятие публикации меняет состояние доступа → вид `access`.
    expect(projectChanges).toContain(`${id}:access`);
  });

  it('правка контента без изменения доступа аудит не пишет', async () => {
    const id = await createOwned();
    await audit.clear();
    const res = await put(id, { description: 'текст' });
    expect(res.status).toBe(200);
    expect(await auditRecords()).toHaveLength(0);
    // ADR-140 Ф2: правка контента — обычный вид `updated` (не `access`).
    expect(projectChanges).toContain(`${id}:updated`);
    expect(projectChanges).not.toContain(`${id}:access`);
  });

  it('состояние доступа переживает запись в хранилище', async () => {
    const id = await createOwned();
    const res = await put(id, {
      members: { [VIEWER]: 'viewer' },
      group_members: { 'team-a': 'editor' },
      everyone_role: 'editor',
    });
    expect(res.status).toBe(200);
    const stored = await store.load(id);
    expect(stored?.members[VIEWER]).toBe('viewer');
    expect(stored?.groupMembers?.['team-a']).toBe('editor');
    expect(stored?.everyoneRole).toBe('editor');
  });
});
