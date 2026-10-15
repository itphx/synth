import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPath } from './protected-paths.js';
import type { ProtectedPathsPolicy } from './protected-paths.js';

/**
 * Защищённые пути не должны обходиться симлинком внутри workspace:
 * `link -> {dataDir}/secrets` и `link -> <denied file>` обязаны давать deny,
 * потому что проверка идёт и по разыменованному пути.
 */
describe('protected-paths — обход через симлинк', () => {
  let tmpDir: string;
  let workspace: string;
  let outside: string;
  let policy: ProtectedPathsPolicy;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-prot-symlink-'));
    workspace = join(tmpDir, 'ws');
    outside = join(tmpDir, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(join(tmpDir, 'secrets', 'master.key'), 'KEY');
    await writeFile(join(outside, 'secret.txt'), 'TOP');
    policy = {
      deniedPaths: [],
      deniedPrefixes: [join(tmpDir, 'secrets')],
      approvalPaths: [],
      deniedCommandPrefixes: [],
      dataDir: tmpDir,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('симлинк-каталог на {dataDir}/secrets → deny', async () => {
    await symlink(join(tmpDir, 'secrets'), join(workspace, 'leakdir'));
    const res = checkPath(join(workspace, 'leakdir', 'master.key'), workspace, policy);
    expect(res.action).toBe('deny');
    expect(res.matchedRule).toBe('protected-paths.deny');
  });

  it('симлинк-файл на {dataDir}/secrets/master.key → deny', async () => {
    await symlink(join(tmpDir, 'secrets', 'master.key'), join(workspace, 'leakfile'));
    const res = checkPath(join(workspace, 'leakfile'), workspace, policy);
    expect(res.action).toBe('deny');
  });

  it('цепочка симлинков на защищённый путь → deny', async () => {
    await symlink(join(tmpDir, 'secrets'), join(workspace, 'hop1'));
    await symlink(join(workspace, 'hop1'), join(workspace, 'hop2'));
    const res = checkPath(join(workspace, 'hop2', 'master.key'), workspace, policy);
    expect(res.action).toBe('deny');
  });

  it('симлинк на запрещённый точный путь (deniedPaths) → deny', async () => {
    await symlink(join(outside, 'secret.txt'), join(workspace, 'leak.txt'));
    const exact: ProtectedPathsPolicy = { ...policy, deniedPaths: [join(outside, 'secret.txt')] };
    const res = checkPath(join(workspace, 'leak.txt'), workspace, exact);
    expect(res.action).toBe('deny');
    expect(res.matchedRule).toBe('protected-paths.deny');
  });

  it('симлинк на approvalPath → ask', async () => {
    await symlink(join(outside, 'secret.txt'), join(workspace, 'leak.txt'));
    const ask: ProtectedPathsPolicy = { ...policy, deniedPaths: [], deniedPrefixes: [], approvalPaths: [join(outside, 'secret.txt')] };
    const res = checkPath(join(workspace, 'leak.txt'), workspace, ask);
    expect(res.action).toBe('ask');
  });

  it('симлинк внутрь на незащищённый путь → allow', async () => {
    await mkdir(join(workspace, 'sub'));
    await symlink(join(workspace, 'sub'), join(workspace, 'inlink'));
    const res = checkPath(join(workspace, 'inlink', 'file.txt'), workspace, policy);
    expect(res.action).toBe('allow');
  });

  it('регрессия: лексический защищённый путь по-прежнему deny', () => {
    const res = checkPath(join(tmpDir, 'secrets', 'master.key'), workspace, policy);
    expect(res.action).toBe('deny');
  });

  it('битый симлинк: защищённый путь недостижим → не deny, ловит файловый тул', async () => {
    await symlink(join(tmpDir, 'secrets', 'missing.key'), join(workspace, 'dangling'));
    const res = checkPath(join(workspace, 'dangling'), workspace, policy);
    // Цель отсутствует — защищённый путь через этот симлинк недостижим;
    // fail-closed обеспечивает файловый тул (isSymlinkEscape).
    expect(res.action).toBe('allow');
  });
});
