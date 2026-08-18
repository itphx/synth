import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import type { ContextBuilder } from './context/builder.js';
import type { Session } from '@itphx/shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
  } as unknown as ContextBuilder;
}

describe('ChatOrchestrator._resolveWorkingDir', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(opts?: { workspacesRoot?: string; defaultWorkingDir?: string }) {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      dataDir: tmpDir,
      projectStore,
      defaultWorkingDir: opts?.defaultWorkingDir ?? join(tmpDir, 'workspaces', 'default'),
      workspacesRoot: opts?.workspacesRoot,
    });
  }

  async function resolveDir(orch: ChatOrchestrator, session: Session): Promise<string> {
    return (orch as unknown as { _resolveWorkingDir(s: Session): Promise<string> })._resolveWorkingDir(session);
  }

  it('относительный workspace резолвится относительно workspacesRoot', async () => {
    const wsRoot = join(tmpDir, 'ws-root');
    await mkdir(wsRoot, { recursive: true });
    const project = projectStore.create('P1', 'u1', { workspace: 'WS1' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const orch = makeOrchestrator({ workspacesRoot: wsRoot });
    await expect(resolveDir(orch, session)).resolves.toBe(resolve(wsRoot, 'WS1'));
  });

  it('относительный workspace с ведущими ./ очищается и резолвится', async () => {
    const wsRoot = join(tmpDir, 'ws-root');
    await mkdir(wsRoot, { recursive: true });
    const project = projectStore.create('P2', 'u1', { workspace: './WS2/' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const orch = makeOrchestrator({ workspacesRoot: wsRoot });
    await expect(resolveDir(orch, session)).resolves.toBe(resolve(wsRoot, 'WS2'));
  });

  it('абсолютный workspace возвращается как есть (normalize)', async () => {
    const absWs = join(tmpDir, 'abs-ws');
    await mkdir(absWs, { recursive: true });
    const project = projectStore.create('P3', 'u1', { workspace: absWs });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const orch = makeOrchestrator({ workspacesRoot: join(tmpDir, 'other-root') });
    await expect(resolveDir(orch, session)).resolves.toBe(absWs);
  });

  it('без проекта/workspace возвращает defaultWorkingDir', async () => {
    const def = join(tmpDir, 'def-ws');
    const session = await sessionManager.createSession({ title: 'S' });

    const orch = makeOrchestrator({ defaultWorkingDir: def });
    await expect(resolveDir(orch, session)).resolves.toBe(def);
  });

  it('fallback workspacesRoot: join(dataDir, "workspaces") при отсутствии опции', async () => {
    const project = projectStore.create('P4', 'u1', { workspace: 'WS1' });
    await projectStore.save(project);
    const session = await sessionManager.createSession({ projectId: project.id, title: 'S' });

    const orch = makeOrchestrator();
    await expect(resolveDir(orch, session)).resolves.toBe(join(tmpDir, 'workspaces', 'WS1'));
  });
});
