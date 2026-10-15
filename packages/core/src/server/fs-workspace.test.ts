import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { resolveProjectWorkspace, isTextFile } from './fs-workspace.js';

describe('resolveProjectWorkspace (ADR-075)', () => {
  let tmpDir: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-ws-'));
    root = join(tmpDir, 'workspaces');
    outside = join(tmpDir, 'outside');
    await mkdir(join(root, 'my-project'), { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const getProject = (map: Record<string, { workspace?: string } | null>) =>
    async (id: string) => map[id] ?? null;

  it('относительный workspace резолвится от root', async () => {
    const dir = await resolveProjectWorkspace('p', {
      workspacesRoot: root,
      getProject: getProject({ p: { workspace: 'my-project' } }),
    });
    expect(dir).toBe(resolve(root, 'my-project'));
  });

  it('абсолютный workspace внутри root остаётся как есть', async () => {
    const dir = await resolveProjectWorkspace('p', {
      workspacesRoot: root,
      getProject: getProject({ p: { workspace: resolve(root, 'my-project') } }),
    });
    expect(dir).toBe(resolve(root, 'my-project'));
  });

  it('относительный root нормализуется к абсолютному (регрессия ADR-075)', async () => {
    const relRoot = relative(process.cwd(), root);
    expect(isAbsolute(relRoot)).toBe(false);
    const dir = await resolveProjectWorkspace('p', {
      workspacesRoot: relRoot,
      getProject: getProject({ p: { workspace: 'my-project' } }),
    });
    expect(dir).toBe(resolve(root, 'my-project'));
  });

  it('strict: проект не найден → NOT_FOUND', async () => {
    await expect(resolveProjectWorkspace('missing', {
      workspacesRoot: root, getProject: getProject({}), strict: true,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('non-strict: проект не найден → null (fallback)', async () => {
    const dir = await resolveProjectWorkspace('missing', {
      workspacesRoot: root, getProject: getProject({}),
    });
    expect(dir).toBeNull();
  });

  it('strict: workspace не задан → WORKSPACE_NOT_SET', async () => {
    await expect(resolveProjectWorkspace('p', {
      workspacesRoot: root, getProject: getProject({ p: {} }), strict: true,
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_SET' });
  });

  it('strict: каталог workspace отсутствует → WORKSPACE_NOT_FOUND', async () => {
    await expect(resolveProjectWorkspace('p', {
      workspacesRoot: root, getProject: getProject({ p: { workspace: 'nope' } }), strict: true,
    })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });

  it('strict: workspace не директория → NOT_A_DIRECTORY', async () => {
    await writeFile(join(root, 'afile'), 'x');
    await expect(resolveProjectWorkspace('p', {
      workspacesRoot: root, getProject: getProject({ p: { workspace: 'afile' } }), strict: true,
    })).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' });
  });

  it('deny: workspace вне root → PATH_TRAVERSAL', async () => {
    await expect(resolveProjectWorkspace('p', {
      workspacesRoot: root,
      getProject: getProject({ p: { workspace: outside } }),
      outsideRootPolicy: () => 'deny',
      strict: true,
    })).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });

  it('соседний rootfoo не считается внутри root (containment)', async () => {
    await expect(resolveProjectWorkspace('p', {
      workspacesRoot: root,
      getProject: getProject({ p: { workspace: `${root}foo` } }),
      strict: true,
    })).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });

  it('confirm: абсолютный workspace вне root разрешён', async () => {
    const dir = await resolveProjectWorkspace('p', {
      workspacesRoot: root,
      getProject: getProject({ p: { workspace: outside } }),
      outsideRootPolicy: () => 'confirm',
      strict: true,
    });
    expect(dir).toBe(outside);
  });
});

describe('isTextFile (ADR-075)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-text-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('текстовое расширение → true', async () => {
    const p = join(tmpDir, 'a.ts');
    await writeFile(p, 'const x = 1;');
    expect(await isTextFile(p)).toBe(true);
  });

  it('бинарное расширение → false без чтения', async () => {
    const p = join(tmpDir, 'a.png');
    await writeFile(p, 'not really png');
    expect(await isTextFile(p)).toBe(false);
  });

  it('неизвестное расширение с NUL-байтом → false', async () => {
    const p = join(tmpDir, 'data.xyz');
    await writeFile(p, Buffer.from([1, 0, 2, 3]));
    expect(await isTextFile(p)).toBe(false);
  });

  it('неизвестное расширение без NUL → true', async () => {
    const p = join(tmpDir, 'notes.qqq');
    await writeFile(p, 'plain text');
    expect(await isTextFile(p)).toBe(true);
  });

  it('UTF-16 BOM → true', async () => {
    const p = join(tmpDir, 'bom.zzz');
    await writeFile(p, Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    expect(await isTextFile(p)).toBe(true);
  });
});
