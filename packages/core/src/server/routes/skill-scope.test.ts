import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionSkillScopeRoutes,
  createProjectSkillScopeRoutes,
  createSkillSettingsRoutes,
} from './skill-scope.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';
import type { Project, Session } from '@itphx/synth-shared';
import type { SkillScopeRoutesOptions } from './skill-scope.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

let tmpDir: string;
let sessionManager: SessionManager;
let projectStore: ProjectStore;
let settingsStore: RuntimeSettingsStore;

function makeApp(extra?: Record<string, unknown>, opts?: SkillScopeRoutesOptions) {
  const deps = { sessionManager, projectStore, settingsStore, ...(extra ?? {}) } as never;
  const app = new Hono();
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(createMockAuth(), deps, opts));
  app.route('/api/v2/projects', createProjectSkillScopeRoutes(createMockAuth(), deps, opts));
  app.route('/api/v2/settings', createSkillSettingsRoutes(createMockAuth(), deps, opts));
  return app;
}

/** Опции доступа как в backend: владелец|ADMIN — сессия, owner/LEAD/ADMIN — проект. */
function accessOpts(getUser: () => string): SkillScopeRoutesOptions {
  return {
    resolveUserId: () => getUser(),
    canAccess: (s: Session, _c: Context, uid: string) => (s.ownerId ?? s.userId) === uid || uid === 'admin',
    canAccessProject: (p: Project, _c: Context, uid: string) =>
      p.ownerId === uid || uid === 'admin' || uid === 'lead',
  };
}

async function json(app: Hono, url: string, body?: unknown, method = 'GET') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-skill-scope-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  projectStore = new ProjectStore({ dataDir: tmpDir });
  settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('scope-API скиллов (ADR-046 §4.5)', () => {
  it('sessions: GET effective + PUT toggle', async () => {
    const app = makeApp();
    const session = await sessionManager.createSession({});
    const get = await app.request(`/api/v2/sessions/${session.id}/skills`);
    expect(get.status).toBe(200);
    const body: any = await get.json();
    expect(body.skills).toEqual([]);

    const put = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'api-review', enabled: true }, 'PUT');
    expect(put.status).toBe(200);
    const after: any = await put.json();
    expect(after.enabled).toContain('api-review');

    const effective = await app.request(`/api/v2/sessions/${session.id}/skills/effective`);
    expect(effective.status).toBe(200);

    const off = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'api-review', enabled: false }, 'PUT');
    const offBody: any = await off.json();
    expect(offBody.disabled).toContain('api-review');
    expect(offBody.enabled).not.toContain('api-review');
  });

  it('sessions: 404 для неизвестной сессии', async () => {
    const app = makeApp();
    expect((await app.request('/api/v2/sessions/nope/skills')).status).toBe(404);
  });

  it('sessions: settings.permission = {} не роняет GET → 200', async () => {
    const app = makeApp();
    const session = await sessionManager.createSession({});
    // Пустой permission без `rules` — как его может записать автосейв UI.
    session.settings.permission = {} as never;
    await sessionManager.updateSession(session);

    const get = await app.request(`/api/v2/sessions/${session.id}/skills`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });

  it('projects: GET + PUT enabled/defaultOn', async () => {
    const app = makeApp();
    const project: Project = {
      id: 'p1', name: 'P', ownerId: 'u', members: {}, description: '', currentTask: '',
      invariants: '', statusMessages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await projectStore.save(project);

    const get: any = await (await app.request('/api/v2/projects/p1/skills')).json();
    expect(get.enabled).toEqual([]);

    const put = await json(app, '/api/v2/projects/p1/skills', { enabled: ['a'], defaultOn: ['b'] }, 'PUT');
    expect(put.status).toBe(200);
    const after: any = await put.json();
    expect(after.enabled).toEqual(['a']);
    expect(after.defaultOn).toEqual(['b']);
  });

  it('deny из permission-конфига скрывает скилл (ADR-046 §8.1)', async () => {
    const summary = (name: string) => ({
      name, description: '', scope: 'instance', level: 'system', dir: `/skills/${name}`,
      invocation: 'both', userInvocable: true, modelInvocable: true, tags: [], agents: [],
      groups: [], requiresCapabilities: [], trusted: true, available: true,
    });
    const app = makeApp({
      skillService: {
        listSummaries: async () => ({ skills: [summary('allowed'), summary('denied')], diagnostics: [] }),
      },
      permissionConfig: { rules: { skill: { denied: 'deny' } }, askTimeoutMs: 30_000 },
    });
    const session = await sessionManager.createSession({});
    const body: any = await (await app.request(`/api/v2/sessions/${session.id}/skills`)).json();
    const names = body.skills.map((s: any) => s.name);
    expect(names).toContain('allowed');
    expect(names).not.toContain('denied');
  });

  it('settings: GET/PUT/DELETE instance-wide', async () => {
    const app = makeApp();
    const get: any = await (await app.request('/api/v2/settings/skills')).json();
    expect(get.disabled).toEqual({ categories: [], groups: [], skills: [] });
    expect(get.policy).toBe('auto');

    const put = await json(app, '/api/v2/settings/skills', {
      disabled: { categories: ['quality'], groups: ['review'], skills: ['db-migration'] },
      policy: 'available',
    }, 'PUT');
    expect(put.status).toBe(200);
    const after: any = await put.json();
    expect(after.disabled.skills).toEqual(['db-migration']);
    expect(after.policy).toBe('available');

    const del = await json(app, '/api/v2/settings/skills', undefined, 'DELETE');
    expect(del.status).toBe(200);
    const reset: any = await (await app.request('/api/v2/settings/skills')).json();
    expect(reset.disabled.skills).toEqual([]);
    expect(reset.policy).toBe('auto');
  });
});

