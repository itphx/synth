import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { resolveProjectRepoEntry, resolveRepoGitEnv } from './git-ssh.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SSHKeyStore } from '../../storage/ssh-key-store.js';

/**
 * ADR-077 (протокол 4): SSH-доступ — это **секрет вызова** (`ExecSecret`),
 * а не путь к файлу в control plane. Материализацию (временный ключ `0600`
 * в каталоге `0700`) делает **точка исполнения**: в remote-режиме — исполнитель
 * (путь control plane в его контейнере не существует).
 *
 * Поэтому проверки здесь — обратные: в control plane **не должно** появиться
 * ни каталога `synth-ssh-*`, ни файла с материалом ключа.
 */
// Фикстура: PEM собирается в рантайме, чтобы в исходниках не было литерала
// заголовка приватного ключа (secret-scan); тело — заведомая заглушка.
const pem = (body: string): string => {
  const label = 'OPENSSH PRIVATE KEY';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
};
const PRIVATE_KEY = pem('control-plane-must-not-materialize');
const PASSPHRASE = 'passphrase-must-not-leak';
/** Префикс временных каталогов SSH-ключа (общий с core `createSshEnv`). */
const SSH_TEMP_DIR_PREFIX = 'synth-ssh-';

/**
 * Ищет в `os.tmpdir()` каталоги `synth-ssh-*`, в которых лежит материал
 * ключа (по содержимому файлов).
 *
 * Поиск по **содержимому**, а не по имени каталога: тесты идут параллельно,
 * и чужой каталог `synth-ssh-*` (от другого теста) не должен давать ложную
 * ошибку — важен именно материал **нашего** ключа.
 */
async function findMaterializedKeyMaterial(marker: string): Promise<string[]> {
  const root = tmpdir();
  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!name.startsWith(SSH_TEMP_DIR_PREFIX)) continue;
    const dir = join(root, name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        if (content.includes(marker)) found.push(join(dir, file));
      } catch {
        // Файл недоступен/не файл — материал не найден.
      }
    }
  }
  return found;
}

describe('resolveRepoGitEnv (ADR-076 §T6, ADR-077 протокол 4)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let sshKeyStore: SSHKeyStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-git-ssh-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    sshKeyStore = new SSHKeyStore({ dataDir: tmpDir, env: process.env });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function seedProject(repos: Array<{ path: string; sshKeyId?: string }>) {
    const project = projectStore.create('P', 'u1', { workspace: tmpDir, repos });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });
    return session.id;
  }

  function makeCtx(sessionId: string): ToolContext {
    return {
      sessionId,
      messageId: 'm1',
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, sshKeyStore },
    };
  }

  it('репо-запись с sshKeyId → секрет вызова ssh-key; в control plane ключ не материализуется', async () => {
    const key = await sshKeyStore.create({ name: 'k1', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: key.id }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.error).toBeUndefined();

    // Секрет вызова — значение приватного ключа (не путь к файлу).
    expect(result.secrets).toHaveLength(1);
    const secret = result.secrets?.[0];
    expect(secret?.kind).toBe('ssh-key');
    expect(secret?.privateKey).toBe(PRIVATE_KEY);

    // Пути/окружения с ключом в результате нет — только значение.
    expect('env' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('GIT_SSH_COMMAND');
    expect(JSON.stringify(result)).not.toContain(SSH_TEMP_DIR_PREFIX);

    // Материализации в control plane нет: ни одного файла с материалом ключа.
    expect(await findMaterializedKeyMaterial('control-plane-must-not-materialize')).toEqual([]);

    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('passphrase ключа едет в секрете вызова и не материализуется в control plane', async () => {
    const key = await sshKeyStore.create({
      name: 'k-pass',
      privateKey: PRIVATE_KEY,
      passphrase: PASSPHRASE,
    });
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: key.id }]);

    const result = await resolveRepoGitEnv(makeCtx(sessionId), join(tmpDir, 'repo'));
    expect(result.error).toBeUndefined();
    expect(result.secrets?.[0]?.passphrase).toBe(PASSPHRASE);

    expect(await findMaterializedKeyMaterial(PASSPHRASE)).toEqual([]);
    expect(await findMaterializedKeyMaterial('control-plane-must-not-materialize')).toEqual([]);

    await result.cleanup();
  });

  it('запись без sshKeyId → секретов нет (ambient ssh)', async () => {
    const sessionId = await seedProject([{ path: 'repo' }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.secrets).toBeUndefined();
    expect(result.error).toBeUndefined();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('несуществующий ключ → sshkey.not_found', async () => {
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: 'missing' }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.error).toBe('sshkey.not_found');
    expect(result.errorParams).toEqual({ id: 'missing' });
    expect(result.secrets).toBeUndefined();
  });

  it('корень workspace (path ".") сопоставляется с cwd проекта', async () => {
    const key = await sshKeyStore.create({ name: 'root-key', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: '.', sshKeyId: key.id }]);

    const result = await resolveRepoGitEnv(makeCtx(sessionId), tmpDir);
    expect(result.error).toBeUndefined();
    expect(result.secrets?.[0]?.kind).toBe('ssh-key');
    await result.cleanup();
  });

  it('cwd вне записи реестра → секретов нет', async () => {
    const key = await sshKeyStore.create({ name: 'k2', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: key.id }]);
    const other = join(tmpDir, 'other');
    await rm(other, { recursive: true, force: true });

    const result = await resolveRepoGitEnv(makeCtx(sessionId), join(tmpDir, 'other'));
    expect(result.secrets).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('без sshKeyStore в extra → секретов нет (нет доступа к ключам)', async () => {
    const ctx: ToolContext = {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: {},
    };
    const result = await resolveRepoGitEnv(ctx, tmpDir);
    expect(result.secrets).toBeUndefined();
  });
});

