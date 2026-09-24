import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { createFsRoutes } from './fs.js';
import type { AuthKit } from '../../auth/local.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Пустая политика защищённых путей (изоляция тестов от системных definitions). */
const NO_PROTECTED: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

describe('FS workspace-root routes (AD-075)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let outsideDir: string;

  function makeApp(
    policy: WorkspaceOutsideRootPolicy = 'confirm',
    protectedPolicy: ProtectedPathsPolicy = NO_PROTECTED,
    root: string | undefined = workspacesRoot,
  ): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), root, undefined, {
      getOutsideRootPolicy: () => policy,
      getProtectedPathsPolicy: () => protectedPolicy,
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-test-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });
    outsideDir = join(tmpDir, 'outside');
    await mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /workspace-root: только каталоги, скрытые по умолчанию', async () => {
    await mkdir(join(workspacesRoot, 'b-dir'));
    await mkdir(join(workspacesRoot, 'a-dir'));
    await mkdir(join(workspacesRoot, '.hidden'));
    await writeFile(join(workspacesRoot, 'file.txt'), 'x');

    const res = await makeApp().request('/api/v2/fs/workspace-root');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string; entries: Array<{ name: string; isDirectory: boolean }> };
    expect(body.root).toBe(workspacesRoot);
    expect(body.entries.map((e) => e.name)).toEqual(['a-dir', 'b-dir']);
    expect(body.entries.every((e) => e.isDirectory)).toBe(true);
  });

  it('GET /workspace-root: includeHidden=true показывает скрытые', async () => {
    await mkdir(join(workspacesRoot, '.hidden'));
    await mkdir(join(workspacesRoot, 'visible'));

    const res = await makeApp().request('/api/v2/fs/workspace-root?includeHidden=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(['.hidden', 'visible']);
  });

  it('browse внутри root: подкаталоги и относительные пути', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'sub'), { recursive: true });
    await writeFile(join(workspacesRoot, 'proj', 'file.txt'), 'x');

    const res = await makeApp().request('/api/v2/fs/workspace-root/browse?path=proj');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string; path: string; entries: Array<{ name: string; path: string }> };
    expect(body.root).toBe(workspacesRoot);
    expect(body.path).toBe('proj');
    expect(body.entries.map((e) => e.name)).toEqual(['sub']);
    expect(body.entries[0]!.path).toBe('proj/sub');
  });

  it('browse: политика deny — выход за root через .. → 403', async () => {
    const res = await makeApp('deny').request('/api/v2/fs/workspace-root/browse?path=..');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('browse: политика deny — абсолютный путь вне root → 403', async () => {
    const res = await makeApp('deny').request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(outsideDir)}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('browse: политика confirm — абсолютный путь вне root разрешён', async () => {
    await mkdir(join(outsideDir, 'child'));

    const res = await makeApp('confirm').request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(outsideDir)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: Array<{ name: string; path: string }> };
    expect(body.path).toBe(outsideDir);
    expect(body.entries.map((e) => e.name)).toEqual(['child']);
    expect(body.entries[0]!.path).toBe(join(outsideDir, 'child'));
  });

  it('browse: политика confirm — выход за root через .. разрешён (standalone)', async () => {
    await mkdir(join(tmpDir, 'sibling'));

    const res = await makeApp('confirm').request('/api/v2/fs/workspace-root/browse?path=..');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toContain('sibling');
  });

  it('browse несуществующей директории → 404', async () => {
    const res = await makeApp().request('/api/v2/fs/workspace-root/browse?path=missing');
    expect(res.status).toBe(404);
  });

  it('mkdir внутри root создаёт каталог (201)', async () => {
    const res = await makeApp().request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'new-proj' }),
    });
    expect(res.status).toBe(201);
    expect((await stat(join(workspacesRoot, 'new-proj'))).isDirectory()).toBe(true);
  });

  it('регрессия (AD-075): mkdir внутри относительного root → 201, а не 409', async () => {
    // Относительный root, как при SYNTH_DATA_DIR=tmp/... — до фикса containment
    // сравнивал относительный root с абсолютным target и давал 409.
    const relRoot = relative(process.cwd(), workspacesRoot);
    expect(relRoot.startsWith('/')).toBe(false);

    const res = await makeApp('confirm', NO_PROTECTED, relRoot).request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'rel-sub' }),
    });
    expect(res.status).toBe(201);
    expect((await stat(join(workspacesRoot, 'rel-sub'))).isDirectory()).toBe(true);
  });

  it('регрессия (AD-075): относительный root + traversal `..` при deny → 403', async () => {
    const relRoot = relative(process.cwd(), workspacesRoot);
    const res = await makeApp('deny', NO_PROTECTED, relRoot)
      .request('/api/v2/fs/workspace-root/browse?path=..');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('регрессия (AD-075): относительный root + абсолютный путь вне root при deny → 403', async () => {
    const relRoot = relative(process.cwd(), workspacesRoot);
    const res = await makeApp('deny', NO_PROTECTED, relRoot).request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(outsideDir)}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('mkdir вне root (confirm без флага) → 409, каталог не создаётся', async () => {
    const target = join(outsideDir, 'nope');
    const res = await makeApp('confirm').request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED');
    await expect(stat(target)).rejects.toThrow();
  });

  it('mkdir вне root (confirm + флаг) → 201, каталог создан', async () => {
    const target = join(outsideDir, 'ok');
    const res = await makeApp('confirm').request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, confirmOutsideRoot: true }),
    });
    expect(res.status).toBe(201);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('mkdir вне root (deny) → 403, каталог не создаётся', async () => {
    const target = join(outsideDir, 'denied');
    const res = await makeApp('deny').request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, confirmOutsideRoot: true }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
    await expect(stat(target)).rejects.toThrow();
  });

  it('mkdir без path → 400', async () => {
    const res = await makeApp().request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('browse защищённого пути (~/.ssh) → 403 даже при confirm', async () => {
    const policy: ProtectedPathsPolicy = { ...NO_PROTECTED, deniedPrefixes: ['~/.ssh'] };
    const res = await makeApp('confirm', policy).request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(join(homedir(), '.ssh'))}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROTECTED_PATH_DENIED');
  });

  it('GET /workspace-root скрывает защищённые каталоги', async () => {
    await mkdir(join(workspacesRoot, 'secret'));
    await mkdir(join(workspacesRoot, 'open'));
    const policy: ProtectedPathsPolicy = {
      ...NO_PROTECTED,
      deniedPrefixes: [join(workspacesRoot, 'secret')],
    };

    const res = await makeApp('confirm', policy).request('/api/v2/fs/workspace-root');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(['open']);
  });

  it('mkdir защищённого пути → 403, каталог не создаётся', async () => {
    const target = join(workspacesRoot, 'blocked');
    const policy: ProtectedPathsPolicy = { ...NO_PROTECTED, deniedPrefixes: [target] };

    const res = await makeApp('confirm', policy).request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROTECTED_PATH_DENIED');
    await expect(stat(target)).rejects.toThrow();
  });

  it('без workspacesRoot новые маршруты → 500 WORKSPACE_ROOT_NOT_CONFIGURED', async () => {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), undefined, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
    }));
    const res = await app.request('/api/v2/fs/workspace-root');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_ROOT_NOT_CONFIGURED');
  });

  it('GET / учитывает includeHidden (по умолчанию скрытые не отдаются)', async () => {
    await writeFile(join(workspacesRoot, '.hidden.txt'), 'x');
    await writeFile(join(workspacesRoot, 'visible.txt'), 'x');

    const plain = await makeApp().request('/api/v2/fs');
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as { entries: Array<{ name: string }> };
    expect(plainBody.entries.map((e) => e.name)).toEqual(['visible.txt']);

    const hidden = await makeApp().request('/api/v2/fs?includeHidden=true');
    expect(hidden.status).toBe(200);
    const hiddenBody = (await hidden.json()) as { entries: Array<{ name: string }> };
    expect(hiddenBody.entries.map((e) => e.name).sort()).toEqual(['.hidden.txt', 'visible.txt']);
  });
});
