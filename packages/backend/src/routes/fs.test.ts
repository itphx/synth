import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFsRoutes } from './fs.js';
import { ProjectStore } from '../storage/project-store.js';

function createMockKit() {
  return {
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

let tmpDir: string;

function makeApp() {
  const app = new Hono();
  const store = new ProjectStore({ dataDir: tmpDir });
  app.route('/api/v2/fs', createFsRoutes(createMockKit() as never, store, tmpDir));
  return { app, store };
}

const jsonHeaders = { 'Content-Type': 'application/json' };

describe('FS mkdir Zod-валидация (AD-075)', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST /fs/mkdir с пустым телом → 400 в общем FS-формате', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
    expect(typeof body.error.error).toBe('string');
  });

  it('POST /fs/mkdir с валидным телом создаёт директорию', async () => {
    const { app, store } = makeApp();
    const project = store.create('P', 'owner', { workspace: 'ws' });
    await store.save(project);
    await mkdir(resolve(tmpDir, 'ws'), { recursive: true });

    const res = await app.request('/api/v2/fs/mkdir', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ projectId: project.id, path: 'sub' }),
    });
    expect(res.status).toBe(201);
    expect((await stat(resolve(tmpDir, 'ws', 'sub'))).isDirectory()).toBe(true);
  });

  it('POST /fs/workspace-root/mkdir с пустым телом → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });

  it('POST /fs/workspace-root/mkdir с пустым path → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /fs/workspace-root/mkdir с валидным path → 201 и каталог создан', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'new-root-dir' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body).toMatchObject({ created: true, path: 'new-root-dir' });
    expect((await stat(resolve(tmpDir, 'new-root-dir'))).isDirectory()).toBe(true);
  });

  it('browse с абсолютным путём внутри root → 200 и относительный path', async () => {
    const { app } = makeApp();
    await mkdir(resolve(tmpDir, 'proj', 'sub'), { recursive: true });
    const res = await app.request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(resolve(tmpDir, 'proj'))}`,
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.path).toBe('proj');
    expect(body.entries.map((e: any) => e.name)).toContain('sub');
  });

  it('browse с абсолютным путём вне root (managed deny) → 403 WORKSPACE_OUTSIDE_ROOT_DENIED', async () => {
    const { app } = makeApp();
    const outside = resolve(tmpDir, '..');
    const res = await app.request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(outside)}`,
    );
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('browse с traversal .. → 403 PATH_TRAVERSAL', async () => {
    const { app } = makeApp();
    const res = await app.request(`/api/v2/fs/workspace-root/browse?path=${encodeURIComponent('..')}`);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('PATH_TRAVERSAL');
  });

  it('mkdir с абсолютным путём внутри root → 201 и каталог создан', async () => {
    const { app } = makeApp();
    const abs = resolve(tmpDir, 'abs-inside');
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: abs }),
    });
    expect(res.status).toBe(201);
    expect((await stat(abs)).isDirectory()).toBe(true);
  });

  it('mkdir с абсолютным путём вне root → 403, каталог не создаётся', async () => {
    const { app } = makeApp();
    const outside = resolve(tmpDir, '..', 'abs-outside');
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: outside }),
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('mkdir с traversal ../evil → 403 PATH_TRAVERSAL, каталог не создаётся', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: '../evil' }),
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('PATH_TRAVERSAL');
  });

  it('mkdir существующего каталога → 409 ALREADY_EXISTS (паритет с core)', async () => {
    const { app } = makeApp();
    await mkdir(resolve(tmpDir, 'already'), { recursive: true });
    const res = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'already' }),
    });
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error.code).toBe('ALREADY_EXISTS');
  });

  it('POST /fs/move с пустым телом → 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/fs/move', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('PERMISSION_DENIED');
  });
});
