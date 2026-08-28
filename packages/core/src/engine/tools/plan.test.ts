import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEnterTool, planExitTool, planReadTool, planListTool, planWriteTool, renderPlanMarkdown } from './plan.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('renderPlanMarkdown', () => {
  it('рендерит колонки и пункты', () => {
    const md = renderPlanMarkdown({
      version: 1,
      updatedAt: 'now',
      columns: [
        { id: 'backlog', name: 'Бэклог', order: 0 },
        { id: 'done', name: 'Готово', order: 3 },
      ],
      items: [
        { id: 'a', title: 'Шаг 1', columnId: 'backlog', priority: 'high', order: 0, dependsOn: [], createdAt: 't', updatedAt: 't' },
        { id: 'b', title: 'Шаг 2', columnId: 'backlog', priority: 'medium', order: 1, dependsOn: [{ itemId: 'a', relation: 'blocked_by' }], createdAt: 't', updatedAt: 't' },
      ],
    });
    expect(md).toContain('## Бэклог');
    expect(md).toContain('[high] Шаг 1');
    expect(md).toContain('[medium] Шаг 2');
    expect(md).toContain('blocked_by: a');
    expect(md).toContain('## Готово');
  });
});

describe('plan_enter / plan_exit', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let tmpDir: string;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-tool-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('Proj', 'u1');
    projectId = project.id;
    await projectStore.save(project);

    const session = await sessionManager.createSession({ title: 'Plan test' });
    sessionId = session.id;
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
      extra: { sessionManager, eventBus, sessionId, projectStore },
    };
  }

  it('plan_enter переводит сессию в mode=plan', async () => {
    const result = await planEnterTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.mode).toBe('plan');
  });

  it('plan_exit переводит в act, ставит planApproved и НЕ пишет файл', async () => {
    const result = await planExitTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.mode).toBe('act');
    expect(session.planApproved).toBe(true);

    // план больше не пишется в .synth/plans/
    expect(await exists(join(tmpDir, '.synth', 'plans'))).toBe(false);
  });

  it('plan_exit не принимает plan/path-параметры', () => {
    const exitShape = (planExitTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(exitShape)).toEqual([]);
  });

  it('plan_exit без sessionManager — ошибка', async () => {
    const ctx = makeCtx();
    delete ctx.extra;
    const result = await planExitTool.execute({}, ctx);
    expect(result.isError).toBe(true);
  });

  it('plan_exit публикует событие plan.approved', async () => {
    let approved: Record<string, unknown> | undefined;
    eventBus.subscribe(sessionId, (e) => {
      if (e.type === 'plan.approved') approved = e.data as Record<string, unknown>;
    });
    await planExitTool.execute({}, makeCtx());
    expect(approved).toBeTruthy();
    expect(approved?.session_id).toBe(sessionId);
    expect(approved?.project_id).toBe(projectId);
  });
});

describe('plan_read / plan_list / plan_write', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let tmpDir: string;
  let sessionId: string;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-rw-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('Proj', 'u1');
    projectId = project.id;
    await projectStore.save(project);

    const session = await sessionManager.createSession({ title: 'Plan rw' });
    sessionId = session.id;
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
      extra: { sessionManager, eventBus, sessionId, projectStore },
    };
  }

  it('plan_read без проекта — заглушка', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = undefined;
      await sessionManager.saveSession(s);
    });
    const result = await planReadTool.execute({}, makeCtx());
    expect(result.content).toContain('No project');
  });

  it('plan_write create_item / move_item / delete_item', async () => {
    // create_item (defaults: backlog, medium, order=0)
    const created = await planWriteTool.execute({ action: 'create_item', title: 'Шаг 1' }, makeCtx());
    expect(created.isError).toBeUndefined();

    let project = (await projectStore.load(projectId))!;
    expect(project.plan?.items).toHaveLength(1);
    const item = project.plan!.items[0]!;
    expect(item.title).toBe('Шаг 1');
    expect(item.columnId).toBe('backlog');
    expect(item.priority).toBe('medium');
    expect(item.order).toBe(0);

    // move_item
    const moved = await planWriteTool.execute(
      { action: 'move_item', itemId: item.id, columnId: 'in_progress' },
      makeCtx(),
    );
    expect(moved.isError).toBeUndefined();
    project = (await projectStore.load(projectId))!;
    expect(project.plan!.items[0]!.columnId).toBe('in_progress');

    // delete_item
    const deleted = await planWriteTool.execute({ action: 'delete_item', itemId: item.id }, makeCtx());
    expect(deleted.isError).toBeUndefined();
    project = (await projectStore.load(projectId))!;
    expect(project.plan!.items).toHaveLength(0);
  });

  it('plan_write create_item в несуществующую колонку — ошибка', async () => {
    const result = await planWriteTool.execute(
      { action: 'create_item', title: 'x', columnId: 'nope' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('column');
  });

  it('plan_write update_item меняет поля', async () => {
    await planWriteTool.execute({ action: 'create_item', title: 'Шаг 1' }, makeCtx());
    let project = (await projectStore.load(projectId))!;
    const id = project.plan!.items[0]!.id;

    const updated = await planWriteTool.execute(
      { action: 'update_item', itemId: id, title: 'Шаг 1 (обновлён)', priority: 'high', tags: ['auth'] },
      makeCtx(),
    );
    expect(updated.isError).toBeUndefined();
    project = (await projectStore.load(projectId))!;
    expect(project.plan!.items[0]!.title).toBe('Шаг 1 (обновлён)');
    expect(project.plan!.items[0]!.priority).toBe('high');
    expect(project.plan!.items[0]!.tags).toEqual(['auth']);
  });

  it('plan_list возвращает структурированный JSON', async () => {
    await planWriteTool.execute({ action: 'create_item', title: 'Шаг 1' }, makeCtx());
    const result = await planListTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { columns: unknown[]; items: unknown[] };
    expect(parsed.columns.length).toBe(4);
    expect(parsed.items.length).toBe(1);
  });

  it('plan_read возвращает markdown с пунктами', async () => {
    await planWriteTool.execute({ action: 'create_item', title: 'Шаг 1', priority: 'high' }, makeCtx());
    const result = await planReadTool.execute({}, makeCtx());
    expect(result.content).toContain('Шаг 1');
    expect(result.content).toContain('[high]');
  });

  it('plan_write без проекта — ошибка', async () => {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = undefined;
      await sessionManager.saveSession(s);
    });
    const result = await planWriteTool.execute({ action: 'create_item', title: 'x' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('project');
  });
});
