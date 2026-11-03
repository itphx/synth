import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitStatusTool,
  gitDiffTool,
  gitPushTool,
  gitPullTool,
  gitCommitTool,
  gitCheckoutTool,
  gitShowTool,
  gitStashTool,
  gitBranchListTool,
  gitBlameTool,
  validateGitValue,
  runGit,
  resolveRepoCwd,
} from './git.js';
import type { ToolContext } from '@itphx/synth-shared';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { ExecutionError } from '../../execution/ports/index.js';

const execFileAsync = promisify(execFile);

/**
 * Перехват argv, уходящего в git: реальный git продолжает выполняться, но его
 * аргументы видны тесту — так проверяется, что значение параметра тула не
 * превратилось в git-флаг (argument injection).
 */
const { execCalls } = vi.hoisted(() => ({
  execCalls: [] as Array<{ file: string; args: string[]; cwd?: string }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
  const realExecFile = actual.execFile as unknown as (...a: unknown[]) => unknown;
  const execFileMock = (
    file: string,
    args: string[],
    options: unknown,
    callback?: ExecCallback,
  ): unknown => {
    // execFile(file, args, cb) — форма без опций
    if (typeof options === 'function') {
      return realExecFile(file, args, undefined, options);
    }
    return realExecFile(file, args, options, callback);
  };
  (execFileMock as unknown as Record<symbol, unknown>)[CUSTOM] = (
    file: string,
    args: string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execCalls.push({ file, args: [...args], cwd: (options as { cwd?: string } | undefined)?.cwd });
      (execFileMock as unknown as (...a: unknown[]) => unknown)(
        file,
        args,
        options,
        ((err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        }) as ExecCallback,
      );
    });
  // Порт исполнения (`InlineExecutionPort`) запускает команды через `spawn`,
  // а не `execFile`: argv git-тулов виден здесь по той же схеме.
  const realSpawn = actual.spawn as unknown as (...a: unknown[]) => unknown;
  const spawnMock = (file: string, args?: string[], options?: unknown): unknown => {
    execCalls.push({
      file,
      args: [...(args ?? [])],
      cwd: (options as { cwd?: string } | undefined)?.cwd,
    });
    return realSpawn(file, args, options);
  };
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

/** Аргументы всех вызовов git после последнего сброса. */
function gitArgvLists(): string[][] {
  return execCalls.filter((c) => c.file === 'git').map((c) => c.args);
}

/** Все аргументы git после последнего сброса — плоским списком. */
function allGitArgv(): string[] {
  return gitArgvLists().flat();
}

function resetGitCalls(): void {
  execCalls.length = 0;
}

describe('git tools — path resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_status: без path — использует рабочий каталог', async () => {
    const result = await gitStatusTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('master');
  });

  it('git_status: относительный path резолвится относительно рабочего каталога', async () => {
    const result = await gitStatusTool.execute({ path: '.' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata!.cwd).toBe(tmpDir);
  });

  it('git_status: абсолютный path', async () => {
    const result = await gitStatusTool.execute({ path: tmpDir }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata!.cwd).toBe(tmpDir);
  });
});

describe('git tools — прерывание по «Стоп» (abortSignal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-abort-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_status: pre-aborted — мгновенный маркер прерывания, git не запускается', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await gitStatusTool.execute({}, makeCtx({ abortSignal: ac.signal }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    // cwd в metadata не проставлен — runGit не выполнялся
    expect(result.metadata?.cwd).toBeUndefined();
  });

  it('git_status: без abortSignal — работает как раньше (обратная совместимость)', async () => {
    const result = await gitStatusTool.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.interrupted).toBeUndefined();
  });
});

