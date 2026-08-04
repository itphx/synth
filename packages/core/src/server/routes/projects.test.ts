import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

describe('Project API Routes (workspace normalization)', () => {
  let tmpDir: string;
  let store: ProjectStore;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-test-'));
    store = new ProjectStore({ dataDir: tmpDir });
    app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(createMockAuth(), store));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createProject(workspace: string): Promise<{ id: string; workspace: string | null }> {
    const res = await app.request('/api/v2/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P', workspace }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; workspace: string | null };
    return body;
  }

  it('относительный workspace сохраняется как есть', async () => {
    const p = await createProject('WS1');
    expect(p.workspace).toBe('WS1');
  });

  it('относительный workspace с ведущими ./ очищается', async () => {
    const p = await createProject('./WS1');
    expect(p.workspace).toBe('WS1');
  });

  it('абсолютный путь (даже однослоговый /WS1) остаётся как есть', async () => {
    const p = await createProject('/WS1');
    expect(p.workspace).toBe('/WS1');
  });

  it('абсолютный workspace остаётся абсолютным', async () => {
    const p = await createProject('/home/user/ws');
    expect(p.workspace).toBe('/home/user/ws');
  });

  it('PUT: нормализация применяется при обновлении workspace', async () => {
    const p = await createProject('WS1');
    const put = await app.request(`/api/v2/projects/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: './WS2/' }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { workspace: string | null };
    expect(body.workspace).toBe('WS2');
  });
});
