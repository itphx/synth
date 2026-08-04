import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { getProjectInfoTool, listReposTool } from './project-context.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { ToolContext } from '@synth/shared';

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

  async function initGitRepo(dir: string): Promise<void> {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await writeFile(join(dir, 'README.md'), '# Test\n');
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  }

  it('get_project_info: возвращает имя и путь рабочего каталога', async () => {
    const result = await getProjectInfoTool.execute({}, makeCtx());
    expect(result.content).toContain(`# Проект: ${basename(tmpDir)}`);
    expect(result.content).toContain(`- Путь: ${tmpDir}`);
  });

  it('get_project_info: определяет git-репозиторий в рабочем каталоге', async () => {
    await initGitRepo(tmpDir);
    const result = await getProjectInfoTool.execute({}, makeCtx());
    expect(result.content).toContain('Git-репозиторий');
    expect(result.content).toContain('- Ветка:');
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

    expect(result.content).toContain('# Проект: TestProject');
    expect(result.content).toContain(`- ID: ${project.id}`);
    expect(result.content).toContain(`- Рабочий каталог проекта: ${tmpDir}`);
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

    expect(result.content).toContain('# Проект: WsProject');
    expect(result.content).toContain(`- Рабочий каталог проекта: ${wsDir}`);
    expect(result.content).toContain('Git-репозиторий');
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
    expect(result.content).toContain('# Git-репозитории');
    expect(result.content).toContain(tmpDir);
    expect(result.content).toContain(sub);
    expect(result.content).toContain('- Ветка:');
  });

  it('list_repos: возвращает сообщение, если репозитории не найдены', async () => {
    const result = await listReposTool.execute({}, makeCtx());
    expect(result.content).toContain('не найдены');
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

    expect(result.content).toContain('# Репозитории проекта TestProject:');
    expect(result.content).toContain('- Ветка:');
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

    expect(result.content).toContain(`# Git-репозитории в ${wsDir}:`);
    expect(result.content).toContain(wsDir);
    expect(result.content).toContain('- Ветка:');
    expect(result.metadata?.projectWorkspace).toBe(wsDir);
  });
});
