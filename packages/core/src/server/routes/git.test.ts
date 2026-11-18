import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { access, chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitRoutes } from './git.js';
import type { GitRoutesOptions } from './git.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SSHKeyStore } from '../../storage/ssh-key-store.js';
import { ExecutionError, type ExecRequest, type ExecResult, type ExecutionPort } from '../../execution/ports/index.js';

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Порт, «истекающий по таймауту» на заданной git-подкоманде (мок, без сети). */
class TimingOutPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];
  readonly isRemote = false;

  constructor(private readonly failOn: 'clone' | 'fetch') {}

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    const args = req.command.kind === 'argv' ? req.command.args ?? [] : [];
    if (args.includes(this.failOn)) {
      throw new ExecutionError({
        message: `Command failed: git ${this.failOn}`,
        reason: 'timeout',
        killed: true,
      });
    }
    // Прочие git-вызовы (rev-parse) — успешны: путь «репозиторий есть».
    return { stdout: 'true\n', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  }
}

/** Рабочий репозиторий с одним коммитом (для состояния «занято репозиторием»). */
async function createRepoWithCommit(dir: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  const git = (args: string[]) => execFileAsync('git', args, { cwd: dir });
  await mkdir(dir, { recursive: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
}

/** Выполнение git-команды в каталоге (тесты): без сети, реальный бинарь. */
function gitAt(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)('git', args, { cwd });
}

/**
 * Реально ли окружение запрещает чтение каталога после `chmod 000`.
 *
 * Под root (часто в CI-контейнере) `chmod 000` чтение не запрещает — тогда
 * кейс «нечитаемый каталог» пропускается, а не проверяется ложно.
 */
async function unreadableAfterChmod(dir: string): Promise<boolean> {
  await chmod(dir, 0o000);
  try {
    await readdir(dir);
    return false;
  } catch {
    return true;
  }
}

/** Bare-репозиторий с одним коммитом в `main`. */
async function createBareRepo(base: string): Promise<string> {
  const execFileAsync = promisify(execFile);
  const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  await git(base, ['init', '--bare', '--initial-branch=main', bare]);
  await git(base, ['clone', bare, work]);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await writeFile(join(work, 'README.md'), 'hello\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'initial']);
  await git(work, ['push', 'origin', 'main']);
  return bare;
}

describe('Git API Routes (ADR-076 §T3)', () => {
  let root: string;
  let dataDir: string;
  let workspacesRoot: string;
  let projectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-routes-'));
    dataDir = join(root, 'data');
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'proj'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    const project = projectStore.create('Demo', 'owner', { workspace: 'proj' });
    projectId = project.id;
    await projectStore.save(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeApp(opts?: GitRoutesOptions) {
    const app = new Hono();
    app.route('/api/v2/git', createGitRoutes({ requireAuth: passAuth }, projectStore, workspacesRoot, opts));
    return app;
  }

  function post(app: Hono, path: string, body: unknown) {
    return app.request(`/api/v2/git${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('clone регистрирует запись в project.repos (201)', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    const res = await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });
    expect(res.status).toBe(201);
    const repo = await res.json() as { path: string; isRepo: boolean };
    expect(repo).toMatchObject({ path: 'app', isRepo: true });

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'app', url: `file://${bare}`, type: 'https' });
    expect(saved?.repos?.[0]?.id).toBeTruthy();
    expect(saved?.repos?.[0]?.lastFetch).toBeTruthy();
  });

  it('init создаёт репозиторий и регистрирует запись', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/init', { projectId, path: 'repos/app', defaultBranch: 'main' });
    expect(res.status).toBe(201);

    const saved = await projectStore.load(projectId);
    expect(saved?.repos?.[0]).toMatchObject({ path: 'repos/app', defaultBranch: 'main' });
    expect(saved?.repos?.[0]?.id).toBeTruthy();
  });

  it('register идемпотентен по path', async () => {
    const app = makeApp();
    const first = await post(app, '/repos/register', { projectId, path: 'vendor/lib', url: 'https://example.com/lib.git' });
    expect(first.status).toBe(200);
    const firstEntry = await first.json() as { id: string };
    expect(firstEntry.id).toBeTruthy();

    const second = await post(app, '/repos/register', { projectId, path: 'vendor/lib' });
    expect(second.status).toBe(200);
    const secondEntry = await second.json() as { id: string; url?: string };
    expect(secondEntry.id).toBe(firstEntry.id);
    // url не затирается, если новый не задан.
    expect(secondEntry.url).toBe('https://example.com/lib.git');

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
  });

  it('register `./app` поверх `app` не создаёт дубль (канонический путь)', async () => {
    const app = makeApp();
    const first = await post(app, '/repos/register', { projectId, path: 'app', url: 'https://example.com/app.git' });
    expect(first.status).toBe(200);
    const firstEntry = await first.json() as { id: string };

    const second = await post(app, '/repos/register', { projectId, path: './app' });
    expect(second.status).toBe(200);
    const secondEntry = await second.json() as { id: string; path: string; url?: string };
    expect(secondEntry.id).toBe(firstEntry.id);
    // Косметика снята: в реестре канонический путь.
    expect(secondEntry.path).toBe('app');
    expect(secondEntry.url).toBe('https://example.com/app.git');

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(1);
    expect(saved?.repos?.[0]?.path).toBe('app');
  });

  it('fetch по косметике пути (`./app`) находит запись реестра', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });

    const res = await post(app, '/repos/fetch', { projectId, path: './app' });
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path).toBe('app');
  });

  it('remove по косметике пути (`./app`) находит запись реестра', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });

    const res = await post(app, '/repos/remove', { projectId, path: './app' });
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: { path: string } };
    expect(body.removed.path).toBe('app');
    expect((await projectStore.load(projectId))?.repos ?? []).toHaveLength(0);
  });

  it('remove с deleteLocal удаляет каталог и запись', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });
    expect(await exists(join(workspacesRoot, 'proj', 'app'))).toBe(true);

    const res = await post(app, '/repos/remove', { projectId, path: 'app', deleteLocal: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { deletedLocal: boolean; removed: { path: string } };
    expect(body.deletedLocal).toBe(true);
    expect(body.removed.path).toBe('app');
    expect(await exists(join(workspacesRoot, 'proj', 'app'))).toBe(false);

    const saved = await projectStore.load(projectId);
    expect(saved?.repos).toHaveLength(0);
  });

  it('SSH-url без ключа → 400 git.ssh_key_required', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/clone', { projectId, url: 'git@github.com:org/repo.git', path: 'sshrepo' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.ssh_key_required');
  });

  it('ключ без usage "git" → 400 git.ssh_key_required (гейт PROP-124 §3)', async () => {
    // Ключ только для ssh-доступа: в git-операции не пригоден.
    const sshKeyStore = new SSHKeyStore({ dataDir });
    const key = await sshKeyStore.create({
      name: 'ssh-only',
      privateKey: 'ssh-only-private-key',
      usages: ['ssh'],
    });

    const app = makeApp({ sshKeyStore });
    const res = await post(app, '/repos/clone', {
      projectId,
      url: 'git@github.com:org/repo.git',
      path: 'sshrepo',
      sshKeyId: key.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.ssh_key_required');
  });

  it('authorizeProject → false → 403', async () => {
    const app = makeApp({ authorizeProject: async () => false });
    const res = await post(app, '/repos/register', { projectId, path: 'x' });
    expect(res.status).toBe(403);
  });

  it('read-роуты: authorizeRead → false → 403 (граничный guard, ADR-089)', async () => {
    const app = makeApp({ authorizeRead: async () => false });
    for (const res of [
      await post(app, '/scan', { projectId }),
      await app.request(`/api/v2/git/log?project_id=${projectId}`),
      await app.request(`/api/v2/git/commit?project_id=${projectId}&hash=abc`),
    ]) {
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { error: string; code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.error).toMatch(/Доступ к проекту запрещён/);
    }
  });

  it('read-роуты: authorizeRead → true → доступ разрешён (прав на запись не требуется)', async () => {
    const app = makeApp({
      authorizeRead: async () => true,
      authorizeProject: async () => false,
    });
    expect((await post(app, '/scan', { projectId })).status).toBe(200);
    // log/commit по не-git workspace → 404 (legacy NOT_FOUND), а не 403.
    expect((await app.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(404);
    expect((await app.request(`/api/v2/git/commit?project_id=${projectId}&hash=abc`)).status).toBe(404);
  });

  it('read-роуты без authorizeRead → используется authorizeProject (строже, fail-closed)', async () => {
    const denied = makeApp({ authorizeProject: async () => false });
    expect((await post(denied, '/scan', { projectId })).status).toBe(403);
    expect((await denied.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(403);

    const allowed = makeApp({ authorizeProject: async () => true });
    expect((await post(allowed, '/scan', { projectId })).status).toBe(200);
  });

  it('без guard-опций проверки нет (standalone: один пользователь инстанса)', async () => {
    const app = makeApp();
    expect((await post(app, '/scan', { projectId })).status).toBe(200);
    expect((await app.request(`/api/v2/git/log?project_id=${projectId}`)).status).toBe(404);
  });

  it('scan находит склонированный репозиторий', async () => {
    const app = makeApp();
    const bare = await createBareRepo(root);
    await post(app, '/repos/clone', { projectId, url: `file://${bare}`, path: 'app' });

    const res = await post(app, '/scan', { projectId });
    expect(res.status).toBe(200);
    const body = await res.json() as { repos: Array<{ path: string }> };
    expect(body.repos.map((r) => r.path)).toContain('app');
  });

  it('path вне workspace → 400 git.repo_path_invalid', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { projectId, path: '../outside' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.repo_path_invalid');
  });

  it('register: симлинк внутри workspace наружу → 400 git.repo_path_invalid (не 500)', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(workspacesRoot, 'proj', 'escape'));

    const app = makeApp();
    const res = await post(app, '/repos/register', { projectId, path: 'escape' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.repo_path_invalid');
    // Запись в реестр не создана.
    expect((await projectStore.load(projectId))?.repos ?? []).toHaveLength(0);
  });

  it('remove с deleteLocal: симлинк наружу → 400, внешний каталог цел, запись не удалена', async () => {
    const outside = join(root, 'keep');
    await mkdir(outside, { recursive: true });
    const precious = join(outside, 'precious.txt');
    await writeFile(precious, 'must survive\n');
    await symlink(outside, join(workspacesRoot, 'proj', 'evil'));

    // Запись реестра ставим напрямую: register такой путь теперь отклоняет.
    const project = await projectStore.load(projectId);
    if (!project) throw new Error('проект не найден');
    await projectStore.save({
      ...project,
      repos: [{ id: 'repo-evil', path: 'evil', name: 'evil' }],
    });

    const app = makeApp();
    const res = await post(app, '/repos/remove', { projectId, path: 'evil', deleteLocal: true });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('git.repo_path_invalid');
    // `rm -rf` не выполнен: внешний файл цел, запись реестра осталась.
    expect(await exists(precious)).toBe(true);
    expect((await projectStore.load(projectId))?.repos ?? []).toHaveLength(1);
  });

  it('clone: таймаут сетевой операции → 504 git.clone_timeout', async () => {
    const port = new TimingOutPort('clone');
    const app = makeApp({ execution: port, cloneTimeoutMs: 1500 });

    const res = await post(app, '/repos/clone', {
      projectId,
      url: 'https://example.invalid/org/slow.git',
      path: 'slow',
    });

    expect(res.status).toBe(504);
    const body = await res.json() as { error: { code: string; error: string } };
    expect(body.error.code).toBe('git.clone_timeout');
    expect(body.error.error).toContain('1500');
    expect(port.calls.at(-1)?.timeoutMs).toBe(1500);
    // Атомарность: после таймаута на диске ничего не осталось.
    expect(await exists(join(workspacesRoot, 'proj', 'slow'))).toBe(false);
    expect((await projectStore.load(projectId))?.repos ?? []).toHaveLength(0);
  });

  it('fetch: таймаут сетевой операции → 504 git.fetch_timeout', async () => {
    await post(makeApp(), '/repos/register', {
      projectId,
      path: 'app',
      url: 'https://example.invalid/org/app.git',
    });

    const port = new TimingOutPort('fetch');
    const app = makeApp({ execution: port, fetchTimeoutMs: 2500 });
    const res = await post(app, '/repos/fetch', { projectId, path: 'app' });

    expect(res.status).toBe(504);
    const body = await res.json() as { error: { code: string; error: string } };
    expect(body.error.code).toBe('git.fetch_timeout');
    expect(body.error.error).toContain('2500');
    expect(port.calls.at(-1)?.timeoutMs).toBe(2500);
  });

  it('занятый путь: полноценный репозиторий → 409 + details.occupied = repo', async () => {
    await createRepoWithCommit(join(workspacesRoot, 'proj', 'taken'));
    const app = makeApp();

    const res = await post(app, '/repos/clone', {
      projectId,
      url: 'https://example.invalid/org/taken.git',
      path: 'taken',
    });

    expect(res.status).toBe(409);
    const body = await res.json() as {
      error: { code: string; error: string; details?: { path: string; occupied: string; entries?: number } };
    };
    expect(body.error.code).toBe('git.repo_exists');
    expect(body.error.details).toEqual({ path: 'taken', occupied: 'repo' });
    // Текст actionable: зарегистрировать существующий, повторный клон не нужен.
    expect(body.error.error).toMatch(/уже склонирован/);
    expect(body.error.error).toMatch(/repos\/register/);
  });

  it('занятый путь: след прерванного клона → 409 + details.occupied = stub', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'half', '.git'), { recursive: true });
    const app = makeApp();

    const res = await post(app, '/repos/clone', {
      projectId,
      url: 'https://example.invalid/org/half.git',
      path: 'half',
    });

    expect(res.status).toBe(409);
    const body = await res.json() as {
      error: { code: string; error: string; details?: { path: string; occupied: string; entries?: number } };
    };
    expect(body.error.code).toBe('git.repo_exists');
    expect(body.error.details).toEqual({ path: 'half', occupied: 'stub' });
    expect(body.error.error).toMatch(/незавершённый клон/);
    expect(body.error.error).toMatch(/Удалите каталог/);
  });

  it('занятый путь: непустой каталог без git → 409 + details.occupied = dir с entries', async () => {
    const dir = join(workspacesRoot, 'proj', 'busy');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'x');
    await writeFile(join(dir, 'b.txt'), 'y');
    const app = makeApp();

    const res = await post(app, '/repos/clone', {
      projectId,
      url: 'https://example.invalid/org/busy.git',
      path: 'busy',
    });

    expect(res.status).toBe(409);
    const body = await res.json() as {
      error: { code: string; error: string; details?: { path: string; occupied: string; entries?: number } };
    };
    expect(body.error.code).toBe('git.repo_exists');
    expect(body.error.details).toEqual({ path: 'busy', occupied: 'dir', entries: 2 });
    expect(body.error.error).toMatch(/непустой и не является git-репозиторием/);
    expect(body.error.error).toMatch(/Укажите другой путь/);
  });

  it('нечитаемый целевой каталог → git.repo_path_unreadable', async (ctx) => {
    const dir = join(workspacesRoot, 'proj', 'locked');
    await mkdir(dir, { recursive: true });
    let enforced = false;
    try {
      enforced = await unreadableAfterChmod(dir);
      if (!enforced) {
        // root (CI-контейнер) игнорирует права — кейс проверить нечем.
        ctx.skip();
        return;
      }

      const app = makeApp();
      const res = await post(app, '/repos/clone', {
        projectId,
        url: 'https://example.invalid/org/locked.git',
        path: 'locked',
      });

      const body = await res.json() as { error: { code: string; error: string } };
      // Отдельная типизированная ошибка, а не невнятное падение внутри git.
      expect(body.error.code).toBe('git.repo_path_unreadable');
      expect(body.error.error).toMatch(/недоступен для чтения/);
      expect(res.status).toBe(409);
    } finally {
      await chmod(dir, 0o700).catch(() => undefined);
    }
  });

  // --- ADR-076 (этап 1): состояние рабочего дерева и diff рабочего дерева ---

  /**
   * Репозиторий в workspace с upstream (`origin`) и одним локальным коммитом —
   * чтобы `# branch.ab` отдавал `+1 -0` (ahead/behind).
   */
  async function createRepoWithUpstream(dir: string): Promise<void> {
    const bare = join(root, 'origin-status.git');
    await gitAt(root, ['init', '--bare', '--initial-branch=main', bare]);
    await mkdir(dir, { recursive: true });
    await gitAt(dir, ['init', '--initial-branch=main']);
    await gitAt(dir, ['config', 'user.email', 'test@example.com']);
    await gitAt(dir, ['config', 'user.name', 'Test']);
    await writeFile(join(dir, 'README.md'), 'hello\n');
    await writeFile(join(dir, '.gitignore'), '*.log\n');
    await gitAt(dir, ['add', '.']);
    await gitAt(dir, ['commit', '-m', 'initial']);
    await gitAt(dir, ['remote', 'add', 'origin', bare]);
    await gitAt(dir, ['push', '-u', 'origin', 'main']);
    await writeFile(join(dir, 'ahead.txt'), 'ahead\n');
    await gitAt(dir, ['add', '.']);
    await gitAt(dir, ['commit', '-m', 'ahead']);
  }

  /** Запись реестра для `app` (репозиторий уже создан в workspace). */
  async function registerApp(app: Hono): Promise<void> {
    const res = await post(app, '/repos/register', { projectId, path: 'app' });
    expect(res.status).toBe(200);
  }

  it('status: ветка, ahead/behind и файлы (staged/unstaged/untracked/ignored)', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithUpstream(dir);
    // unstaged — правка отслеживаемого; staged — новая запись в индексе;
    // untracked — новый файл; ignored — `*.log` (в .gitignore коммита).
    await writeFile(join(dir, 'README.md'), 'hello\nworld\n');
    await writeFile(join(dir, 'staged.txt'), 'staged\n');
    await writeFile(join(dir, 'untracked.txt'), 'u\n');
    await writeFile(join(dir, 'x.log'), 'log\n');
    await gitAt(dir, ['add', 'staged.txt']);

    const app = makeApp();
    await registerApp(app);
    const res = await app.request(`/api/v2/git/status?project_id=${projectId}&repo_path=app`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      repos: Array<{
        path: string;
        branch?: string;
        ahead?: number;
        behind?: number;
        files: Array<{ path: string; kind: string; staged: boolean; unstaged: boolean }>;
      }>;
    };
    expect(body.repos).toHaveLength(1);
    const repo = body.repos[0]!;
    expect(repo.path).toBe('app');
    expect(repo.branch).toBe('main');
    expect(repo.ahead).toBe(1);
    expect(repo.behind).toBe(0);

    const byPath = new Map(repo.files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')).toMatchObject({ kind: 'modified', staged: false, unstaged: true });
    expect(byPath.get('staged.txt')).toMatchObject({ kind: 'added', staged: true, unstaged: false });
    expect(byPath.get('untracked.txt')).toMatchObject({ kind: 'untracked', staged: false, unstaged: true });
    // Игнорируемые — отдельный kind, не «изменён».
    expect(byPath.get('x.log')).toMatchObject({ kind: 'ignored', staged: false, unstaged: false });
  });

  it('status: новые файлы внутри каталога — поимённо, игнорируемый каталог — одной записью', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithUpstream(dir);
    // Игнорируемый каталог добавляем в `.gitignore` (helper пишет только `*.log`).
    await writeFile(join(dir, '.gitignore'), '*.log\nnode_modules/\n');
    await mkdir(join(dir, 'Test'), { recursive: true });
    await writeFile(join(dir, 'Test', 'Test.txt'), 'new\n');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'module\n');

    const app = makeApp();
    await registerApp(app);
    const res = await app.request(`/api/v2/git/status?project_id=${projectId}&repo_path=app`);
    expect(res.status).toBe(200);

    const body = await res.json() as { repos: Array<{ files: Array<{ path: string; kind: string }> }> };
    const byPath = new Map(body.repos[0]!.files.map((f) => [f.path, f]));
    // Новый файл внутри нового каталога — отдельной записью, а не каталогом `Test/`.
    expect(byPath.get('Test/Test.txt')).toMatchObject({ kind: 'untracked' });
    expect(byPath.has('Test/')).toBe(false);
    // Игнорируемый каталог — по-прежнему одной записью, внутрь не заходим.
    expect(byPath.get('node_modules/')).toMatchObject({ kind: 'ignored' });
    expect(byPath.has('node_modules/pkg/index.js')).toBe(false);
  });

  it('status: repo_path не из реестра → 404 NOT_FOUND', async () => {
    const app = makeApp();
    const res = await app.request(`/api/v2/git/status?project_id=${projectId}&repo_path=nope`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('status: недоступный репозиторий реестра → запись с error, остальные отдаются', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);
    // Запись реестра без каталога (удалён/не склонирован) — одна из многих.
    const registered = await post(app, '/repos/register', { projectId, path: 'ghost' });
    expect(registered.status).toBe(200);

    const res = await app.request(`/api/v2/git/status?project_id=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      repos: Array<{ path: string; files: unknown[]; error?: string }>;
    };
    expect(body.repos).toHaveLength(2);
    expect(body.repos.find((r) => r.path === 'app')?.error).toBeUndefined();
    expect(body.repos.find((r) => r.path === 'ghost')).toMatchObject({
      files: [],
      error: 'git.repo_missing',
    });
  });

  it('diff по файлу: содержит @@ и счётчики строк', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);
    await writeFile(join(dir, 'README.md'), 'hello\nworld\n');

    const res = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=README.md`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      diff: { path?: string; diff: string; additions?: number; deletions?: number; binary?: boolean };
    };
    expect(body.diff.path).toBe('README.md');
    expect(body.diff.diff).toContain('@@');
    expect(body.diff.diff).toContain('+world');
    expect(body.diff.additions).toBe(1);
    expect(body.diff.deletions).toBe(0);
  });

  it('diff: staged=true видит застейдженное, staged=false — рабочее дерево', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);
    await writeFile(join(dir, 'README.md'), 'hello\nworld\n');
    await gitAt(dir, ['add', 'README.md']);

    const staged = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=README.md&staged=true`,
    );
    const stagedBody = await staged.json() as { diff: { diff: string; additions?: number } };
    expect(stagedBody.diff.diff).toContain('+world');
    expect(stagedBody.diff.additions).toBe(1);

    // В рабочем дереве изменений уже нет (всё в индексе).
    const unstaged = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=README.md&staged=false`,
    );
    const unstagedBody = await unstaged.json() as { diff: { diff: string } };
    expect(unstagedBody.diff.diff).toBe('');
  });

  it('diff по untracked: добавленные строки (--no-index от /dev/null)', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);
    await writeFile(join(dir, 'new.txt'), 'one\ntwo\n');

    const res = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=new.txt`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { diff: { diff: string; additions?: number; deletions?: number } };
    expect(body.diff.diff).toContain('/dev/null');
    expect(body.diff.diff).toContain('+one');
    expect(body.diff.additions).toBe(2);
    expect(body.diff.deletions).toBe(0);
  });

  it('diff: path с `..` или абсолютный → 400 git.repo_path_invalid', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);

    for (const bad of ['../secret.txt', '/etc/passwd']) {
      const res = await app.request(
        `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('git.repo_path_invalid');
    }
  });

  it('diff сводный по репозиторию: без path — все изменённые файлы', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    // Второй файл — отслеживаемый (untracked в сводный diff не попадает).
    await writeFile(join(dir, 'second.txt'), 'second\n');
    await gitAt(dir, ['add', 'second.txt']);
    await gitAt(dir, ['commit', '-m', 'second']);
    const app = makeApp();
    await registerApp(app);
    await writeFile(join(dir, 'README.md'), 'hello\nchanged\n');
    await writeFile(join(dir, 'second.txt'), 'second\nchanged\n');

    const res = await app.request(`/api/v2/git/diff?project_id=${projectId}&repo_path=app`);
    expect(res.status).toBe(200);
    const body = await res.json() as { diff: { path?: string; diff: string } };
    // Сводный diff — без `path`, но с обоими файлами.
    expect(body.diff.path).toBeUndefined();
    expect(body.diff.diff).toContain('README.md');
    expect(body.diff.diff).toContain('second.txt');
  });

  it('diff: обрезка по maxDiffBytes → diff_truncated', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    // Предел размера diff — опцией фабрики (как `maxDiffBytes` сервиса).
    const app = makeApp({ maxDiffBytes: 40 });
    await registerApp(app);
    await writeFile(join(dir, 'README.md'), `${'line\n'.repeat(50)}`);

    const res = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=README.md`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { diff: { diff: string; diff_truncated?: boolean } };
    expect(body.diff.diff_truncated).toBe(true);
    expect(Buffer.byteLength(body.diff.diff, 'utf-8')).toBeLessThanOrEqual(40);
  });

  it('diff бинарного untracked-файла → binary: true, без тела и счётчиков', async () => {
    const dir = join(workspacesRoot, 'proj', 'app');
    await createRepoWithCommit(dir);
    const app = makeApp();
    await registerApp(app);
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));

    const res = await app.request(
      `/api/v2/git/diff?project_id=${projectId}&repo_path=app&path=bin.dat`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      diff: { diff: string; binary?: boolean; additions?: number; deletions?: number };
    };
    expect(body.diff.binary).toBe(true);
    expect(body.diff.diff).toBe('');
    expect(body.diff.additions).toBeUndefined();
    expect(body.diff.deletions).toBeUndefined();
  });

  it('status/diff: репозиторий-корень workspace адресуется через `repo_path=.`', async () => {
    const wsDir = join(workspacesRoot, 'proj');
    await createRepoWithCommit(wsDir);
    const app = makeApp();
    const registered = await post(app, '/repos/register', { projectId, path: '.' });
    expect(registered.status).toBe(200);

    const status = await app.request(`/api/v2/git/status?project_id=${projectId}&repo_path=.`);
    expect(status.status).toBe(200);
    const statusBody = await status.json() as { repos: Array<{ path: string; error?: string }> };
    expect(statusBody.repos).toHaveLength(1);
    expect(statusBody.repos[0]?.path).toBe('.');
    expect(statusBody.repos[0]?.error).toBeUndefined();

    await writeFile(join(wsDir, 'README.md'), 'hello\nroot\n');
    const diff = await app.request(`/api/v2/git/diff?project_id=${projectId}&repo_path=.`);
    expect(diff.status).toBe(200);
    const diffBody = await diff.json() as { diff: { diff: string } };
    expect(diffBody.diff.diff).toContain('+root');
  });
});

/**
 * IDOR (security-фикс 0.11.3, регресс): граничный guard и обработчик должны
 * разрешать ОДИН И ТОТ ЖЕ id проекта.
 *
 * Раньше guard брал id из query (`project_id`), а обработчик — из тела
 * (`projectId`): `POST /git/scan?project_id=<свой>` с телом
 * `{"projectId":"<чужой>"}` проходил проверку доступа по СВОЕМУ проекту, а
 * обработчик читал (и менял) ЧУЖОЙ. Теперь id резолвится один раз (в guard'е),
 * кладётся в контекст, а обработчик берёт id ТОЛЬКО оттуда.
 */
describe('Git API Routes: единый источник id проекта (IDOR)', () => {
  let root: string;
  let dataDir: string;
  let workspacesRoot: string;
  let ownProjectId: string;
  let foreignProjectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-idor-'));
    dataDir = join(root, 'data');
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'own'), { recursive: true });
    await mkdir(join(workspacesRoot, 'foreign'), { recursive: true });
    projectStore = new ProjectStore({ dataDir });
    const own = projectStore.create('Own', 'caller', { workspace: 'own' });
    const foreign = projectStore.create('Foreign', 'stranger', { workspace: 'foreign' });
    ownProjectId = own.id;
    foreignProjectId = foreign.id;
    await projectStore.save(own);
    await projectStore.save(foreign);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Доступ есть только к СВОЕМУ проекту (эмуляция backend RBAC). */
  function makeApp() {
    const app = new Hono();
    const allowed = async (_c: unknown, id: string) => id === ownProjectId;
    app.route('/api/v2/git', createGitRoutes(
      { requireAuth: passAuth },
      projectStore,
      workspacesRoot,
      { authorizeProject: allowed, authorizeRead: allowed },
    ));
    return app;
  }

  function post(app: Hono, path: string, body: unknown, query?: string) {
    return app.request(`/api/v2/git${path}${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('read-роут: query-проект и проект из тела различаются → 403, чужой проект не тронут', async () => {
    const app = makeApp();
    const res = await post(app, '/scan', { projectId: foreignProjectId }, `project_id=${ownProjectId}`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { error: string; code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.error).toMatch(/Доступ к проекту запрещён/);
    // Чужой проект не изменён (scan ничего не пишет — реестр пуст).
    expect((await projectStore.load(foreignProjectId))?.repos ?? []).toHaveLength(0);
  });

  it('write-роуты: query-проект и проект из тела различаются → 403, чужой проект НЕ изменён', async () => {
    const app = makeApp();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['/repos/register', { path: 'vendor/lib' }],
      ['/repos/init', { path: 'repo' }],
      ['/repos/clone', { url: 'https://example.com/x.git', path: 'x' }],
      ['/repos/remove', { path: 'vendor/lib' }],
      ['/repos/fetch', { path: 'vendor/lib' }],
    ];
    for (const [path, extra] of cases) {
      const res = await post(app, path, { projectId: foreignProjectId, ...extra }, `project_id=${ownProjectId}`);
      expect(res.status, path).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code, path).toBe('FORBIDDEN');
      // Реестр ЧУЖОГО проекта не тронут (иначе guard и обработчик разошлись).
      expect((await projectStore.load(foreignProjectId))?.repos ?? [], path).toHaveLength(0);
      // И СВОЙ проект не тронут — запрос отклонён целиком.
      expect((await projectStore.load(ownProjectId))?.repos ?? [], path).toHaveLength(0);
    }
  });

  it('write-роут: id только в теле (без query) — работает, guard проверяет именно его', async () => {
    const app = makeApp();
    const checked: string[] = [];
    const app2 = new Hono();
    app2.route('/api/v2/git', createGitRoutes(
      { requireAuth: passAuth },
      projectStore,
      workspacesRoot,
      {
        authorizeProject: async (_c, id) => { checked.push(id); return id === ownProjectId; },
      },
    ));
    const res = await post(app2, '/repos/register', { projectId: ownProjectId, path: 'vendor/lib' });
    expect(res.status).toBe(200);
    // Guard разрешил id ИЗ ТЕЛА — обработчик работал с тем же id.
    expect(checked).toEqual([ownProjectId]);
    expect((await projectStore.load(ownProjectId))?.repos).toHaveLength(1);
    expect(app).toBeDefined();
  });

  it('совпадающие query и тело → запрос обрабатывается (id один и тот же)', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { projectId: ownProjectId, path: 'vendor/lib' }, `project_id=${ownProjectId}`);
    expect(res.status).toBe(200);
    expect((await projectStore.load(ownProjectId))?.repos).toHaveLength(1);
  });

  it('id не извлечётся (нет ни в query, ни в теле) → 400, проект не задет', async () => {
    const app = makeApp();
    const res = await post(app, '/repos/register', { path: 'vendor/lib' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect((await projectStore.load(ownProjectId))?.repos ?? []).toHaveLength(0);
  });
});
