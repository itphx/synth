/**
 * Событие шины `skills.updated` на путях **уровневого** скоупа скиллов
 * (`createSessionSkillScopeRoutes` / `createProjectSkillScopeRoutes` /
 * `createSkillSettingsRoutes`).
 *
 * Смена скоупа — это мутация, видимая другому клиенту (инвариант 27): открытая
 * вкладка сессии/проекта иначе показывала бы старые переключатели, а проектная
 * панель — старый жёсткий гейт до перезагрузки страницы. Поэтому контракт:
 * - `PUT /sessions/:id/skills` — `session.updated` в канал **этой** сессии (тот
 *   же путь публикации, что у тула `synth_mcp_enable`, `level: 'session'`) плюс
 *   инстансное `skills.updated` со `scope: 'session'` и `sessionId`;
 * - `PUT /projects/:id/skills` — `onProjectChanged` (`project.updated` в каналы
 *   сессий проекта, как у `PUT /projects/:id`) плюс `skills.updated` со
 *   `scope: 'project'` и `projectId`;
 * - `PUT`/`DELETE /settings/skills` — `skills.updated` со `scope: 'instance'`;
 * - при ошибке (400/404/403) — тишина: событие публикуется только после
 *   успешной записи.
 *
 * Стенд — как в `skill-scope.test.ts` (реальные `SessionManager`/`ProjectStore`/
 * `RuntimeSettingsStore` во временном каталоге); шина и `onProjectChanged`
 * подменены сборщиками: тест про контракт фабрик, а не про EventBus.
 */
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
import type { SkillScopeRoutesOptions } from './skill-scope.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';
import type { Project } from '@itphx/synth-shared';
import { publishSkillsUpdated } from '../../events/skills-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    // Фейк: реализованы только `getCurrentUser`/`requireAuth`.
  } as unknown as AuthKit;
}

let tmpDir: string;
let sessionManager: SessionManager;
let projectStore: ProjectStore;
let settingsStore: RuntimeSettingsStore;
let published: PublishedEvent[];

/**
 * Опции точки сборки, сведённые к сборщикам: `skillsChangedPublisher(bus)`,
 * шина для `session.updated` и `onProjectChanged` (`project.updated`).
 */
function eventsOpts(): SkillScopeRoutesOptions {
  const bus = {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
    publish: (channel: string, type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel, type, data });
    },
  };
  return {
    eventBus: bus,
    onSkillsChanged: (info) => publishSkillsUpdated(bus, info),
    onProjectChanged: async (projectId: string) => {
      published.push({ channel: 'project-sessions', type: 'project.updated', data: { project_id: projectId } });
    },
  };
}

function makeApp(opts: SkillScopeRoutesOptions = eventsOpts()) {
  const deps = { sessionManager, projectStore, settingsStore } as never;
  const app = new Hono();
  app.route('/api/v2/sessions', createSessionSkillScopeRoutes(createMockAuth(), deps, opts));
  app.route('/api/v2/projects', createProjectSkillScopeRoutes(createMockAuth(), deps, opts));
  app.route('/api/v2/settings', createSkillSettingsRoutes(createMockAuth(), deps, opts));
  return app;
}

