import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  projectRepoCloneTool,
  projectRepoInitTool,
  projectRepoAddTool,
  projectRepoFetchTool,
  projectRepoRemoveTool,
} from './project-repos.js';
import { GitService } from '../../git/git-service.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Bare-репозиторий с одним коммитом в `main` (для clone/fetch). */
async function createBareRepo(base: string): Promise<string> {
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  const g = simpleGit();
  await g.raw(['init', '--bare', '--initial-branch=main', bare]);
  await g.clone(bare, work);
  const wg = simpleGit(work);
  await wg.addConfig('user.email', 'test@example.com');
  await wg.addConfig('user.name', 'Test');
  await writeFile(join(work, 'README.md'), 'hello\n');
  await wg.add('.');
  await wg.commit('initial');
  await wg.push('origin', 'main');
  return bare;
}

describe('project repos tools (AD-076)', () => {
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

  it('clone в непустой каталог → git.repo_exists', async () => {
    await mkdir(join(workspacesRoot, 'proj', 'existing'), { recursive: true });
    await writeFile(join(workspacesRoot, 'proj', 'existing', 'file.txt'), 'x');
    const bare = await createBareRepo(root);

    const result = await projectRepoCloneTool.execute(
      { url: `file://${bare}`, path: 'existing' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toEqual({ key: 'git.repo_exists', params: { path: 'existing' } });
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
});
