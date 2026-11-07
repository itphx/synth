import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MARKDOWN_LIMITS } from '@itphx/synth-shared';
import { ProjectStore } from '../../storage/project-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { createProjectLogRoutes } from './project-log.js';
import type { ProjectLogRoutesOptions } from './project-log.js';

/**
 * HTTP-контур журнала и инвариантов проекта (PROP-054): постраничный журнал,
 * CRUD записей, инварианты и событие `project.updated` с `kind`.
 */
describe('HTTP журнала и инвариантов проекта (PROP-054)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-log-routes-'));
    store = new ProjectStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();

    const project = store.create('Журнал', 'owner');
    projectId = project.id;
    await store.save(project);

    const session = await sessionManager.createSession({ title: 'Сессия' });
    sessionId = session.id;
    await sessionManager.withLock(session.id, async (s) => {
      s.projectId = projectId;
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(opts: Partial<ProjectLogRoutesOptions> = {}): Hono {
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectLogRoutes(
        { requireAuth: async (_c: Context, next: Next) => { await next(); } },
        store,
        { sessionManager, eventBus, ...opts },
      ),
    );
    return app;
  }

  it('POST /log создаёт запись; GET /log отдаёт страницу (новые сверху)', async () => {
    const app = makeApp();
    for (const text of ['первая', 'вторая']) {
      const res = await app.request(`/api/v2/projects/${projectId}/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      expect(res.status).toBe(201);
    }

    const list = await app.request(`/api/v2/projects/${projectId}/log`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      entries: Array<{ text: string; created_at: string }>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.next_offset).toBeNull();
    expect(body.entries[0]!.text).toBe('вторая');
  });

  it('GET /log уважает limit/offset', async () => {
    const app = makeApp();
    for (const text of ['a', 'b', 'c']) {
      await app.request(`/api/v2/projects/${projectId}/log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }
    const res = await app.request(`/api/v2/projects/${projectId}/log?limit=2&offset=1`);
    const body = (await res.json()) as { entries: unknown[]; total: number; next_offset: number | null };
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.next_offset).toBeNull();
  });

  it('нечисловой limit — 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/log?limit=abc`);
    expect(res.status).toBe(400);
  });

  it('текст длиннее лимита Markdown — 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/projects/${projectId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(MARKDOWN_LIMITS.journalEntry + 1) }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /log/:entryId меняет текст и проставляет updated_at', async () => {
    const app = makeApp();
    const created = await app.request(`/api/v2/projects/${projectId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'черновик' }),
    });
    const body = (await created.json()) as { entry: { id: string } };

    const patched = await app.request(`/api/v2/projects/${projectId}/log/${body.entry.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'готово' }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { entry: { text: string; updated_at: string | null } };
    expect(after.entry.text).toBe('готово');
    expect(after.entry.updated_at).toBeTruthy();
  });

  it('DELETE /log/:entryId удаляет запись; неизвестная — 404', async () => {
    const app = makeApp();
    const created = await app.request(`/api/v2/projects/${projectId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'запись' }),
    });
    const body = (await created.json()) as { entry: { id: string } };

    const deleted = await app.request(`/api/v2/projects/${projectId}/log/${body.entry.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);

    const missing = await app.request(`/api/v2/projects/${projectId}/log/nope`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  it('инварианты: GET/PUT, лимит 64 КиБ', async () => {
    const app = makeApp();
    const put = await app.request(`/api/v2/projects/${projectId}/invariants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invariants: '# Правила' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { invariants: string; updated_at: string };
    expect(body.invariants).toBe('# Правила');
    expect(body.updated_at).toBeTruthy();

    const get = await app.request(`/api/v2/projects/${projectId}/invariants`);
    const read = (await get.json()) as { invariants: string };
    expect(read.invariants).toBe('# Правила');

    const tooLong = await app.request(`/api/v2/projects/${projectId}/invariants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invariants: 'x'.repeat(MARKDOWN_LIMITS.invariants + 1) }),
    });
    expect(tooLong.status).toBe(400);
  });

  it('правка журнала/инвариантов публикует project.updated с kind', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    const app = makeApp();
    await app.request(`/api/v2/projects/${projectId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'запись' }),
    });
    await app.request(`/api/v2/projects/${projectId}/invariants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invariants: 'правила' }),
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.project_id).toBe(projectId);
    expect(events[0]!.kind).toBe('log');
    expect(events[1]!.kind).toBe('invariants');
  });

  it('VIEWER читает журнал, но не мутирует его', async () => {
    const app = makeApp({ canRead: () => true, canEditContent: () => false });
    const read = await app.request(`/api/v2/projects/${projectId}/log`);
    expect(read.status).toBe(200);

    const write = await app.request(`/api/v2/projects/${projectId}/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'запись' }),
    });
    expect(write.status).toBe(403);
  });
});
