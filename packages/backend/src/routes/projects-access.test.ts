/**
 * PROP-133 §3.1: аудит изменения состояния доступа к проекту в **managed**
 * (backend): обёртка роутов обязана прокинуть порт `SecurityAuditRepository`
 * в core-фабрику — иначе изменения доступа не попадают в журнал.
 *
 * Проверяется: запись пишется (скоуп `projects`, актор — текущий пользователь)
 * и не пишется, когда меняется только контент.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, MemorySecurityAuditRepository } from '@itphx/synth-core';
import type { SessionManager } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

import type { AuthKit } from '../auth/middleware.js';
import { createProjectRoutes } from './projects.js';

const OWNER_ID = 'owner-user';
const EDITOR_ID = 'editor-user';

const owner: User = {
  id: OWNER_ID,
  username: OWNER_ID,
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

function createMockKit(): AuthKit {
  return {
    getCurrentUser: () => owner,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockSessionManager(): SessionManager {
  return { listSessions: async () => [] } as unknown as SessionManager;
}

describe('PROP-133: аудит доступа к проекту (managed)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let audit: MemorySecurityAuditRepository;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-project-access-'));
    store = new ProjectStore({ dataDir: tmpDir });
    audit = new MemorySecurityAuditRepository();
    app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(
      createMockKit(),
      store,
      createMockSessionManager(),
      join(tmpDir, 'workspaces'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audit,
    ));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const put = (id: string, body: unknown): Promise<Response> =>
    Promise.resolve(app.request(`/api/v2/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

  it('изменение состояния доступа пишет запись аудита', async () => {
    const project = store.create('P', OWNER_ID);
    await store.save(project);

    const res = await put(project.id, { members: { [EDITOR_ID]: 'editor' } });
    expect(res.status).toBe(200);

    const entries = await audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.scope).toBe('projects');
    expect(entries[0]?.action).toBe('update');
    expect(entries[0]?.actor).toBe(OWNER_ID);
    const after = entries[0]?.after as { members: Record<string, string> } | undefined;
    expect(after?.members[EDITOR_ID]).toBe('editor');
  });

  it('правка контента без изменения доступа аудит не пишет', async () => {
    const project = store.create('P', OWNER_ID);
    await store.save(project);

    const res = await put(project.id, { description: 'текст' });
    expect(res.status).toBe(200);
    expect(await audit.list()).toHaveLength(0);
  });
});
