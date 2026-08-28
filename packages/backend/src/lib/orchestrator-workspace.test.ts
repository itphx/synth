import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatOrchestrator, SessionManager, EventBus, FileStore, createToolRegistry } from '@itphx/synth-core';
import type { ContextBuilder } from '@itphx/synth-core';
import type { ToolContext, Session } from '@itphx/synth-shared';
import { ProjectStore } from '../storage/project-store.js';

/**
 * Регрессионный тест: ChatOrchestrator в backend main.ts создаётся с projectStore.
 * Без него сессия с projectId (workspace='WS1') получает defaultWorkingDir вместо
 * resolve(workspacesRoot, 'WS1'), а get_project_info показывает «Проект: default».
 */
describe('ChatOrchestrator workspace (backend main.ts сценарий)', () => {
  let tmpDir: string;
  let wsRoot: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-ws-'));
    wsRoot = join(tmpDir, 'workspaces');
    await mkdir(join(wsRoot, 'default'), { recursive: true });
    await mkdir(join(wsRoot, 'WS1'), { recursive: true });
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtxBuilder(): ContextBuilder {
    return {
      buildSystemPrompt: async () => 'system prompt',
    } as unknown as ContextBuilder;
  }

  // Оркестратор инстанцируется так же, как в packages/backend/src/main.ts
  // (projectStore передаётся, workspacesRoot = {dataDir}/workspaces).
  function makeOrchestrator() {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      dataDir: tmpDir,
      projectStore,
      workspacesRoot: wsRoot,
      defaultWorkingDir: join(wsRoot, 'default'),
    });
  }

  async function resolveDir(orch: ChatOrchestrator, session: Session): Promise<string> {
    return (orch as unknown as { _resolveWorkingDir(s: Session): Promise<string> })._resolveWorkingDir(session);
  }

  it('сессия с projectId (workspace=WS1, относительный) получает workingDir = resolve(workspacesRoot, "WS1")', async () => {
    const project = projectStore.create('Тестовый проект', 'admin', { workspace: 'WS1' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const orch = makeOrchestrator();
    await expect(resolveDir(orch, session)).resolves.toBe(resolve(wsRoot, 'WS1'));
  });

  it('без проекта/workspace возвращается defaultWorkingDir', async () => {
    const session = await sessionManager.createSession({ title: 'S' });

    const orch = makeOrchestrator();
    await expect(resolveDir(orch, session)).resolves.toBe(join(wsRoot, 'default'));
  });

  it('get_project_info показывает имя проекта и путь WS1 при переданном projectStore', async () => {
    const project = projectStore.create('Тестовый проект', 'admin', { workspace: 'WS1' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const registry = createToolRegistry();
    const tool = registry.get('get_project_info');
    expect(tool).toBeDefined();

    const ctx: ToolContext = {
      sessionId: session.id,
      messageId: 'm1',
      workingDir: join(wsRoot, 'default'),
      extra: { sessionManager, projectStore, sessionId: session.id, workspacesRoot: wsRoot },
    };

    const result = await tool!.execute({}, ctx);
    expect(result.content).toContain('# Project: Тестовый проект');
    expect(result.content).toContain(`- ID: ${project.id}`);
    expect(result.content).toContain(`- Project working directory: ${resolve(wsRoot, 'WS1')}`);
    expect(result.metadata?.projectWorkspace).toBe(resolve(wsRoot, 'WS1'));
  });
});
