// Предел размера diff коммита (`GET /api/v2/git/commit`): diff обрезается,
// в DTO добавляется `diff_truncated: true`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitRoutes } from './git.js';
import { ProjectStore } from '../../storage/project-store.js';
import { truncateDiff, MAX_COMMIT_DIFF_BYTES } from '../../git/git-service.js';

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

describe('git: обрезка diff коммита', () => {
  it('truncateDiff режет по байтам и помечает усечение', () => {
    const small = truncateDiff('abc', 1024);
    expect(small.truncated).toBe(false);
    expect(small.diff).toBe('abc');

    const big = truncateDiff('x'.repeat(2000), 100);
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.diff, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('truncateDiff не рвёт UTF-8-последовательность', () => {
    // Кириллица — 2 байта на символ: граница режет посреди символа.
    const text = 'а'.repeat(10);
    const cut = truncateDiff(text, 5);
    expect(cut.truncated).toBe(true);
    expect(cut.diff).not.toContain('�');
    expect(cut.diff).toBe('аа');
  });

  it('дефолт предела — 1 МиБ', () => {
    expect(MAX_COMMIT_DIFF_BYTES).toBe(1024 * 1024);
  });
});

describe('git: GET /commit — diff_truncated', () => {
  let root: string;
  let workspacesRoot: string;
  let projectId: string;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-diff-cap-'));
    workspacesRoot = join(root, 'workspaces');
    await mkdir(join(workspacesRoot, 'proj'), { recursive: true });
    projectStore = new ProjectStore({ dataDir: join(root, 'data') });
    const project = projectStore.create('Demo', 'owner', { workspace: 'proj' });
    projectId = project.id;
    await projectStore.save(project);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Репозиторий с одним коммитом; размер diff — `lines` строк по 100 символов. */
  async function createRepo(lines: number): Promise<string> {
    const execFileAsync = promisify(execFile);
    const git = (args: string[]) => execFileAsync('git', args, { cwd: join(workspacesRoot, 'proj') });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(
      join(workspacesRoot, 'proj', 'big.txt'),
      Array.from({ length: lines }, (_, i) => `line-${i}-${'x'.repeat(90)}`).join('\n'),
    );
    await git(['add', '.']);
    await git(['commit', '-m', 'big']);
    const { stdout } = await git(['rev-parse', 'HEAD']);
    return stdout.trim();
  }

  function makeApp(maxDiffBytes?: number): Hono {
    const app = new Hono();
    app.route('/api/v2/git', createGitRoutes(
      { requireAuth: passAuth },
      projectStore,
      workspacesRoot,
      maxDiffBytes !== undefined ? { maxDiffBytes } : {},
    ));
    return app;
  }

  it('diff больше предела → diff_truncated=true, строка обрезана', async () => {
    const hash = await createRepo(200);
    const res = await makeApp(1024).request(
      `/api/v2/git/commit?project_id=${projectId}&hash=${hash}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commit: { diff: string; diff_truncated?: boolean; files: unknown[] };
    };
    expect(body.commit.diff_truncated).toBe(true);
    expect(Buffer.byteLength(body.commit.diff, 'utf-8')).toBeLessThanOrEqual(1024);
    // Метаданные коммита на месте, файлы перечислены.
    expect(body.commit.files.length).toBeGreaterThan(0);
  });

  it('diff в пределах → diff_truncated отсутствует', async () => {
    const hash = await createRepo(2);
    const res = await makeApp(1024 * 1024).request(
      `/api/v2/git/commit?project_id=${projectId}&hash=${hash}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commit: { diff: string; diff_truncated?: boolean };
    };
    expect(body.commit.diff_truncated).toBeUndefined();
    expect(body.commit.diff.length).toBeGreaterThan(0);
  });
});
