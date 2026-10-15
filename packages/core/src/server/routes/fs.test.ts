import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { createFsRoutes } from './fs.js';
import { resolveProjectWorkspace } from '../fs-workspace.js';
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

describe('FS workspace-root routes (ADR-075)', () => {
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

  it('browse: абсолютный путь внутри root → 200 и относительный path', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'sub'), { recursive: true });
    const res = await makeApp().request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(join(workspacesRoot, 'proj'))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: Array<{ name: string }> };
    expect(body.path).toBe('proj');
    expect(body.entries.map((e) => e.name)).toContain('sub');
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

  it('регрессия (ADR-075): mkdir внутри относительного root → 201, а не 409', async () => {
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

  it('регрессия (ADR-075): относительный root + traversal `..` при deny → 403', async () => {
    const relRoot = relative(process.cwd(), workspacesRoot);
    const res = await makeApp('deny', NO_PROTECTED, relRoot)
      .request('/api/v2/fs/workspace-root/browse?path=..');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_OUTSIDE_ROOT_DENIED');
  });

  it('регрессия (ADR-075): относительный root + абсолютный путь вне root при deny → 403', async () => {
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

  it('standalone: getProjectWorkspace без requireProjectId → /workspace-root доступен', async () => {
    // Реальный standalone (core) передаёт `getProjectWorkspace`, но не
    // `requireProjectId` — выбор workspace остаётся легитимным.
    await mkdir(join(workspacesRoot, 'my-ws'));
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), workspacesRoot, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      getProjectWorkspace: async () => null,
    }));

    const res = await app.request('/api/v2/fs/workspace-root');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(['my-ws']);
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

describe('FS project-aware routes (ADR-075: managed/standalone)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let outsideDir: string;

  const jsonHeaders = { 'Content-Type': 'application/json' };

  function makeProjectApp(
    projects: Record<string, { workspace?: string }>,
    opts: {
      policy?: WorkspaceOutsideRootPolicy;
      requireProjectId?: boolean;
      strict?: boolean;
      root?: string;
    } = {},
  ): Hono {
    const wsRoot = opts.root ?? workspacesRoot;
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), wsRoot, undefined, {
      getOutsideRootPolicy: () => opts.policy ?? 'deny',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      requireProjectId: opts.requireProjectId ?? true,
      getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
        workspacesRoot: wsRoot,
        getProject: async (id) => projects[id] ?? null,
        outsideRootPolicy: () => opts.policy ?? 'deny',
        strict: opts.strict ?? true,
      }),
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-proj-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    outsideDir = join(tmpDir, 'outside');
    await mkdir(join(workspacesRoot, 'ws'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET / отдаёт файлы workspace проекта, а не плоского root', async () => {
    await writeFile(join(workspacesRoot, 'root-only.txt'), 'r');
    await writeFile(join(workspacesRoot, 'ws', 'a.txt'), 'a');

    const res = await makeProjectApp({ p1: { workspace: 'ws' } }).request('/api/v2/fs?project_id=p1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('GET / без project_id (managed) → 400', async () => {
    const res = await makeProjectApp({ p1: { workspace: 'ws' } }).request('/api/v2/fs');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  });

  it('project не найден → 404 NOT_FOUND', async () => {
    const res = await makeProjectApp({}).request('/api/v2/fs?project_id=missing');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('workspace не задан → 400 WORKSPACE_NOT_SET', async () => {
    const res = await makeProjectApp({ p1: {} }).request('/api/v2/fs?project_id=p1');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('WORKSPACE_NOT_SET');
  });

  it('workspace вне root при deny → 403 PATH_TRAVERSAL', async () => {
    const res = await makeProjectApp({ p1: { workspace: outsideDir } }).request('/api/v2/fs?project_id=p1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PATH_TRAVERSAL');
  });

  it('write + read roundtrip в workspace проекта', async () => {
    const app = makeProjectApp({ p1: { workspace: 'ws' } });
    const writeRes = await app.request('/api/v2/fs/write', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ projectId: 'p1', path: 'sub/hello.txt', content: 'hello' }),
    });
    expect(writeRes.status).toBe(200);

    const readRes = await app.request('/api/v2/fs/read?project_id=p1&path=sub/hello.txt');
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as { content: string; encoding: string };
    expect(body.content).toBe('hello');
    expect(body.encoding).toBe('utf-8');
    expect(await readFile(join(workspacesRoot, 'ws', 'sub', 'hello.txt'), 'utf-8')).toBe('hello');
  });

  it('read бинарного файла (NUL) → encoding binary, content пусто', async () => {
    await writeFile(join(workspacesRoot, 'ws', 'data.xyz'), Buffer.from([1, 0, 2, 3]));

    const res = await makeProjectApp({ p1: { workspace: 'ws' } })
      .request('/api/v2/fs/read?project_id=p1&path=data.xyz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; encoding: string; size: number };
    expect(body.encoding).toBe('binary');
    expect(body.content).toBe('');
    expect(body.size).toBe(4);
  });

  it('read директории → 400 IS_DIRECTORY', async () => {
    await mkdir(join(workspacesRoot, 'ws', 'subdir'), { recursive: true });
    const res = await makeProjectApp({ p1: { workspace: 'ws' } })
      .request('/api/v2/fs/read?project_id=p1&path=subdir');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('IS_DIRECTORY');
  });

  it('traversal за пределы workspace → 403 PATH_TRAVERSAL', async () => {
    const res = await makeProjectApp({ p1: { workspace: 'ws' } })
      .request(`/api/v2/fs?project_id=p1&path=${encodeURIComponent('../root-only.txt')}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PATH_TRAVERSAL');
  });

  it('mkdir создаёт каталог (201), повтор → 409 ALREADY_EXISTS', async () => {
    const app = makeProjectApp({ p1: { workspace: 'ws' } });
    const first = await app.request('/api/v2/fs/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ projectId: 'p1', path: 'newdir' }),
    });
    expect(first.status).toBe(201);
    expect((await stat(join(workspacesRoot, 'ws', 'newdir'))).isDirectory()).toBe(true);

    const second = await app.request('/api/v2/fs/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ projectId: 'p1', path: 'newdir' }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('ALREADY_EXISTS');
  });

  it('mkdir с пустым path → 400 PERMISSION_DENIED (паритет с backend)', async () => {
    const res = await makeProjectApp({ p1: { workspace: 'ws' } }).request('/api/v2/fs/mkdir', {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ projectId: 'p1', path: '' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  });

  it('move переименовывает файл в workspace', async () => {
    await writeFile(join(workspacesRoot, 'ws', 'old.txt'), 'x');
    const res = await makeProjectApp({ p1: { workspace: 'ws' } }).request('/api/v2/fs/move', {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ projectId: 'p1', sourcePath: 'old.txt', targetPath: 'renamed.txt' }),
    });
    expect(res.status).toBe(200);
    await expect(stat(join(workspacesRoot, 'ws', 'old.txt'))).rejects.toThrow();
    expect((await stat(join(workspacesRoot, 'ws', 'renamed.txt'))).isFile()).toBe(true);
  });

  it('delete файла (200) и непустой директории (400 DIR_NOT_EMPTY)', async () => {
    const app = makeProjectApp({ p1: { workspace: 'ws' } });
    await writeFile(join(workspacesRoot, 'ws', 'del.txt'), 'x');
    const del = await app.request('/api/v2/fs?project_id=p1&path=del.txt', { method: 'DELETE' });
    expect(del.status).toBe(200);

    await mkdir(join(workspacesRoot, 'ws', 'dir'));
    await writeFile(join(workspacesRoot, 'ws', 'dir', 'f.txt'), 'x');
    const delDir = await app.request('/api/v2/fs?project_id=p1&path=dir', { method: 'DELETE' });
    expect(delDir.status).toBe(400);
    expect(((await delDir.json()) as { error: { code: string } }).error.code).toBe('DIR_NOT_EMPTY');
  });

  it('upload multipart кладёт файл в workspace проекта (201)', async () => {
    const app = makeProjectApp({ p1: { workspace: 'ws' } });
    const fd = new FormData();
    fd.set('project_id', 'p1');
    fd.set('path', 'uploads');
    fd.set('file', new File(['payload'], 'up.txt', { type: 'text/plain' }));

    const res = await app.request('/api/v2/fs/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; name: string };
    expect(body.name).toBe('up.txt');
    expect(await readFile(join(workspacesRoot, 'ws', 'uploads', 'up.txt'), 'utf-8')).toBe('payload');
  });

  it('download отдаёт содержимое с Content-Disposition', async () => {
    await writeFile(join(workspacesRoot, 'ws', 'dl.txt'), 'download-me');
    const res = await makeProjectApp({ p1: { workspace: 'ws' } })
      .request('/api/v2/fs/download?project_id=p1&path=dl.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('dl.txt');
    expect(await res.text()).toBe('download-me');
  });

  it('maxDepth рекурсивно раскрывает вложенные каталоги', async () => {
    await mkdir(join(workspacesRoot, 'ws', 'dir1', 'sub'), { recursive: true });
    await writeFile(join(workspacesRoot, 'ws', 'dir1', 'top.txt'), 'x');
    await writeFile(join(workspacesRoot, 'ws', 'dir1', 'sub', 'deep.txt'), 'x');

    const res = await makeProjectApp({ p1: { workspace: 'ws' } })
      .request('/api/v2/fs?project_id=p1&maxDepth=1');
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain('top.txt');
    expect(names).not.toContain('deep.txt');
  });

  it('standalone (strict=false): нет project_id → плоский root', async () => {
    await writeFile(join(workspacesRoot, 'flat.txt'), 'x');
    const app = makeProjectApp({}, { requireProjectId: false, strict: false });
    const res = await app.request('/api/v2/fs');
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain('flat.txt');
  });

  it('standalone (confirm): абсолютный workspace вне root разрешён', async () => {
    await writeFile(join(outsideDir, 'out.txt'), 'x');
    const app = makeProjectApp(
      { p1: { workspace: outsideDir } },
      { policy: 'confirm', requireProjectId: false, strict: false },
    );
    const res = await app.request('/api/v2/fs?project_id=p1');
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain('out.txt');
  });

  it('managed (requireProjectId): перечень workspace недоступен → /workspace-root* отдают 403', async () => {
    // Managed не использует выбор workspace (авто-провижнинг, ADR-075): роуты
    // `/workspace-root*` выключены, чтобы не раскрывать каталоги чужих проектов
    // и не позволять создавать каталоги в них.
    await mkdir(join(workspacesRoot, 'proj', 'sub'), { recursive: true });
    const app = makeProjectApp({});

    const list = await app.request('/api/v2/fs/workspace-root');
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const browse = await app.request(
      `/api/v2/fs/workspace-root/browse?path=${encodeURIComponent(join(workspacesRoot, 'proj'))}`,
    );
    expect(browse.status).toBe(403);
    expect(((await browse.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const target = join(workspacesRoot, 'evil');
    const mkdirRes = await app.request('/api/v2/fs/workspace-root/mkdir', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ path: target }),
    });
    expect(mkdirRes.status).toBe(403);
    expect(((await mkdirRes.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    await expect(stat(target)).rejects.toThrow();
  });
});

describe('FS межпроектный перенос (POST /move, targetProjectId)', () => {
  let tmpDir: string;
  let workspacesRoot: string;

  const jsonHeaders = { 'Content-Type': 'application/json' };
  const projects: Record<string, { workspace?: string }> = {
    p1: { workspace: 'p1' },
    p2: { workspace: 'p2' },
  };

  function makeApp(): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), workspacesRoot, undefined, {
      getOutsideRootPolicy: () => 'deny',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      requireProjectId: true,
      getProjectWorkspace: (projectId) => resolveProjectWorkspace(projectId, {
        workspacesRoot,
        getProject: async (id) => projects[id] ?? null,
        outsideRootPolicy: () => 'deny',
        strict: true,
      }),
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-move-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    await mkdir(join(workspacesRoot, 'p1'), { recursive: true });
    await mkdir(join(workspacesRoot, 'p2'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('перенос файла между проектами: появился в целевом, исчез в исходном', async () => {
    await writeFile(join(workspacesRoot, 'p1', 'a.txt'), 'payload');
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        projectId: 'p1', targetProjectId: 'p2', sourcePath: 'a.txt', targetPath: 'nested/a.txt',
      }),
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(workspacesRoot, 'p2', 'nested', 'a.txt'), 'utf-8')).toBe('payload');
    await expect(stat(join(workspacesRoot, 'p1', 'a.txt'))).rejects.toThrow();
  });

  it('перенос каталога с вложенным файлом между проектами', async () => {
    await mkdir(join(workspacesRoot, 'p1', 'dir', 'sub'), { recursive: true });
    await writeFile(join(workspacesRoot, 'p1', 'dir', 'sub', 'f.txt'), 'deep');
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        projectId: 'p1', target_project_id: 'p2', sourcePath: 'dir', targetPath: 'moved',
      }),
    });
    expect(res.status).toBe(200);
    expect(await readFile(join(workspacesRoot, 'p2', 'moved', 'sub', 'f.txt'), 'utf-8')).toBe('deep');
    await expect(stat(join(workspacesRoot, 'p1', 'dir'))).rejects.toThrow();
  });

  it('цель уже существует → 409 ALREADY_EXISTS, источник не тронут', async () => {
    await writeFile(join(workspacesRoot, 'p1', 'a.txt'), 'src');
    await writeFile(join(workspacesRoot, 'p2', 'a.txt'), 'dst');
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        projectId: 'p1', targetProjectId: 'p2', sourcePath: 'a.txt', targetPath: 'a.txt',
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ALREADY_EXISTS');
    expect(await readFile(join(workspacesRoot, 'p1', 'a.txt'), 'utf-8')).toBe('src');
    expect(await readFile(join(workspacesRoot, 'p2', 'a.txt'), 'utf-8')).toBe('dst');
  });

  it('цель-каталог существует, переносим файл → 409 ALREADY_EXISTS', async () => {
    await writeFile(join(workspacesRoot, 'p1', 'a.txt'), 'src');
    await mkdir(join(workspacesRoot, 'p2', 'a.txt'), { recursive: true });
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        projectId: 'p1', targetProjectId: 'p2', sourcePath: 'a.txt', targetPath: 'a.txt',
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ALREADY_EXISTS');
    expect(await readFile(join(workspacesRoot, 'p1', 'a.txt'), 'utf-8')).toBe('src');
  });

  it('источник не найден → 404 NOT_FOUND', async () => {
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        projectId: 'p1', targetProjectId: 'p2', sourcePath: 'missing.txt', targetPath: 'x.txt',
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('перенос каталога в собственный потомок → 400', async () => {
    await mkdir(join(workspacesRoot, 'p1', 'dir'), { recursive: true });
    const res = await makeApp().request('/api/v2/fs/move', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ projectId: 'p1', sourcePath: 'dir', targetPath: 'dir/sub' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('FS upload: лимит размера (DoS-защита)', () => {
  let tmpDir: string;
  let workspacesRoot: string;

  function makeApp(maxUploadBytes: number): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), workspacesRoot, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      maxUploadBytes,
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-upload-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('файл в пределах лимита → 201, содержимое записано', async () => {
    const fd = new FormData();
    fd.set('file', new File(['hello'], 'ok.txt', { type: 'text/plain' }));

    const res = await makeApp(1024).request('/api/v2/fs/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    expect(await readFile(join(workspacesRoot, 'ok.txt'), 'utf-8')).toBe('hello');
  });

  it('файл больше лимита → 413 PAYLOAD_TOO_LARGE, файл не записан', async () => {
    const fd = new FormData();
    fd.set('file', new File(['x'.repeat(64)], 'big.bin', { type: 'application/octet-stream' }));

    const res = await makeApp(16).request('/api/v2/fs/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    await expect(stat(join(workspacesRoot, 'big.bin'))).rejects.toThrow();
  });

  it('обход через отсутствие content-length: срабатывает проверка фактического размера', async () => {
    // Собираем запрос и убираем `content-length` — быстрый pre-check пропускает,
    // отсекает проверка размера `File`/прочитанных байт.
    const fd = new FormData();
    fd.set('file', new File(['y'.repeat(64)], 'sneaky.bin', { type: 'application/octet-stream' }));
    const request = new Request('http://localhost/api/v2/fs/upload', { method: 'POST', body: fd });
    request.headers.delete('content-length');

    const res = await makeApp(16).request(request);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    await expect(stat(join(workspacesRoot, 'sneaky.bin'))).rejects.toThrow();
  });
});
