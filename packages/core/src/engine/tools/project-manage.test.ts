import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCreateTool, projectAttachTool, projectLogWriteTool, projectLogReadTool, projectInvariantsReadTool, projectInvariantsWriteTool } from './project-manage.js';
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

describe('project_log / project_invariants', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-log-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const session = await sessionManager.createSession({ title: 'No project' });
    sessionId = session.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.ownerId = 'u1';
      await sessionManager.saveSession(s);
    });

    // привязываем сессию к проекту
    const project = projectStore.create('Log Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = projectId;
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

  it('project_log_write добавляет запись в project.log', async () => {
    const result = await projectLogWriteTool.execute({ text: 'Сделал X' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const project = (await projectStore.load(projectId))!;
    expect(project.log).toHaveLength(1);
    const log = project.log!;
    const entry = log[0]!;
    expect(entry.text).toBe('Сделал X');
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
    expect(entry.sessionId).toBe(sessionId);
  });

  it('project_log_write без проекта — ошибка', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = undefined;
      await sessionManager.saveSession(s);
    });

    const result = await projectLogWriteTool.execute({ text: 'X' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Проект отсутствует');
  });

  it('project_log_read рендерит markdown', async () => {
    await projectLogWriteTool.execute({ text: 'Запись 1' }, makeCtx());
    await projectLogWriteTool.execute({ text: 'Запись 2' }, makeCtx());

    const result = await projectLogReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Лог проекта (2)');
    expect(result.content).toContain('— Запись 1');
    expect(result.content).toContain('— Запись 2');
  });

  it('project_log_read пустой лог → «Лог пуст»', async () => {
    const result = await projectLogReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Лог пуст');
  });

  it('project_invariants_read возвращает инварианты', async () => {
    await projectInvariantsWriteTool.execute({ invariants: 'Не коммитить без тестов' }, makeCtx());

    const result = await projectInvariantsReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Не коммитить без тестов');
  });

  it('project_invariants_read пустые → «Инварианты не заданы»', async () => {
    const result = await projectInvariantsReadTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Инварианты не заданы');
  });

  it('project_invariants_write устанавливает project.invariants', async () => {
    const result = await projectInvariantsWriteTool.execute({ invariants: 'Правило 1' }, makeCtx());
    expect(result.isError).toBeUndefined();

    const project = (await projectStore.load(projectId))!;
    expect(project.invariants).toBe('Правило 1');
  });
});