async function json(app: Hono, url: string, body?: unknown, method = 'GET') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeProject(id = 'p1'): Promise<Project> {
  const project: Project = {
    id, name: 'P', ownerId: 'u', members: {}, description: '', currentTask: '',
    invariants: '', statusMessages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await projectStore.save(project);
  return project;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-skill-scope-events-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  projectStore = new ProjectStore({ dataDir: tmpDir });
  settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  published = [];
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('PUT /sessions/:id/skills — session.updated и skills.updated{scope: session}', () => {
  it('точечный toggle: событие в канал сессии + инстансное skills.updated с именем', async () => {
    const app = makeApp();
    const session = await sessionManager.createSession({});

    const res = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'api-review', enabled: true }, 'PUT');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: session.id,
        type: 'session.updated',
        data: expect.objectContaining({
          session_id: session.id,
          settings: expect.objectContaining({ skills: ['api-review'] }),
        }),
      },
      {
        channel: 'instance',
        type: 'skills.updated',
        data: { action: 'scope', name: 'api-review', scope: 'session', sessionId: session.id },
      },
    ]);
    // `updated_at` двигается точечной правкой — UI сортирует список сессий по нему.
    expect(published[0]!.data.updated_at).toEqual(expect.any(String));
  });

  it('полная замена списка (без name): в payload нет ключа name', async () => {
    const app = makeApp();
    const session = await sessionManager.createSession({});

    const res = await json(app, `/api/v2/sessions/${session.id}/skills`, { skills: ['a', 'b'] }, 'PUT');
    expect(res.status).toBe(200);
    expect(published.map((e) => [e.type, e.data])).toEqual([
      ['session.updated', expect.objectContaining({ session_id: session.id })],
      ['skills.updated', { action: 'scope', scope: 'session', sessionId: session.id }],
    ]);
    expect('name' in published[1]!.data).toBe(false);
    const after = await sessionManager.getSession(session.id);
    expect(after?.settings.skills).toEqual(['a', 'b']);
  });

  it('400 (невалидное тело) и 404 (нет сессии) — событий нет', async () => {
    const app = makeApp();
    const session = await sessionManager.createSession({});

    const invalid = await json(app, `/api/v2/sessions/${session.id}/skills`, {}, 'PUT');
    expect(invalid.status).toBe(400);
    const ghost = await json(app, '/api/v2/sessions/nope/skills', { name: 'a', enabled: true }, 'PUT');
    expect(ghost.status).toBe(404);

    expect(published).toEqual([]);
  });

  it('403 (чужой пользователь) — событий нет, мутации нет', async () => {
    const app = makeApp({
      ...eventsOpts(),
      resolveUserId: () => 'bob',
      canAccess: () => false,
    });
    const session = await sessionManager.createSession({ ownerId: 'alice', userId: 'alice' });

    const res = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'secret', enabled: true }, 'PUT');
    expect(res.status).toBe(403);
    expect(published).toEqual([]);
    const after = await sessionManager.getSession(session.id);
    expect(after?.settings.skills ?? []).not.toContain('secret');
  });

  it('без шины и хука фабрика работает как раньше (мутация проходит, событий нет)', async () => {
    const app = makeApp({});
    const session = await sessionManager.createSession({});

    const res = await json(app, `/api/v2/sessions/${session.id}/skills`, { name: 'a', enabled: true }, 'PUT');
    expect(res.status).toBe(200);
    expect(published).toEqual([]);
    const after = await sessionManager.getSession(session.id);
    expect(after?.settings.skills).toEqual(['a']);
  });
});

describe('PUT /projects/:id/skills — project.updated и skills.updated{scope: project}', () => {
  it('публикует project.updated и инстансное skills.updated со scope: project', async () => {
    const app = makeApp();
    const project = await makeProject();

    const res = await json(app, '/api/v2/projects/p1/skills', { enabled: ['a'], defaultOn: ['b'] }, 'PUT');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'project-sessions', type: 'project.updated', data: { project_id: 'p1' } },
      {
        channel: 'instance',
        type: 'skills.updated',
        data: { action: 'scope', scope: 'project', projectId: 'p1' },
      },
    ]);
    // Мутация действительно записана (событие не «на пустом месте»).
    const after = await projectStore.load('p1');
    expect(after?.skills).toEqual({ enabled: ['a'], defaultOn: ['b'] });
    expect(after?.updatedAt).not.toBe(project.updatedAt);
  });

  it('400 (невалидное тело) и 404 (нет проекта) — событий нет', async () => {
    const app = makeApp();
    await makeProject();

    const invalid = await json(app, '/api/v2/projects/p1/skills', { enabled: 'nope' }, 'PUT');
    expect(invalid.status).toBe(400);
    const ghost = await json(app, '/api/v2/projects/nope/skills', { enabled: ['a'] }, 'PUT');
    expect(ghost.status).toBe(404);

    expect(published).toEqual([]);
  });
});

describe('PUT/DELETE /settings/skills — skills.updated{scope: instance}', () => {
  it('PUT публикует { action: scope, scope: instance }', async () => {
    const app = makeApp();
    const res = await json(app, '/api/v2/settings/skills', {
      disabled: { categories: ['quality'], groups: [], skills: ['db-migration'] },
      policy: 'available',
    }, 'PUT');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'scope', scope: 'instance' } },
    ]);
  });

  it('DELETE (сброс гейтов) публикует то же событие', async () => {
    const app = makeApp();
    await json(app, '/api/v2/settings/skills', {
      disabled: { categories: ['quality'], groups: [], skills: [] },
    }, 'PUT');
    published.length = 0;

    const del = await json(app, '/api/v2/settings/skills', undefined, 'DELETE');
    expect(del.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'scope', scope: 'instance' } },
    ]);
  });

  it('400 (невалидные данные, в т.ч. trust-блок) — событий нет', async () => {
    const app = makeApp();
    const invalidDisabled = await json(app, '/api/v2/settings/skills', { disabled: 'nope' }, 'PUT');
    expect(invalidDisabled.status).toBe(400);
    const invalidTrust = await json(app, '/api/v2/settings/skills', { trustedProjectDirs: 'nope' }, 'PUT');
    expect(invalidTrust.status).toBe(400);

    expect(published).toEqual([]);
  });

  it('GET /settings/skills событие не публикует', async () => {
    const app = makeApp();
    expect((await app.request('/api/v2/settings/skills')).status).toBe(200);
    expect(published).toEqual([]);
  });
});
