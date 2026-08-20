import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCreateTool, projectAttachTool } from './project-manage.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

describe('project_create / project_attach', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-manage-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    // createSession не проставляет ownerId — задаём явно, как это делает app.ts
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, projectStore, sessionId, eventBus },
    };
  }

  it('project_create создаёт проект и привязывает сессию', async () => {
    const result = await projectCreateTool.execute({ name: 'My Project' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBeTruthy();
    const project = (await projectStore.load(session.projectId!))!;
    expect(project.name).toBe('My Project');
    expect(project.ownerId).toBe('u1');
  });

  it('project_create возвращает id/name/workspace и публикует session.moved', async () => {
    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    const result = await projectCreateTool.execute({ name: 'P', workspace: '/tmp/ws' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.name).toBe('P');
    expect(result.metadata?.workspace).toBe('/tmp/ws');
    expect(result.metadata?.id).toBeTruthy();

    expect(moved).toBeTruthy();
    expect(moved?.session_id).toBe(sessionId);
    expect(moved?.project_id).toBe(result.metadata?.id);
  });

  it('project_create без projectStore — ошибка', async () => {
    const ctx = makeCtx();
    delete (ctx.extra as Record<string, unknown>).projectStore;
    const result = await projectCreateTool.execute({ name: 'X' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('project_attach привязывает сессию к существующему проекту и сбрасывает planApproved', async () => {
    const project = projectStore.create('Existing', 'u1');
    await projectStore.save(project);

    // предварительно ставим planApproved, чтобы проверить сброс
    await sessionManager.withLock(sessionId, async (s) => {
      s.planApproved = true;
      await sessionManager.saveSession(s);
    });

    const result = await projectAttachTool.execute({ projectId: project.id }, makeCtx());
    expect(result.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.projectId).toBe(project.id);
    expect(session.planApproved).toBe(false);
  });

  it('project_attach к несуществующему проекту — ошибка', async () => {
    const result = await projectAttachTool.execute({ projectId: 'missing' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('не найден');
  });

  it('project_attach публикует session.moved', async () => {
    const project = projectStore.create('Target', 'u1');
    await projectStore.save(project);

    let moved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
    });

    await projectAttachTool.execute({ projectId: project.id }, makeCtx());
    expect(moved).toBeTruthy();
    expect(moved?.project_id).toBe(project.id);
  });
});
