import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  projectRepoCloneTool,
  projectRepoInitTool,
  projectRepoAddTool,
  projectRepoFetchTool,
  projectRepoRemoveTool,
} from './project-repos.js';
import { GitService } from '../../git/git-service.js';
import { ExecutionError, type ExecRequest, type ExecResult, type ExecutionPort } from '../../execution/ports/index.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import type { SSHKey, SSHKeyMeta } from '@itphx/synth-shared';

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

/** Стор SSH-ключей в памяти: наружу — только метаданные (`list`/`listForAgent`). */
class FakeSshKeyStore implements SSHKeyRepository {
  constructor(private readonly keys: SSHKey[] = []) {}

  async list(): Promise<SSHKeyMeta[]> {
    return this.keys.map(({ privateKey: _pk, passphrase: _pp, ...rest }) => rest);
  }

  async listForAgent(agentId: string): Promise<SSHKeyMeta[]> {
    return (await this.list()).filter((key) => key.agentIds.includes(agentId));
  }

  async listRaw(): Promise<SSHKey[]> {
    return this.keys;
  }

  async rotateMasterKey(): Promise<never> {
    throw new Error('not used in this test');
  }

  async get(): Promise<null> {
    return null;
  }

  async create(): Promise<never> {
    throw new Error('not used in this test');
  }

  async update(): Promise<null> {
    return null;
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async linkAgent(): Promise<null> {
    return null;
  }

  async unlinkAgent(): Promise<null> {
    return null;
  }

  /** Ключа нет в сторе — сетевые тулы получают `sshkey.not_found`. */
  async reveal(): Promise<null> {
    return null;
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

/** Bare-репозиторий с одним коммитом в `main` (для clone/fetch). */async function createBareRepo(base: string): Promise<string> {
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

describe('project repos tools (ADR-076)', () => {
  let root: string;
  let workspacesRoot: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;
  let gitService: GitService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-project-repos-'));
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'proj'), { recursive: true });
    sessionManager = new SessionManager(new FileStore({ dataDir: join(root, 'data') }));
    projectStore = new ProjectStore({ dataDir: join(root, 'data') });
    eventBus = new EventBus();
    gitService = new GitService(workspacesRoot);

    const project = projectStore.create('Repos', 'u1', { workspace: 'proj' });
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Repos' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = projectId;
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeCtx(overrides: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: join(workspacesRoot, 'proj'),
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        eventBus,
        workspacesRoot,
        gitService,
        ...overrides,
      },
    };
  }

  it('clone: клонирует, регистрирует запись и публикует project.updated', async () => {
    const bare = await createBareRepo(root);
    let updated: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'project.updated') updated = e.data as Record<string, unknown>;
    });