/**
 * ADR-114 §4: в сессии, привязанной к worktree, каталог `cwd` лежит **вне**
 * `project.workspace` (worktree — вторичная копия репозитория), поэтому
 * относительный путь от корня workspace вычислим не всегда. Запись реестра
 * `project.repos` ищется по `worktreeRepoPath` — пути репозитория worktree
 * относительно `project.workspace` (тот же контракт, что у `repo_path`).
 */
describe('resolveRepoGitEnv / resolveProjectRepoEntry — привязка к worktree (ADR-114 §4)', () => {
  let root: string;
  let workspace: string;
  let worktree: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let sshKeyStore: SSHKeyStore;
  let sessionId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-git-ssh-worktree-'));
    workspace = join(root, 'workspace');
    worktree = join(root, 'worktree');
    await mkdir(workspace, { recursive: true });
    await mkdir(worktree, { recursive: true });
    sessionManager = new SessionManager(new FileStore({ dataDir: root }));
    projectStore = new ProjectStore({ dataDir: root });
    sshKeyStore = new SSHKeyStore({ dataDir: root, env: process.env });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Проект с реестром репозиториев и сессией в нём. */
  async function seedProject(repos: Array<{ path: string; sshKeyId?: string }>): Promise<void> {
    const project = projectStore.create('P', 'u1', { workspace, repos });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });
    sessionId = session.id;
  }

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId,
      messageId: 'm1',
      workingDir: worktree,
      extra: { sessionManager, projectStore, sessionId, sshKeyStore },
      ...overrides,
    };
  }

  it('worktreeRepoPath: запись реестра находится по пути репозитория, SSH-ключ отдаётся', async () => {
    const key = await sshKeyStore.create({ name: 'k-wt', privateKey: PRIVATE_KEY });
    await seedProject([{ path: 'repo', sshKeyId: key.id }]);

    // `cwd` — каталог worktree (вне `project.workspace`), сопоставление идёт
    // по `worktreeRepoPath`.
    const ctx = makeCtx({ worktreeId: 'wkt_test', worktreeRepoPath: 'repo' });

    const lookup = await resolveProjectRepoEntry(ctx, worktree);
    expect(lookup.kind).toBe('entry');

    const result = await resolveRepoGitEnv(ctx, worktree);
    expect(result.error).toBeUndefined();
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets?.[0]?.kind).toBe('ssh-key');
    expect(result.secrets?.[0]?.privateKey).toBe(PRIVATE_KEY);
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('worktreeRepoPath "." — репозиторий в корне workspace', async () => {
    const key = await sshKeyStore.create({ name: 'k-root', privateKey: PRIVATE_KEY });
    await seedProject([{ path: '.', sshKeyId: key.id }]);

    const ctx = makeCtx({ worktreeId: 'wkt_test', worktreeRepoPath: '.' });

    const lookup = await resolveProjectRepoEntry(ctx, worktree);
    expect(lookup.kind).toBe('entry');

    const result = await resolveRepoGitEnv(ctx, worktree);
    expect(result.secrets?.[0]?.privateKey).toBe(PRIVATE_KEY);
    await result.cleanup();
  });

  it('незарегистрированный worktreeRepoPath → not_registered (секретов нет)', async () => {
    const key = await sshKeyStore.create({ name: 'k-miss', privateKey: PRIVATE_KEY });
    await seedProject([{ path: 'repo', sshKeyId: key.id }]);

    const ctx = makeCtx({ worktreeId: 'wkt_test', worktreeRepoPath: 'other-repo' });

    const lookup = await resolveProjectRepoEntry(ctx, worktree);
    expect(lookup.kind).toBe('not_registered');

    const result = await resolveRepoGitEnv(ctx, worktree);
    expect(result.secrets).toBeUndefined();
    expect(result.error).toBeUndefined();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('без worktreeRepoPath — прежний поиск по cwd (регресс не введён)', async () => {
    const key = await sshKeyStore.create({ name: 'k-plain', privateKey: PRIVATE_KEY });
    await seedProject([{ path: 'repo', sshKeyId: key.id }]);

    // cwd внутри workspace — запись находится, как и прежде (ADR-076).
    const inside = await resolveProjectRepoEntry(makeCtx(), join(workspace, 'repo'));
    expect(inside.kind).toBe('entry');
    const insideEnv = await resolveRepoGitEnv(makeCtx(), join(workspace, 'repo'));
    expect(insideEnv.secrets?.[0]?.privateKey).toBe(PRIVATE_KEY);
    await insideEnv.cleanup();

    // cwd вне workspace (каталог worktree) — записи нет: без `worktreeRepoPath`
    // поиск идёт по относительному пути от корня workspace.
    const outside = await resolveProjectRepoEntry(makeCtx(), worktree);
    expect(outside.kind).toBe('not_registered');
    const outsideEnv = await resolveRepoGitEnv(makeCtx(), worktree);
    expect(outsideEnv.secrets).toBeUndefined();
    expect(outsideEnv.error).toBeUndefined();
    await outsideEnv.cleanup();
  });
});
