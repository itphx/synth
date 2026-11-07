import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, MARKDOWN_LIMITS } from '@itphx/synth-shared';
import type { ToolContext } from '@itphx/synth-shared';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import { planWriteTool } from './plan.js';
import { todoReorderTool, todoClearTool } from './todo.js';
import { projectLogWriteTool, projectLogUpdateTool, projectLogDeleteTool } from './project-manage.js';
import { projectInvariantsWriteTool } from './project-manage.js';

/**
 * Новые операции инструментов плана/ToDo/журнала (PROP-054) и события,
 * которые они публикуют (инвариант 27 — мутация, видимая другому клиенту,
 * публикует событие).
 */
describe('Инструменты плана/ToDo/журнала (PROP-054)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-work-tools-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();

    const project = projectStore.create('Проект', 'u1');
    projectId = project.id;
    await projectStore.save(project);

    const session = await sessionManager.createSession({ title: 'Work', userId: 'u1' });
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
      extra: { sessionManager, projectStore, eventBus, sessionId },
    } as unknown as ToolContext;
  }

  it('plan_write: update_column / delete_column / reorder_columns', async () => {
    const added = await planWriteTool.execute({ action: 'add_column', name: 'Архив' }, makeCtx());
    expect(added.isError).toBeUndefined();
    const project = (await projectStore.load(projectId))!;
    const archive = project.plan!.columns.find((c) => c.name === 'Архив')!.id;

    const renamed = await planWriteTool.execute(
      { action: 'update_column', columnId: archive, name: 'Архив 2', wipLimit: 3 },
      makeCtx(),
    );
    expect(renamed.isError).toBeUndefined();
    const afterRename = (await projectStore.load(projectId))!.plan!;
    expect(afterRename.columns.find((c) => c.id === archive)!.name).toBe('Архив 2');
    expect(afterRename.columns.find((c) => c.id === archive)!.wipLimit).toBe(3);

    const reordered = await planWriteTool.execute(
      { action: 'reorder_columns', order: [archive, 'backlog'] },
      makeCtx(),
    );
    expect(reordered.isError).toBeUndefined();
    const afterReorder = (await projectStore.load(projectId))!.plan!;
    const sorted = [...afterReorder.columns].sort((a, b) => a.order - b.order);
    expect(sorted[0]!.id).toBe(archive);

    const deleted = await planWriteTool.execute(
      { action: 'delete_column', columnId: archive, moveItemsTo: 'backlog' },
      makeCtx(),
    );
    expect(deleted.isError).toBeUndefined();
    const afterDelete = (await projectStore.load(projectId))!.plan!;
    expect(afterDelete.columns.find((c) => c.id === archive)).toBeUndefined();
  });

  it('plan_write move_item принимает beforeItemId', async () => {
    await planWriteTool.execute({ action: 'create_item', title: 'A' }, makeCtx());
    await planWriteTool.execute({ action: 'create_item', title: 'B' }, makeCtx());
    const plan = (await projectStore.load(projectId))!.plan!;
    const a = plan.items.find((i) => i.title === 'A')!.id;
    const b = plan.items.find((i) => i.title === 'B')!.id;

    const moved = await planWriteTool.execute(
      { action: 'move_item', itemId: b, columnId: 'backlog', beforeItemId: a },
      makeCtx(),
    );
    expect(moved.isError).toBeUndefined();
    const after = (await projectStore.load(projectId))!.plan!;
    const items = after.items.filter((i) => i.columnId === 'backlog').sort((x, y) => x.order - y.order);
    expect(items.map((i) => i.id)).toEqual([b, a]);
  });

  it('plan_write публикует plan.updated с {project_id, version}', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });
    await planWriteTool.execute({ action: 'create_item', title: 'A' }, makeCtx());
    expect(events).toHaveLength(1);
    expect(events[0]!.project_id).toBe(projectId);
    expect(typeof events[0]!.version).toBe('number');
  });

  it('todo_reorder и todo_clear меняют список и публикуют todos.updated', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    await sessionManager.withLock(sessionId, async (s) => {
      s.todos = [
        { id: 'a', content: 'A', status: 'completed', priority: 'medium' },
        { id: 'b', content: 'B', status: 'pending', priority: 'medium' },
      ];
      await sessionManager.saveSession(s);
    });

    const reordered = await todoReorderTool.execute({ ids: ['b', 'a'] }, makeCtx());
    expect(reordered.isError).toBeUndefined();
    let todos = (await sessionManager.getSession(sessionId))!.todos!;
    expect(todos.map((t) => t.id)).toEqual(['b', 'a']);

    const cleared = await todoClearTool.execute({ statuses: ['completed'] }, makeCtx());
    expect(cleared.isError).toBeUndefined();
    todos = (await sessionManager.getSession(sessionId))!.todos!;
    expect(todos.map((t) => t.id)).toEqual(['b']);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('project_log_write/update/delete публикуют project.updated с kind=log', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    const written = await projectLogWriteTool.execute({ text: 'запись' }, makeCtx());
    expect(written.isError).toBeUndefined();
    const entryId = (written.metadata as { entry: { id: string } }).entry.id;

    const updated = await projectLogUpdateTool.execute({ entryId, text: 'правка' }, makeCtx());
    expect(updated.isError).toBeUndefined();
    expect((updated.metadata as { entry: { text: string } }).entry.text).toBe('правка');

    const deleted = await projectLogDeleteTool.execute({ entryId }, makeCtx());
    expect(deleted.isError).toBeUndefined();

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.project_id).toBe(projectId);
      expect(event.kind).toBe('log');
    }
  });

  it('project_log_write отклоняет текст длиннее лимита Markdown', async () => {
    const result = await projectLogWriteTool.execute(
      { text: 'x'.repeat(MARKDOWN_LIMITS.journalEntry + 1) },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  it('project_invariants_write отклоняет текст длиннее лимита и публикует событие', async () => {
    const events: Array<Record<string, unknown>> = [];
    eventBus.subscribe(sessionId, (e) => { events.push(e.data); });

    const tooLong = await projectInvariantsWriteTool.execute(
      { invariants: 'x'.repeat(MARKDOWN_LIMITS.invariants + 1) },
      makeCtx(),
    );
    expect(tooLong.isError).toBe(true);

    const ok = await projectInvariantsWriteTool.execute({ invariants: '# Правила' }, makeCtx());
    expect(ok.isError).toBeUndefined();
    expect((await projectStore.load(projectId))!.invariants).toBe('# Правила');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('invariants');
  });
});
