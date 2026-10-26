import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { resolveRepoGitEnv } from './git-ssh.js';
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
const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\ncontrol-plane-must-not-materialize\n-----END OPENSSH PRIVATE KEY-----\n';
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