describe('git tools — repo_path (ADR-076 §T6)', () => {
  let tmpDir: string;
  let subRepo: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-repopath-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });

    subRepo = join(tmpDir, 'repo');
    await mkdir(subRepo, { recursive: true });
    await execFileAsync('git', ['init', '-q'], { cwd: subRepo });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('repo_path внутри workspace резолвится относительно workingDir', async () => {
    const result = await gitStatusTool.execute({ repo_path: 'repo' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.cwd).toBe(subRepo);
  });

  it('repo_path "." — корень workspace', async () => {
    const result = await gitStatusTool.execute({ repo_path: '.' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.cwd).toBe(tmpDir);
  });

  it('repo_path с выходом через ".." → git.repo_path_invalid', async () => {
    const result = await gitStatusTool.execute({ repo_path: '../outside' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid repository path');
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.repo_path_invalid');
  });

  it('абсолютный repo_path → git.repo_path_invalid', async () => {
    const result = await gitStatusTool.execute({ repo_path: join(tmpDir, 'repo') }, makeCtx());
    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.repo_path_invalid');
  });

  it('resolveRepoCwd: containment (внутри — ок, снаружи — ошибка)', () => {
    expect(resolveRepoCwd('repo', tmpDir)).toBe(subRepo);
    expect(resolveRepoCwd('.', tmpDir)).toBe(tmpDir);
    expect(() => resolveRepoCwd('..', tmpDir)).toThrow();
    expect(() => resolveRepoCwd('../sibling', tmpDir)).toThrow();
    expect(() => resolveRepoCwd('/etc', tmpDir)).toThrow();
  });

  it('runGit с env: переменные окружения доходят до git (и не ломают локальные команды)', async () => {
    const ident = await runGit(['var', 'GIT_AUTHOR_IDENT'], tmpDir, undefined, {
      GIT_AUTHOR_NAME: 'EnvUser',
      GIT_AUTHOR_EMAIL: 'env@example.com',
    });
    expect(ident.stdout).toContain('EnvUser');

    // GIT_SSH_COMMAND не влияет на локальный status
    const status = await runGit(['status', '--porcelain', '--branch'], tmpDir, undefined, {
      GIT_SSH_COMMAND: 'ssh -i /nonexistent',
    });
    expect(status.stdout).toContain('master');
  });
});

/**
 * Значения параметров приходят от модели (а модель может быть направлена
 * недоверенным содержимым) — они не должны превращаться в опции git.
 */
describe('git tools — отказ значению-флагу (argument injection)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-args-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_diff: commit="--output=/tmp/x" — отказ, git не запускается', async () => {
    resetGitCalls();
    const result = await gitDiffTool.execute({ commit: '--output=/tmp/x' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('--output');
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    // значение не дошло до git вообще
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('--output');
  });

  it('git_diff: commit="--ext-diff" — отказ (внешний diff-драйвер)', async () => {
    resetGitCalls();
    const result = await gitDiffTool.execute({ commit: '--ext-diff' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('--ext-diff');
    expect(gitArgvLists()).toEqual([]);
  });

  it('git_checkout: target="-f" — отказ, git не запускается', async () => {
    resetGitCalls();
    const result = await gitCheckoutTool.execute({ target: '-f' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('must not start with "-"');
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('-f');
  });

  it('git_checkout: target="--orphan" — отказ, git не запускается', async () => {
    resetGitCalls();
    const result = await gitCheckoutTool.execute({ target: '--orphan' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('--orphan');
    expect(gitArgvLists()).toEqual([]);
  });

  it('git_show: object="--output=/tmp/x" — отказ, git не запускается', async () => {
    resetGitCalls();
    const result = await gitShowTool.execute({ object: '--output=/tmp/x' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('--output');
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('--output');
  });

  it('git_push: branch="+refs/heads/*:refs/heads/*" — отказ (mirror-refspec)', async () => {
    resetGitCalls();
    const result = await gitPushTool.execute({ branch: '+refs/heads/*:refs/heads/*' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('refspec');
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('refs/heads');
  });

  it('git_push: branch=":refs/heads/x" — отказ (удаление ветки на remote)', async () => {
    resetGitCalls();
    const result = await gitPushTool.execute({ branch: ':refs/heads/x' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('refspec');
    expect(gitArgvLists()).toEqual([]);
  });

  it('git_push: remote="https://attacker.example/x" — отказ (выгрузка на чужой хост)', async () => {
    resetGitCalls();
    const result = await gitPushTool.execute({ remote: 'https://attacker.example/x' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('remote');
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('attacker.example');
  });

  it('git_pull: remote="https://attacker.example/x" — отказ (выгрузка на чужой хост)', async () => {
    resetGitCalls();
    const result = await gitPullTool.execute({ remote: 'https://attacker.example/x' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('remote');
    expect(gitArgvLists()).toEqual([]);
    expect(allGitArgv().join(' ')).not.toContain('attacker.example');
  });

  it('git_push: branch="--force" — отказ, git не запускается', async () => {
    resetGitCalls();
    const result = await gitPushTool.execute({ branch: '--force' }, makeCtx());

    expect(result.isError).toBe(true);
    expect(gitArgvLists()).toEqual([]);
  });
});

/**
 * Позитивная часть: корректные значения работают, argv соответствует смыслу
 * команды (никакого лишнего `--` там, где он изменил бы разбор аргументов).
 */
describe('git tools — корректные значения: argv и смысл команды', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-ok-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_diff: commit="HEAD" — argv без "--", вывод как у `git diff HEAD`', async () => {
    await writeFile(join(tmpDir, 'README.md'), '# Test\nchanged\n');

    resetGitCalls();
    const result = await gitDiffTool.execute({ commit: 'HEAD' }, makeCtx());

    expect(result.isError).toBeFalsy();
    // `--` перед ревизией в `git diff` означал бы pathspec — его там нет
    expect(gitArgvLists()).toEqual([['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD']]);
    expect(result.content).toContain('README.md');

    // смысл команды сохранён: вывод совпадает с реальным `git diff HEAD`
    const expected = await runGit(['diff', '--no-color', 'HEAD'], tmpDir);
    expect(result.content).toBe(expected.stdout);
  });

  it('git_checkout: target="feature/x" — ветка переключена, argv без "--"', async () => {
    await execFileAsync('git', ['branch', 'feature/x'], { cwd: tmpDir });

    resetGitCalls();
    const result = await gitCheckoutTool.execute({ target: 'feature/x' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['checkout', 'feature/x']]);
    const branch = await runGit(['branch', '--show-current'], tmpDir);
    expect(branch.stdout.trim()).toBe('feature/x');
  });

  it('git_show: object="HEAD" — argv без "--", вывод как у `git show --stat HEAD`', async () => {
    resetGitCalls();
    const result = await gitShowTool.execute({ object: 'HEAD' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['show', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD']]);

    const expected = await runGit(['show', '--stat', 'HEAD'], tmpDir);
    expect(result.content).toBe(expected.stdout);
  });

  it('git_diff: commit="" — как и раньше, пустое значение не попадает в argv', async () => {
    resetGitCalls();
    const result = await gitDiffTool.execute({ commit: '' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['diff', '--no-color', '--no-ext-diff', '--no-textconv']]);
  });
});

/**
 * ADR-076: remote сетевых git-тулов привязан к реестру репозиториев проекта —
 * push/pull не могут уйти на произвольный хост.
 */
describe('git tools — push/pull: remote привязан к реестру проекта (ADR-076)', () => {
  let root: string;
  let workspace: string;
  let bare: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-remote-'));
    workspace = join(root, 'work');
    bare = join(root, 'origin.git');
    await mkdir(workspace, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--bare', bare], { cwd: root });
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: workspace });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: workspace });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: workspace });
    await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: workspace });
    sessionManager = new SessionManager(new FileStore({ dataDir: join(root, 'data') }));
    projectStore = new ProjectStore({ dataDir: join(root, 'data') });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Проект с реестром репозиториев (`project.repos`) и сессией в нём. */
  async function seedProject(url?: string): Promise<string> {
    const project = projectStore.create('P', 'u1', {
      workspace,
      repos: url ? [{ path: '.', url }] : [],
    });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });
    return session.id;
  }

  function makeCtx(sessionId: string): ToolContext {
    return {
      sessionId,
      messageId: 'm1',
      workingDir: workspace,
      extra: { sessionManager, projectStore, sessionId },
    };
  }

  it('push: remote из реестра проекта — push выполняется, argv = ["push","--","origin","main"]', async () => {
    const sessionId = await seedProject(bare);

    resetGitCalls();
    const result = await gitPushTool.execute({ branch: 'main' }, makeCtx(sessionId));

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toContainEqual(['push', '--', 'origin', 'main']);

    // ветка действительно уехала на remote
    const branches = await execFileAsync('git', ['--git-dir', bare, 'branch', '--list', 'main'], {
      cwd: root,
    });
    expect(branches.stdout).toContain('main');
  });

  it('pull: remote из реестра проекта — pull выполняется, argv = ["pull","--","origin","main"]', async () => {
    const sessionId = await seedProject(bare);
    await execFileAsync('git', ['push', '--', 'origin', 'main'], { cwd: workspace });

    resetGitCalls();
    const result = await gitPullTool.execute({ branch: 'main' }, makeCtx(sessionId));

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toContainEqual(['pull', '--', 'origin', 'main']);
  });

  it('push: ветка со "/" — обычное имя ветки принимается', async () => {
    const sessionId = await seedProject(bare);
    await execFileAsync('git', ['branch', 'feature/x'], { cwd: workspace });

    resetGitCalls();
    const result = await gitPushTool.execute({ branch: 'feature/x' }, makeCtx(sessionId));

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toContainEqual(['push', '--', 'origin', 'feature/x']);
  });

  it('push: remote не из реестра проекта — отказ, push не выполняется', async () => {
    const sessionId = await seedProject('https://example.invalid/other.git');

    resetGitCalls();
    const result = await gitPushTool.execute({}, makeCtx(sessionId));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not point to the repository registered');
    expect(gitArgvLists().some((args) => args[0] === 'push')).toBe(false);
  });

  it('push: репозиторий не зарегистрирован в проекте — отказ, push не выполняется', async () => {
    const sessionId = await seedProject();

    resetGitCalls();
    const result = await gitPushTool.execute({}, makeCtx(sessionId));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not registered in the project');
    expect(gitArgvLists().some((args) => args[0] === 'push')).toBe(false);
  });

  it('push: сессия без проекта — отказ (реестра нет), push не выполняется', async () => {
    const ctx: ToolContext = { sessionId: 's1', messageId: 'm1', workingDir: workspace };

    resetGitCalls();
    const result = await gitPushTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no project');
    expect(gitArgvLists().some((args) => args[0] === 'push')).toBe(false);
  });

  it('pull: remote не из реестра проекта — отказ, pull не выполняется', async () => {
    const sessionId = await seedProject('https://example.invalid/other.git');

    resetGitCalls();
    const result = await gitPullTool.execute({}, makeCtx(sessionId));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not point to the repository registered');
    expect(gitArgvLists().some((args) => args[0] === 'pull')).toBe(false);
  });
});

/**
 * ADR-114 §4: сессия, привязанная к worktree, работает в каталоге worktree
 * (вторичная копия того же репозитория). Поэтому `repo_path` допускается
 * **только** `.` (корень worktree): отдельного вложенного репозитория в
 * worktree нет, а `..`/абсолютный путь увели бы из вторичной копии.
 *
 * Без привязки поведение прежнее: `repo_path` — относительный путь внутри
 * workspace проекта (ADR-076).
 */
describe('git tools — repo_path в сессии с привязкой к worktree (ADR-114 §4)', () => {
  let root: string;
  let workspace: string;
  let worktree: string;
  let subRepo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-worktree-'));
    workspace = join(root, 'workspace');
    worktree = join(root, 'worktree');
    subRepo = join(workspace, 'sub');
    await mkdir(workspace, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await mkdir(subRepo, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Вызовы, дошедшие до порта исполнения (ADR-077). */
  interface ExecCall {
    cwd?: string;
    args?: string[];
  }

  /** Фейковый порт исполнения: команда не запускается, видны `cwd`/argv. */
  function makeFakePort(calls: ExecCall[]) {
    return {
      async execute(req: { command: { kind: string; args?: string[] }; cwd?: string }) {
        calls.push({
          cwd: req.cwd,
          args: req.command.kind === 'argv' ? req.command.args : undefined,
        });
        return { stdout: '## main\n', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
      },
    };
  }

  /** Контекст сессии с привязкой к worktree. */
  function makeWorktreeCtx(calls: ExecCall[]): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: worktree,
      worktreeId: 'wkt_test',
      worktreeRepoPath: '.',
      extra: { executionPort: makeFakePort(calls) },
    };
  }

  it('repo_path=".." → git.repo_path_invalid (привязка к worktree)', async () => {
    const calls: ExecCall[] = [];
    const result = await gitStatusTool.execute({ repo_path: '..' }, makeWorktreeCtx(calls));

    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.repo_path_invalid');
    // Команда не запускалась.
    expect(calls).toHaveLength(0);
  });

  it('repo_path на подкаталог → git.repo_path_invalid (привязка к worktree)', async () => {
    const calls: ExecCall[] = [];
    const result = await gitStatusTool.execute({ repo_path: 'sub' }, makeWorktreeCtx(calls));

    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.repo_path_invalid');
    expect(calls).toHaveLength(0);
  });

  it('repo_path="." → команда исполняется в каталоге worktree', async () => {
    const calls: ExecCall[] = [];
    const result = await gitStatusTool.execute({ repo_path: '.' }, makeWorktreeCtx(calls));

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(worktree);
    expect(result.metadata?.cwd).toBe(worktree);
  });

  it('без repo_path → команда исполняется в каталоге worktree', async () => {
    const calls: ExecCall[] = [];
    const result = await gitStatusTool.execute({}, makeWorktreeCtx(calls));

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(worktree);
    expect(result.metadata?.cwd).toBe(worktree);
  });

  it('без привязки: repo_path на подкаталог workspace — прежнее поведение (разрешено)', async () => {
    const calls: ExecCall[] = [];
    const ctx: ToolContext = {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: workspace,
      extra: { executionPort: makeFakePort(calls) },
    };

    const result = await gitStatusTool.execute({ repo_path: 'sub' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(subRepo);
    expect(result.metadata?.cwd).toBe(subRepo);
  });

  it('без привязки: repo_path=".." → git.repo_path_invalid (прежнее поведение)', async () => {
    const calls: ExecCall[] = [];
    const ctx: ToolContext = {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: workspace,
      extra: { executionPort: makeFakePort(calls) },
    };

    const result = await gitStatusTool.execute({ repo_path: '..' }, ctx);

    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.repo_path_invalid');
    expect(calls).toHaveLength(0);
  });
});

/**
 * Таймауты git-тулов: класс-дефолты по классу операции (read-only 30 с,
 * локальные изменяющие 120 с, сетевые 300 с), per-call переопределение
 * параметром `timeout` и actionable-ответ при истечении лимита.
 */
describe('git tools — таймауты', () => {
  let root: string;
  let workspace: string;
  let bare: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-timeout-'));
    workspace = join(root, 'work');
    bare = join(root, 'origin.git');
    await mkdir(workspace, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--bare', bare], { cwd: root });
    await execFileAsync('git', ['init', '-q'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    await writeFile(join(workspace, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: workspace });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: workspace });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: workspace });
    await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: workspace });
    sessionManager = new SessionManager(new FileStore({ dataDir: join(root, 'data') }));
    projectStore = new ProjectStore({ dataDir: join(root, 'data') });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Вызов, дошедший до порта исполнения (ADR-077). */
  interface ExecCall {
    cwd?: string;
    args?: string[];
    timeoutMs?: number;
  }

  /**
   * Порт-заглушка: пишет запросы (виден таймаут) и ничего не запускает.
   * `remote get-url` отдаёт URL зарегистрированного репозитория — иначе
   * сетевой тул откажется до самой операции.
   */
  function makePort(calls: ExecCall[], timeout = false) {
    return {
      async execute(req: { command: { kind: string; args?: string[] }; cwd?: string; timeoutMs?: number }) {
        const args = req.command.kind === 'argv' ? (req.command.args ?? []) : [];
        calls.push({
          cwd: req.cwd,
          args: req.command.kind === 'argv' ? req.command.args : undefined,
          timeoutMs: req.timeoutMs,
        });
        if (args[0] === 'remote') {
          return { stdout: `${bare}\n`, stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
        }
        if (timeout) {
          throw new ExecutionError({
            message: 'Command failed: git',
            code: null,
            killed: true,
            signal: 'SIGTERM',
            reason: 'timeout',
            stdout: 'partial-output',
          });
        }
        return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
      },
    };
  }

  /** Проект с реестром репозиториев (`project.repos`) и сессией в нём. */
  async function seedProject(): Promise<string> {
    const project = projectStore.create('P', 'u1', {
      workspace,
      repos: [{ path: '.', url: bare }],
    });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });
    return session.id;
  }

  function makeCtx(
    port: unknown,
    overrides: Partial<ToolContext> = {},
    extra: Record<string, unknown> = {},
  ): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: workspace,
      ...overrides,
      extra: { executionPort: port, ...extra, ...(overrides.extra ?? {}) },
    };
  }

  it('read-only (status) — класс-дефолт 30 с доходит до порта', async () => {
    const calls: ExecCall[] = [];
    await gitStatusTool.execute({}, makeCtx(makePort(calls)));

    expect(calls[0]!.timeoutMs).toBe(30_000);
  });

  it('локальная изменяющая операция (commit) — класс-дефолт 120 с', async () => {
    const calls: ExecCall[] = [];
    await gitCommitTool.execute({ message: 'msg' }, makeCtx(makePort(calls)));

    expect(calls[0]!.timeoutMs).toBe(120_000);
  });

  it('сетевая операция (pull) — класс-дефолт 300 с', async () => {
    const sessionId = await seedProject();
    const calls: ExecCall[] = [];
    const result = await gitPullTool.execute(
      { branch: 'main' },
      makeCtx(
        makePort(calls),
        { sessionId },
        { sessionManager, projectStore, sessionId },
      ),
    );

    expect(result.isError).toBeFalsy();
    const pull = calls.find((c) => c.args?.[0] === 'pull');
    expect(pull?.timeoutMs).toBe(300_000);
  });

  it('config инстанца перекрывает класс-дефолт (local/network)', async () => {
    const sessionId = await seedProject();
    const calls: ExecCall[] = [];
    const extra = { gitLocalTimeoutMs: 7_000, gitNetworkTimeoutMs: 9_000 };

    await gitCommitTool.execute({ message: 'msg' }, makeCtx(makePort(calls), {}, extra));
    expect(calls[0]!.timeoutMs).toBe(7_000);

    await gitPullTool.execute(
      { branch: 'main' },
      makeCtx(
        makePort(calls),
        { sessionId },
        { ...extra, sessionManager, projectStore, sessionId },
      ),
    );

    const pull = calls.find((c) => c.args?.[0] === 'pull');
    expect(pull?.timeoutMs).toBe(9_000);
  });

  it('per-call `timeout` перекрывает класс-дефолт', async () => {
    const sessionId = await seedProject();
    const calls: ExecCall[] = [];

    await gitStatusTool.execute({ timeout: 45_000 }, makeCtx(makePort(calls)));
    expect(calls[0]!.timeoutMs).toBe(45_000);

    await gitPullTool.execute(
      { branch: 'main', timeout: 90_000 },
      makeCtx(
        makePort(calls),
        { sessionId },
        { sessionManager, projectStore, sessionId },
      ),
    );

    const pull = calls.find((c) => c.args?.[0] === 'pull');
    expect(pull?.timeoutMs).toBe(90_000);
  });

  it('таймаут: результат содержит величину лимита и подсказку, metadata.reason=timeout', async () => {
    const calls: ExecCall[] = [];
    const result = await gitStatusTool.execute({}, makeCtx(makePort(calls, true)));

    expect(result.isError).toBe(true);
    expect(result.metadata?.reason).toBe('timeout');
    expect(result.metadata?.timeoutMs).toBe(30_000);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('git.timeout');
    // Величина лимита + подсказка (не «Ошибка git status»).
    expect(result.content).toContain('30000');
    expect(result.content).toContain('timeout');
    expect(result.content).not.toContain('Ошибка git status');
  });

  it('таймаут сетевой операции: в тексте — величина сетевого лимита', async () => {
    const sessionId = await seedProject();
    const calls: ExecCall[] = [];
    const port = makePort(calls, true);

    const result = await gitPullTool.execute(
      { branch: 'main' },
      makeCtx(
        port,
        { sessionId },
        { sessionManager, projectStore, sessionId },
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.reason).toBe('timeout');
    expect(result.metadata?.timeoutMs).toBe(300_000);
    expect(result.content).toContain('300000');
  });
});

/**
 * Регрессы на реальном git в tmp-каталоге: поведение команд, которое нельзя
 * проверить по argv (порядок подкоманды stash, счётчик изменений в status,
 * remote-ветки в `branch --all -vv`, лимит строк blame, объекты `git show`,
 * detached checkout по ревизии).
 */
describe('git tools — реальные операции (регрессы)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-real-'));
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('git_stash: include_untracked реально кладёт неотслеживаемый файл в stash (и с message)', async () => {
    await writeFile(join(tmpDir, 'README.md'), '# Test\nchanged\n');
    await writeFile(join(tmpDir, 'untracked.txt'), 'new\n');

    resetGitCalls();
    const result = await gitStashTool.execute({ include_untracked: true, message: 'wip' }, makeCtx());

    expect(result.isError).toBeFalsy();
    // `push` — подкоманда, опции идут после неё; иначе git: «subcommand wasn't specified».
    expect(gitArgvLists()).toEqual([['stash', 'push', '--include-untracked', '-m', 'wip']]);

    const list = await runGit(['stash', 'list'], tmpDir);
    expect(list.stdout).toContain('wip');

    const stashed = await runGit(['stash', 'show', '--include-untracked', '--name-only'], tmpDir);
    expect(stashed.stdout).toContain('untracked.txt');

    // рабочее дерево после stash пустое (и tracked-правка, и untracked убраны)
    const status = await runGit(['status', '--porcelain'], tmpDir);
    expect(status.stdout.trim()).toBe('');
  });

  it('git_status: чистый репозиторий → hasChanges=false, после правки → true', async () => {
    const clean = await gitStatusTool.execute({}, makeCtx());
    expect(clean.isError).toBeFalsy();
    // шапка `## <branch>` остаётся в content, но изменением не считается
    expect(clean.content).toContain('##');
    expect(clean.metadata?.hasChanges).toBe(false);

    await writeFile(join(tmpDir, 'README.md'), '# Test\nchanged\n');
    const dirty = await gitStatusTool.execute({}, makeCtx());
    expect(dirty.metadata?.hasChanges).toBe(true);

    // один неотслеживаемый файл — тоже изменение
    await runGit(['checkout', '--', 'README.md'], tmpDir);
    await writeFile(join(tmpDir, 'new.txt'), 'x\n');
    const untracked = await gitStatusTool.execute({}, makeCtx());
    expect(untracked.metadata?.hasChanges).toBe(true);
  });

  it('git_branch_list: all+verbose показывает remote-ветки (оба флага доходят до git)', async () => {
    await runGit(['update-ref', 'refs/remotes/origin/topic', 'HEAD'], tmpDir);

    resetGitCalls();
    const result = await gitBranchListTool.execute({ all: true, verbose: true }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['branch', '--all', '-vv']]);
    expect(result.content).toContain('remotes/origin/topic');
    // текущая ветка + удалённая
    expect(result.metadata?.count).toBe(2);
  });

  it('git_blame: max_count считает строки (без line_range → -L 1,N)', async () => {
    await writeFile(join(tmpDir, 'lines.txt'), 'l1\nl2\nl3\n');
    await runGit(['add', '.'], tmpDir);
    await runGit(['commit', '-q', '-m', 'lines'], tmpDir);

    resetGitCalls();
    const result = await gitBlameTool.execute({ file: 'lines.txt', max_count: 1 }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['blame', '-L', '1,1', '--', 'lines.txt']]);
    expect(result.content.split('\n').filter(Boolean)).toHaveLength(1);
    expect(result.metadata?.count).toBe(1);
  });

  it('git_blame: line_range сохраняется, а max_count обрезает вывод', async () => {
    await writeFile(join(tmpDir, 'lines.txt'), 'l1\nl2\nl3\n');
    await runGit(['add', '.'], tmpDir);
    await runGit(['commit', '-q', '-m', 'lines'], tmpDir);

    resetGitCalls();
    const result = await gitBlameTool.execute({ file: 'lines.txt', line_range: '1,3', max_count: 2 }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(gitArgvLists()).toEqual([['blame', '-L', '1,3', '--', 'lines.txt']]);
    expect(result.content.split('\n').filter(Boolean)).toHaveLength(2);
    expect(result.metadata?.count).toBe(2);
  });

  it('git_show: object="HEAD:<file>" отдаёт содержимое blob, "HEAD~1" работает', async () => {
    await writeFile(join(tmpDir, 'version.txt'), 'v1\n');
    await runGit(['add', '.'], tmpDir);
    await runGit(['commit', '-q', '-m', 'v1'], tmpDir);
    await writeFile(join(tmpDir, 'version.txt'), 'v2\n');
    await runGit(['add', '.'], tmpDir);
    await runGit(['commit', '-q', '-m', 'v2'], tmpDir);

    resetGitCalls();
    const blob = await gitShowTool.execute({ object: 'HEAD:version.txt' }, makeCtx());
    expect(blob.isError).toBeFalsy();
    expect(blob.content.trim()).toBe('v2');
    expect(gitArgvLists()).toEqual([['show', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD:version.txt']]);

    const prev = await gitShowTool.execute({ object: 'HEAD~1' }, makeCtx());
    expect(prev.isError).toBeFalsy();
    // коммит v1: сообщение и добавление файла
    expect(prev.content).toContain('v1');
  });

  it('git_checkout: target="HEAD~1" переключает в detached HEAD', async () => {
    await writeFile(join(tmpDir, 'version.txt'), 'v1\n');
    await runGit(['add', '.'], tmpDir);
    await runGit(['commit', '-q', '-m', 'v1'], tmpDir);

    const result = await gitCheckoutTool.execute({ target: 'HEAD~1' }, makeCtx());

    expect(result.isError).toBeFalsy();
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], tmpDir);
    expect(head.stdout.trim()).toBe('HEAD');
  });
});

/** Allowlist значений git-тулов: ослабление под `git show`/`git checkout` не должно открыть опции/refspec. */
describe('git tools — validateGitValue (allowlist)', () => {
  it('отвергает опции git', () => {
    expect(validateGitValue('--output=/tmp/x', 'object')).toContain('--output');
    expect(validateGitValue('--ext-diff', 'object')).toContain('--ext-diff');
    expect(validateGitValue('-f', 'ref')).toContain('must not start with');
    expect(validateGitValue('--force', 'branch')).not.toBeNull();
    expect(validateGitValue('--force', 'remote')).not.toBeNull();
    // `--` перед значением не пропускается даже как «ревизия»
    expect(validateGitValue('-HEAD~1', 'ref')).not.toBeNull();
  });

  it('refspec запрещён для ref/branch, разрешён для object', () => {
    expect(validateGitValue('src:dst', 'ref')).toContain('refspec');
    expect(validateGitValue('src:dst', 'branch')).toContain('refspec');
    expect(validateGitValue(':refs/heads/x', 'branch')).toContain('refspec');
    expect(validateGitValue('HEAD:src/file.ts', 'object')).toBeNull();
  });

  it('ревизионные суффиксы: ref/object — да, branch — нет', () => {
    expect(validateGitValue('HEAD~1', 'ref')).toBeNull();
    expect(validateGitValue('HEAD^2', 'ref')).toBeNull();
    expect(validateGitValue('HEAD~1', 'object')).toBeNull();
    expect(validateGitValue('main^', 'object')).toBeNull();
    expect(validateGitValue('feature~1', 'branch')).not.toBeNull();
  });
});
