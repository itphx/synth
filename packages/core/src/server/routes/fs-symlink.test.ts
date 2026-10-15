import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createFsRoutes } from './fs.js';
import type { AuthKit } from '../../auth/local.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';

/** Минимальный auth-мок (как в fs.test.ts). */
function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

const NO_PROTECTED: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

/**
 * FS-роуты не должны следовать за симлинком из workspace наружу: чтение/запись/
 * mkdir/move отклоняются; симлинки внутрь продолжают работать.
 */
describe('FS routes — containment с симлинками', () => {
  let tmpDir: string;
  let root: string;
  let outside: string;
  let workspacesRoot: string;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  function flatApp(): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), root, undefined, {
      getProtectedPathsPolicy: () => NO_PROTECTED,
    }));
    return app;
  }

  function projectApp(): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), workspacesRoot, undefined, {
      getProtectedPathsPolicy: () => NO_PROTECTED,
      requireProjectId: true,
      getProjectWorkspace: async (id) => (id === 'p1' ? join(workspacesRoot, 'ws') : null),
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-symlink-'));
    root = join(tmpDir, 'root');
    workspacesRoot = join(tmpDir, 'workspaces');
    outside = join(tmpDir, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(join(workspacesRoot, 'ws'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET');

    for (const base of [root, join(workspacesRoot, 'ws')]) {
      await writeFile(join(base, 'inside.txt'), 'inside-data');
      await mkdir(join(base, 'sub'), { recursive: true });
      await writeFile(join(base, 'sub', 'f.txt'), 'sub-data');
      await symlink(outside, join(base, 'escape'));
      await symlink(join(outside, 'secret.txt'), join(base, 'leak.txt'));
      await symlink(join(base, 'sub'), join(base, 'inlink'));
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('горизонтальный root: read через симлинк-каталог → 403', async () => {
    const res = await flatApp().request('/api/v2/fs/read?path=escape/secret.txt');
    expect(res.status).toBe(403);
    expect((await res.text())).not.toContain('TOP-SECRET');
  });

  it('горизонтальный root: read через симлинк-файл → 403', async () => {
    const res = await flatApp().request('/api/v2/fs/read?path=leak.txt');
    expect(res.status).toBe(403);
  });

  it('горизонтальный root: list каталога через симлинк → 403', async () => {
    const res = await flatApp().request('/api/v2/fs?path=escape');
    expect(res.status).toBe(403);
  });

  it('горизонтальный root: write через симлинк → 403, цель не создаётся', async () => {
    const res = await flatApp().request('/api/v2/fs/write', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ path: 'escape/evil.txt', content: 'pwned' }),
    });
    expect(res.status).toBe(403);
    await expect(stat(join(outside, 'evil.txt'))).rejects.toThrow();
  });

  it('горизонтальный root: mkdir через симлинк → 403, каталог не создаётся', async () => {
    const res = await flatApp().request('/api/v2/fs/mkdir', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ path: 'escape/newdir' }),
    });
    expect(res.status).toBe(403);
    await expect(stat(join(outside, 'newdir'))).rejects.toThrow();
  });

  it('горизонтальный root: move c источником через симлинк → 403', async () => {
    const res = await flatApp().request('/api/v2/fs/move', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ sourcePath: 'escape/secret.txt', targetPath: 'moved.txt' }),
    });
    expect(res.status).toBe(403);
    expect((await stat(join(outside, 'secret.txt'))).isFile()).toBe(true);
  });

  it('горизонтальный root: move c целью через симлинк → 403', async () => {
    const res = await flatApp().request('/api/v2/fs/move', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ sourcePath: 'inside.txt', targetPath: 'escape/x.txt' }),
    });
    expect(res.status).toBe(403);
    await expect(stat(join(outside, 'x.txt'))).rejects.toThrow();
  });

  it('горизонтальный root: read через симлинк внутрь — разрешён', async () => {
    const res = await flatApp().request('/api/v2/fs/read?path=inlink/f.txt');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe('sub-data');
  });

  it('project-aware: read через симлинк наружу → 403 PATH_TRAVERSAL', async () => {
    const res = await projectApp().request('/api/v2/fs/read?project_id=p1&path=escape/secret.txt');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PATH_TRAVERSAL');
  });

  it('project-aware: write через симлинк наружу → 403 PATH_TRAVERSAL', async () => {
    const res = await projectApp().request('/api/v2/fs/write', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ projectId: 'p1', path: 'escape/evil.txt', content: 'pwned' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PATH_TRAVERSAL');
    await expect(stat(join(outside, 'evil.txt'))).rejects.toThrow();
  });

  it('project-aware: read через симлинк внутрь — разрешён', async () => {
    const res = await projectApp().request('/api/v2/fs/read?project_id=p1&path=inlink/f.txt');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe('sub-data');
  });

  it('project-aware: обычный read внутри workspace не затронут', async () => {
    const res = await projectApp().request('/api/v2/fs/read?project_id=p1&path=inside.txt');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe('inside-data');
    expect(await readFile(join(workspacesRoot, 'ws', 'inside.txt'), 'utf-8')).toBe('inside-data');
  });
});
