// Лимиты FS-контура: cap чтения файла (`GET /read`) и пределы рекурсивного
// листинга (`GET /?maxDepth=`).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createFsRoutes } from './fs.js';
import type { AuthKit } from '../../auth/local.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';

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
  deniedCommandPaths: [],
} as unknown as ProtectedPathsPolicy;

describe('FS: лимит чтения файла (GET /read)', () => {
  let tmpDir: string;
  let root: string;

  function makeApp(opts: { maxReadBytes?: number } = {}): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), root, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      ...opts,
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-read-cap-'));
    root = join(tmpDir, 'workspaces');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('файл в пределах лимита → 200 с содержимым', async () => {
    await writeFile(join(root, 'small.txt'), 'hello');
    const res = await makeApp({ maxReadBytes: 1024 }).request('/api/v2/fs/read?path=small.txt');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; encoding: string };
    expect(body.content).toBe('hello');
    expect(body.encoding).toBe('utf-8');
  });

  it('файл больше лимита → 413 FILE_TOO_LARGE + details.maxReadBytes', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(100));
    const res = await makeApp({ maxReadBytes: 16 }).request('/api/v2/fs/read?path=big.txt');
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: { maxReadBytes?: number; size?: number; reason?: string } };
    };
    expect(body.error.code).toBe('FILE_TOO_LARGE');
    expect(body.error.details?.maxReadBytes).toBe(16);
    expect(body.error.details?.size).toBe(100);
    expect(body.error.details?.reason).toBe('size');
  });

  it('бинарный файл → тот же отказ (FILE_TOO_LARGE, reason=binary)', async () => {
    await writeFile(join(root, 'data.xyz'), Buffer.from([1, 0, 2, 3]));
    const res = await makeApp({ maxReadBytes: 1024 }).request('/api/v2/fs/read?path=data.xyz');
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; details?: { maxReadBytes?: number; reason?: string } };
    };
    expect(body.error.code).toBe('FILE_TOO_LARGE');
    expect(body.error.details?.reason).toBe('binary');
    expect(body.error.details?.maxReadBytes).toBe(1024);
  });

  it('без опции maxReadBytes дефолт 5 МиБ: небольшой файл → 200', async () => {
    await writeFile(join(root, 'ok.txt'), 'small');
    const res = await makeApp().request('/api/v2/fs/read?path=ok.txt');
    expect(res.status).toBe(200);
  });
});

describe('FS: пределы листинга каталога (GET /)', () => {
  let tmpDir: string;
  let root: string;

  function makeApp(opts: { maxListEntries?: number } = {}): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), root, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      ...opts,
    }));
    return app;
  }

  /** Дерево `a/b/c/d/file.txt` (глубина 4 от корня). */
  async function makeDeepTree(): Promise<void> {
    await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c', 'd', 'file.txt'), 'x');
    await writeFile(join(root, 'a', 'b', 'c', 'mid.txt'), 'x');
    await writeFile(join(root, 'a', 'top.txt'), 'x');
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-list-cap-'));
    root = join(tmpDir, 'workspaces');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('maxDepth по умолчанию (0) — без рекурсии, truncated=false', async () => {
    await makeDeepTree();
    const res = await makeApp().request('/api/v2/fs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ name: string; path: string }>;
      truncated: boolean;
    };
    expect(body.entries.map((e) => e.name)).toEqual(['a']);
    expect(body.truncated).toBe(false);
  });

  it('maxDepth > 3 режется до 3 (файлы глубже не отдаются)', async () => {
    await makeDeepTree();
    const res = await makeApp().request('/api/v2/fs?maxDepth=9');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ path: string }>; truncated: boolean };
    const paths = body.entries.map((e) => e.path);
    // Глубина 3 от корня: a/b/c/* — содержимое уровня `d` уже не отдаётся.
    expect(paths).toContain('a/b/c/mid.txt');
    expect(paths).not.toContain('a/b/c/d/file.txt');
  });

  it('превышение cap записей → truncated=true, обход прекращается', async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(root, `f${i}.txt`), 'x');
    }
    const res = await makeApp({ maxListEntries: 4 }).request('/api/v2/fs?maxDepth=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; truncated: boolean };
    expect(body.entries.length).toBe(4);
    expect(body.truncated).toBe(true);
  });

  it('без достижения cap → truncated=false', async () => {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(root, `f${i}.txt`), 'x');
    }
    const res = await makeApp({ maxListEntries: 100 }).request('/api/v2/fs?maxDepth=1');
    const body = (await res.json()) as { entries: unknown[]; truncated: boolean };
    expect(body.entries.length).toBe(3);
    expect(body.truncated).toBe(false);
  });
});
