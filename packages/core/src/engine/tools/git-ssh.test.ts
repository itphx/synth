import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { resolveRepoGitEnv } from './git-ssh.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SSHKeyStore } from '../../storage/ssh-key-store.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-material\n-----END OPENSSH PRIVATE KEY-----\n';

describe('resolveRepoGitEnv (AD-076 §T6)', () => {
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

  it('репо-запись с sshKeyId → GIT_SSH_COMMAND с временным ключом; cleanup удаляет файл', async () => {
    const key = await sshKeyStore.create({ name: 'k1', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: key.id }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.error).toBeUndefined();
    expect(result.env?.GIT_SSH_COMMAND).toContain('ssh -i');

    const keyPath = /ssh -i (\S+)/.exec(result.env!.GIT_SSH_COMMAND!)?.[1];
    expect(keyPath).toBeTruthy();
    await expect(access(keyPath!)).resolves.toBeUndefined();

    await result.cleanup();
    await expect(access(keyPath!)).rejects.toBeTruthy();
    // cleanup идемпотентен
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('запись без sshKeyId → env пуст (ambient ssh)', async () => {
    const sessionId = await seedProject([{ path: 'repo' }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.env).toBeUndefined();
    expect(result.error).toBeUndefined();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('несуществующий ключ → sshkey.not_found', async () => {
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: 'missing' }]);
    const cwd = join(tmpDir, 'repo');

    const result = await resolveRepoGitEnv(makeCtx(sessionId), cwd);
    expect(result.error).toBe('sshkey.not_found');
    expect(result.errorParams).toEqual({ id: 'missing' });
  });

  it('корень workspace (path ".") сопоставляется с cwd проекта', async () => {
    const key = await sshKeyStore.create({ name: 'root-key', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: '.', sshKeyId: key.id }]);

    const result = await resolveRepoGitEnv(makeCtx(sessionId), tmpDir);
    expect(result.error).toBeUndefined();
    expect(result.env?.GIT_SSH_COMMAND).toContain('ssh -i');
    await result.cleanup();
  });

  it('cwd вне записи реестра → env пуст', async () => {
    const key = await sshKeyStore.create({ name: 'k2', privateKey: PRIVATE_KEY });
    const sessionId = await seedProject([{ path: 'repo', sshKeyId: key.id }]);
    const other = join(tmpDir, 'other');
    await rm(other, { recursive: true, force: true });

    const result = await resolveRepoGitEnv(makeCtx(sessionId), join(tmpDir, 'other'));
    expect(result.env).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('без sshKeyStore в extra → env пуст (нет доступа к ключам)', async () => {
    const ctx: ToolContext = {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: {},
    };
    const result = await resolveRepoGitEnv(ctx, tmpDir);
    expect(result.env).toBeUndefined();
  });
});