    const result = await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'app' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.path).toBe('app');
    expect(await exists(join(workspacesRoot, 'proj', 'app', '.git'))).toBe(true);

    const stored = (await projectStore.load(projectId))!;
    expect(stored.repos).toHaveLength(1);
    expect(stored.repos?.[0]).toMatchObject({ path: 'app', url: `file://${bare}`, type: 'https' });
    expect(stored.repos?.[0]?.id).toBeTruthy();
    expect(stored.repos?.[0]?.lastFetch).toBeTruthy();
    expect(updated?.project_id).toBe(projectId);
  });

  it('clone SSH-url без ключа → git.ssh_key_required', async () => {
    const result = await projectRepoCloneTool.execute(
      { url: 'git@github.com:org/repo.git', path: 'sshrepo' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.ssh_key_required', params: { path: 'sshrepo' } });
  });

  it('clone SSH-url без ключа: стор доступен → подсказка со списком ключей', async () => {
    const store = new FakeSshKeyStore([
      {
        id: 'key_deploy',
        name: 'deploy',
        agentIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        privateKey: 'secret',
      },
    ]);
    const result = await projectRepoCloneTool.execute(
      { url: 'git@github.com:org/repo.git', path: 'sshrepo' },
      makeCtx({ sshKeyStore: store }),
    );

    expect(result.isError).toBe(true);
    // Форма `id → name`: по ней модель выбирает `sshKeyId`.
    expect(result.content).toContain('key_deploy → deploy');
    expect(result.content).toContain('ssh_keys_list');
    expect(result.metadata?.i18n).toEqual({
      key: 'git.ssh_key_required_hint',
      params: { path: 'sshrepo', keys: 'key_deploy → deploy' },
    });
  });

  it('clone SSH-url без ключа: ключей нет → подсказка добавить ключ в настройках', async () => {
    const result = await projectRepoCloneTool.execute(
      { url: 'git@github.com:org/repo.git', path: 'sshrepo' },
      makeCtx({ sshKeyStore: new FakeSshKeyStore([]) }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Settings → SSH keys/);
    expect(result.metadata?.i18n).toMatchObject({ key: 'git.ssh_key_required_hint' });
  });

  it('fetch: ключ записи не найден в сторе → «not found» + список доступных ключей', async () => {
    await projectRepoAddTool.execute(
      { path: 'sshrepo', url: 'git@github.com:org/repo.git', sshKeyId: 'key_missing' },
      makeCtx(),
    );
    const store = new FakeSshKeyStore([
      {
        id: 'key_deploy',
        name: 'deploy',
        agentIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        privateKey: 'secret',
      },
    ]);

    const result = await projectRepoFetchTool.execute({ path: 'sshrepo' }, makeCtx({ sshKeyStore: store }));

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/SSH key key_missing not found/);
    expect(result.content).toContain('key_deploy → deploy');
    expect(result.metadata?.i18n).toMatchObject({ key: 'git.ssh_key_required_hint' });
  });

  it('clone в непустой каталог → git.repo_occupied_dir (классификация пути)', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'existing'), { recursive: true });
    await writeFile(join(workspacesRoot, 'proj', 'existing', 'file.txt'), 'x');
    const bare = await createBareRepo(root);

    const result = await projectRepoCloneTool.execute(
      { url: `file://${bare}`, path: 'existing' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    // ADR-076: три состояния пути различаются — непустой каталог без git это
    // `dir` (нужен другой путь), а не «репозиторий уже существует».
    expect(result.metadata?.i18n).toEqual({
      key: 'git.repo_occupied_dir',
      params: { path: 'existing', entries: '1' },
    });
    expect(result.content).toMatch(/non-empty directory \(1 entries\)/);
    expect(result.content).toMatch(/Choose another path or clean the directory/);
  });

  it('clone в полноценный репозиторий → git.repo_occupied_repo (зарегистрировать)', async () => {
    await createRepoWithCommit(join(workspacesRoot, 'proj', 'already'));
    const bare = await createBareRepo(root);

    const result = await projectRepoCloneTool.execute(
      { url: `file://${bare}`, path: 'already' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_occupied_repo', params: { path: 'already' } });
    // Действие в сообщении: регистрировать существующий, а не клонировать снова.
    expect(result.content).toMatch(/Register the existing one/);
    expect(result.content).toMatch(/project_repo_add/);
  });

  it('clone в след прерванного клона (.git без коммитов) → git.repo_occupied_stub (удалить)', async () => {
    const stub = join(workspacesRoot, 'proj', 'half');
    await mkdir(join(stub, '.git'), { recursive: true });
    const bare = await createBareRepo(root);

    const result = await projectRepoCloneTool.execute(
      { url: `file://${bare}`, path: 'half' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_occupied_stub', params: { path: 'half' } });
    // Действие в сообщении: удалить недоклонированный каталог и повторить.
    expect(result.content).toMatch(/incomplete clone/);
    expect(result.content).toMatch(/Delete the directory and retry/);
  });

  it('clone: таймаут → git.clone_timeout с {timeout}, каталога не остаётся', async () => {
    const port = new TimingOutPort('clone');
    const slowGit = new GitService(workspacesRoot, { execution: port, cloneTimeoutMs: 777 });

    const result = await projectRepoCloneTool.execute(
      { url: 'https://example.invalid/org/slow.git', path: 'slow' },
      makeCtx({ gitService: slowGit }),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.clone_timeout', params: { timeout: '777' } });
    // В сообщении — действие: повторить или поднять `git.cloneTimeoutMs`.
    expect(result.content).toMatch(/git\.cloneTimeoutMs/);
    expect(await exists(join(workspacesRoot, 'proj', 'slow'))).toBe(false);
    expect(port.calls.at(-1)?.timeoutMs).toBe(777);
  });

  it('fetch: таймаут → git.fetch_timeout с {timeout}', async () => {
    const bare = await createBareRepo(root);
    await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'app' }, makeCtx());

    const port = new TimingOutPort('fetch');
    const slowGit = new GitService(workspacesRoot, { execution: port, fetchTimeoutMs: 888 });
    const result = await projectRepoFetchTool.execute({ path: 'app' }, makeCtx({ gitService: slowGit }));

    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.fetch_timeout', params: { timeout: '888' } });
    expect(result.content).toMatch(/git\.fetchTimeoutMs/);
    expect(port.calls.at(-1)?.timeoutMs).toBe(888);
  });

  it('init: создаёт репозиторий и регистрирует запись', async () => {
    const result = await projectRepoInitTool.execute(
      { path: 'repos/app', defaultBranch: 'main' },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.repos?.[0]).toMatchObject({ path: 'repos/app', defaultBranch: 'main' });
    expect(stored.repos?.[0]?.id).toBeTruthy();
    expect(await exists(join(workspacesRoot, 'proj', 'repos', 'app', '.git'))).toBe(true);
  });

  it('add: traversal-путь → git.repo_path_invalid', async () => {
    const result = await projectRepoAddTool.execute({ path: '../outside' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_path_invalid', params: { path: '../outside' } });

    const stored = (await projectStore.load(projectId))!;
    expect(stored.repos ?? []).toHaveLength(0);
  });

  it('fetch: обновляет lastFetch успешно', async () => {
    const bare = await createBareRepo(root);
    await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'app' }, makeCtx());

    // состарим lastFetch, чтобы убедиться в обновлении
    const before = (await projectStore.load(projectId))!;
    before.repos = [{ ...before.repos![0]!, lastFetch: '2000-01-01T00:00:00.000Z' }];
    await projectStore.save(before);

    const result = await projectRepoFetchTool.execute({ path: 'app' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.repos?.[0]?.lastFetch).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('fetch: неизвестный путь → project.repo_not_found', async () => {
    const result = await projectRepoFetchTool.execute({ path: 'nope' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'project.repo_not_found', params: { path: 'nope' } });
  });

  it('fetch: путь записи — не git-репозиторий → git.repo_not_a_repo (не [object Object])', async () => {
    // Запись есть, а репозитория по пути нет: каталог пуст (`.git` отсутствует).
    await mkdir(join(workspacesRoot, 'proj', 'notgit'), { recursive: true });
    await projectRepoAddTool.execute({ path: 'notgit' }, makeCtx());

    const result = await projectRepoFetchTool.execute({ path: 'notgit' }, makeCtx());

    expect(result.isError).toBe(true);
    // git-слой бросает plain-объект `{ error, code }`: его текст не должен
    // превращаться в `[object Object]`.
    expect(result.content).not.toContain('[object Object]');
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_not_a_repo', params: { path: 'notgit' } });
    // Сообщение actionable: путь и следующие шаги.
    expect(result.content).toContain('notgit');
    expect(result.content).toContain('project_repo_add');
    expect(result.content).toContain('project_repo_clone');
  });

  it('fetch: каталог записи удалён с диска → git.repo_not_a_repo', async () => {
    const bare = await createBareRepo(root);
    await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'gone' }, makeCtx());
    await rm(join(workspacesRoot, 'proj', 'gone'), { recursive: true, force: true });

    const result = await projectRepoFetchTool.execute({ path: 'gone' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('[object Object]');
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_not_a_repo', params: { path: 'gone' } });
  });

  it('fetch: косметика пути (./app, app/, ./app/) находит запись реестра', async () => {
    const bare = await createBareRepo(root);
    await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'app' }, makeCtx());

    for (const path of ['./app', 'app/', './app/']) {
      // Состарим lastFetch: успешный fetch обязан его обновить.
      const before = (await projectStore.load(projectId))!;
      before.repos = [{ ...before.repos![0]!, lastFetch: '2000-01-01T00:00:00.000Z' }];
      await projectStore.save(before);

      const result = await projectRepoFetchTool.execute({ path }, makeCtx());

      expect(result.isError, `путь «${path}» не нашёл запись реестра`).toBeUndefined();
      expect(result.metadata?.path).toBe('app');
      const stored = (await projectStore.load(projectId))!;
      expect(stored.repos?.[0]?.lastFetch).not.toBe('2000-01-01T00:00:00.000Z');
      // Реестр не переписывается: `path` хранится как задан.
      expect(stored.repos?.[0]?.path).toBe('app');
    }
  });

  it('fetch: `..`-сегменты и абсолютный путь не матчатся на запись', async () => {
    const bare = await createBareRepo(root);
    await projectRepoCloneTool.execute({ url: `file://${bare}`, path: 'app' }, makeCtx());

    const outside = ['../app', './../app', join(workspacesRoot, 'proj', 'app')];
    for (const path of outside) {
      const result = await projectRepoFetchTool.execute({ path }, makeCtx());
      expect(result.isError, `путь «${path}» не должен находить запись`).toBe(true);
      expect(result.metadata?.i18n).toEqual({ key: 'project.repo_not_found', params: { path } });
    }
  });

  it('remove: снимает запись, но не удаляет локальный каталог', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'vendor', 'lib'), { recursive: true });
    await writeFile(join(workspacesRoot, 'proj', 'vendor', 'lib', 'file.txt'), 'x');

    await projectRepoAddTool.execute({ path: 'vendor/lib', url: 'https://example.com/lib.git' }, makeCtx());
    expect((await projectStore.load(projectId))!.repos).toHaveLength(1);

    const result = await projectRepoRemoveTool.execute({ path: 'vendor/lib' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const stored = (await projectStore.load(projectId))!;
    expect(stored.repos ?? []).toHaveLength(0);
    // Локальный каталог остаётся на месте (deleteLocal не поддерживается).
    expect(await exists(join(workspacesRoot, 'proj', 'vendor', 'lib', 'file.txt'))).toBe(true);
  });

  it("remove: косметика пути ('./vendor/lib') находит запись реестра", async () => {
    await mkdir(join(workspacesRoot, 'proj', 'vendor', 'lib'), { recursive: true });
    await projectRepoAddTool.execute({ path: 'vendor/lib', url: 'https://example.com/lib.git' }, makeCtx());

    const result = await projectRepoRemoveTool.execute({ path: './vendor/lib' }, makeCtx());

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.path).toBe('vendor/lib');
    expect((await projectStore.load(projectId))!.repos ?? []).toHaveLength(0);
  });
});
