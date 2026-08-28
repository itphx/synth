import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectInfoTool, listReposTool } from './project-context.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { ToolContext } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';

const execFileAsync = promisify(execFile);

describe('project-context tools', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-test-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
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

  it('capability RUNTIME (группа runtime, а не file_read/git_read)', () => {
    expect(getProjectInfoTool.capabilities).toEqual([ToolCapability.RUNTIME]);
    expect(listReposTool.capabilities).toEqual([ToolCapability.RUNTIME]);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await writeFile(join(dir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  }

  it('get_project_info: без проекта возвращает честный статус и рабочий каталог', async () => {
    const result = await getProjectInfoTool.execute({}, makeCtx());
    expect(result.content).toContain('# Project: none');
    expect(result.content).toContain(`- Working directory: ${tmpDir}`);
    expect(result.content).toContain('The plan is unavailable');
  });

  it('get_project_info: проект указан, но не найден', async () => {
    const session = await sessionManager.createSession({ projectId: 'missing-id', title: 'S' });
    const result = await getProjectInfoTool.execute({}, makeCtx({
      sessionId: session.id,
      extra: { sessionManager, projectStore, sessionId: session.id },
    }));
    expect(result.content).toContain('# Project: not found (id: missing-id)');
    expect(result.content).toContain(`- Working directory: ${tmpDir}`);
  });

  it('get_project_info: определяет git-репозиторий в рабочем каталоге', async () => {
    await initGitRepo(tmpDir);
    const result = await getProjectInfoTool.execute({}, makeCtx());
    expect(result.content).toContain('Git repository');
    expect(result.content).toContain('- Branch:');
    expect(result.content).toContain('initial');
  });

  it('get_project_info: использует данные проекта при наличии ProjectStore и projectId в сессии', async () => {
    const project = projectStore.create('TestProject', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const result = await getProjectInfoTool.execute({}, makeCtx({
      sessionId: session.id,
      extra: { sessionManager, projectStore, sessionId: session.id },
    }));

    expect(result.content).toContain('# Project: TestProject');
    expect(result.content).toContain(`- ID: ${project.id}`);
    expect(result.content).toContain(`- Project working directory: ${tmpDir}`);
    expect(result.metadata?.projectWorkspace).toBe(tmpDir);
  });

  it('get_project_info: каталог проекта берётся из project.workspace, а не из рабочего каталога сессии', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'synth-project-ws-'));
    await initGitRepo(wsDir);
    const project = projectStore.create('WsProject', 'u1', { workspace: wsDir });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    // workingDir сессии сознательно отличается от project.workspace
    const result = await getProjectInfoTool.execute({}, makeCtx({
      sessionId: session.id,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId: session.id },
    }));

    expect(result.content).toContain('# Project: WsProject');
    expect(result.content).toContain(`- Project working directory: ${wsDir}`);
    expect(result.content).toContain('Git repository');
    expect(result.content).toContain(wsDir);
    expect(result.metadata?.workingDir).toBe(tmpDir);
    expect(result.metadata?.projectWorkspace).toBe(wsDir);
  });

  it('get_project_info: не принимает path/cwd-параметры от агента', () => {
    const shape = (getProjectInfoTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(shape)).toEqual([]);
  });

  it('list_repos: не принимает path/cwd-параметры от агента', () => {
    const shape = (listReposTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(shape)).toEqual([]);
  });

  it('list_repos: находит репозиторий в корне и во вложенной директории', async () => {
    await initGitRepo(tmpDir);
    const sub = join(tmpDir, 'subrepo');
    await mkdir(sub, { recursive: true });
    await initGitRepo(sub);

    const result = await listReposTool.execute({}, makeCtx());
    expect(result.content).toContain('# Git repositories');
    expect(result.content).toContain(tmpDir);
    expect(result.content).toContain(sub);
    expect(result.content).toContain('- Branch:');
  });

  it('list_repos: возвращает сообщение, если репозитории не найдены', async () => {
    const result = await listReposTool.execute({}, makeCtx());
    expect(result.content).toContain('No git repositories in');
  });

  it('list_repos: использует repos из проекта при наличии ProjectStore', async () => {
    await initGitRepo(tmpDir);
    const project = projectStore.create('TestProject', 'u1', { repos: [{ path: tmpDir }] });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const result = await listReposTool.execute({}, makeCtx({
      sessionId: session.id,
      extra: { sessionManager, projectStore, sessionId: session.id },
    }));

    expect(result.content).toContain('# Repositories of project TestProject:');
    expect(result.content).toContain('- Branch:');
  });

  it('get_project_info: относительный workspace резолвится относительно workspacesRoot', async () => {
    const wsRoot = join(tmpDir, 'ws-root');
    const wsDir = join(wsRoot, 'WS1');
    await mkdir(wsDir, { recursive: true });
    await initGitRepo(wsDir);
    const project = projectStore.create('RelProj', 'u1', { workspace: 'WS1' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const result = await getProjectInfoTool.execute({}, makeCtx({
      sessionId: session.id,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId: session.id, workspacesRoot: wsRoot },
    }));

    expect(result.content).toContain(`- Project working directory: ${wsDir}`);
    expect(result.content).toContain('Git repository');
    expect(result.metadata?.projectWorkspace).toBe(wsDir);
  });

  it('list_repos: относительный repo path резолвится относительно project.workspace', async () => {
    const wsRoot = join(tmpDir, 'ws-root');
    const wsDir = join(wsRoot, 'WS1');
    const subrepo = join(wsDir, 'trepo');
    await mkdir(subrepo, { recursive: true });
    await initGitRepo(subrepo);
    const project = projectStore.create('RelRepos', 'u1', {
      workspace: 'WS1',
      repos: [{ path: 'trepo' }],
    });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const result = await listReposTool.execute({}, makeCtx({
      sessionId: session.id,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId: session.id, workspacesRoot: wsRoot },
    }));

    expect(result.content).toContain('# Repositories of project RelRepos:');
    expect(result.content).toContain(subrepo);
    expect(result.content).toContain('- Branch:');
    expect(result.metadata?.projectWorkspace).toBe(wsDir);
  });

  it('list_repos: сканирует project.workspace, когда в проекте нет настроенных repos', async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'synth-project-ws-'));
    await initGitRepo(wsDir);
    const project = projectStore.create('WsProject', 'u1', { workspace: wsDir });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    // рабочая директория сессии пуста — репозиторий только в project.workspace
    const result = await listReposTool.execute({}, makeCtx({
      sessionId: session.id,
      extra: { sessionManager, projectStore, sessionId: session.id },
    }));

    expect(result.content).toContain(`# Git repositories in ${wsDir}:`);
    expect(result.content).toContain(wsDir);
    expect(result.content).toContain('- Branch:');
    expect(result.metadata?.projectWorkspace).toBe(wsDir);
  });
});
