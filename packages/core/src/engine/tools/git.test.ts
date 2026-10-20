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
  gitCheckoutTool,
  gitShowTool,
  runGit,
  resolveRepoCwd,
} from './git.js';
import type { ToolContext } from '@itphx/synth-shared';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';

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
  return { ...actual, execFile: execFileMock };
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
