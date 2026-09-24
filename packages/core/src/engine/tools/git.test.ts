import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatusTool, runGit, resolveRepoCwd } from './git.js';
import type { ToolContext } from '@itphx/synth-shared';

const execFileAsync = promisify(execFile);

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

describe('git tools — repo_path (AD-076 §T6)', () => {
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