describe('scope-API — контроль доступа (IDOR)', () => {
  it('чужой пользователь: GET + /effective + PUT → 403, мутации нет', async () => {
    const user = 'bob';
    const app = makeApp(undefined, accessOpts(() => user));
    const session = await sessionManager.createSession({ ownerId: 'alice', userId: 'alice' });

    expect((await app.request(`/api/v2/sessions/${session.id}/skills`)).status).toBe(403);
    expect((await app.request(`/api/v2/sessions/${session.id}/skills/effective`)).status).toBe(403);
    const put = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'secret', enabled: true }, 'PUT');
    expect(put.status).toBe(403);

    const after = await sessionManager.getSession(session.id);
    expect(after?.settings.skills ?? []).not.toContain('secret');
  });

  it('владелец и admin: GET/PUT → 200', async () => {
    let user = 'alice';
    const app = makeApp(undefined, accessOpts(() => user));
    const session = await sessionManager.createSession({ ownerId: 'alice', userId: 'alice' });

    expect((await app.request(`/api/v2/sessions/${session.id}/skills`)).status).toBe(200);
    const put = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'own', enabled: true }, 'PUT');
    expect(put.status).toBe(200);

    user = 'admin';
    expect((await app.request(`/api/v2/sessions/${session.id}/skills`)).status).toBe(200);
    expect((await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'admin-set', enabled: true }, 'PUT')).status).toBe(200);
  });

  it('project: чужой USER → 403 (GET/PUT); owner/LEAD/admin → 200, вкл. PUT', async () => {
    let user = 'outsider';
    const app = makeApp(undefined, accessOpts(() => user));
    const project: Project = {
      id: 'p-idor', name: 'P', ownerId: 'alice', members: {}, description: '', currentTask: '',
      invariants: '', statusMessages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await projectStore.save(project);

    // Посторонний USER — ни чтения, ни записи.
    expect((await app.request('/api/v2/projects/p-idor/skills')).status).toBe(403);
    expect((await json(app, '/api/v2/projects/p-idor/skills', { enabled: ['x'] }, 'PUT')).status).toBe(403);

    // owner — PUT разрешён.
    user = 'alice';
    expect((await app.request('/api/v2/projects/p-idor/skills')).status).toBe(200);
    expect((await json(app, '/api/v2/projects/p-idor/skills', { enabled: ['x'] }, 'PUT')).status).toBe(200);

    // LEAD — PUT разрешён (ADR-046 §4.5: owner/LEAD управляют проектным уровнем).
    user = 'lead';
    expect((await json(app, '/api/v2/projects/p-idor/skills', { enabled: ['y'] }, 'PUT')).status).toBe(200);
    const afterLead = await projectStore.load('p-idor');
    expect(afterLead?.skills?.enabled).toEqual(['y']);

    // ADMIN — PUT разрешён.
    user = 'admin';
    expect((await json(app, '/api/v2/projects/p-idor/skills', { enabled: ['z'] }, 'PUT')).status).toBe(200);

    // Несуществующий проект — 404 (без раскрытия, но и без 403).
    expect((await json(app, '/api/v2/projects/nope/skills', { enabled: ['x'] }, 'PUT')).status).toBe(404);
  });
});
