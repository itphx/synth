import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { todoWriteTool } from './todo.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext, TodoItem } from '@itphx/shared';
import { generateId } from '@itphx/shared';

describe('todo_write', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-tool-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    const session = await sessionManager.createSession({ title: 'Todo test' });
    sessionId = session.id;
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
      extra: { sessionManager, sessionId },
    };
  }

  const todos: TodoItem[] = [
    { content: 'Найти первопричину', status: 'in_progress', priority: 'high' },
    { content: 'Написать тест', status: 'pending', priority: 'medium' },
  ];

  it('сохраняет todo-список в состояние сессии и возвращает JSON', async () => {
    const result = await todoWriteTool.execute({ todos }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual(todos);

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos).toEqual(todos);
  });

  it('заменяет предыдущий список', async () => {
    await todoWriteTool.execute({ todos }, makeCtx());
    const updated: TodoItem[] = [{ content: 'Единственная задача', status: 'completed', priority: 'low' }];
    const result = await todoWriteTool.execute({ todos: updated }, makeCtx());
    expect(JSON.parse(result.content)).toEqual(updated);
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos).toEqual(updated);
  });

  it('невалидный status/priority — ошибка валидации', async () => {
    const result = await todoWriteTool.execute(
      { todos: [{ content: 'x', status: 'wrong', priority: 'high' }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  it('без sessionManager — ошибка', async () => {
    const ctx = makeCtx();
    delete ctx.extra;
    const result = await todoWriteTool.execute({ todos }, ctx);
    expect(result.isError).toBe(true);
  });

  it('не принимает path/cwd-параметры от агента', () => {
    const shape = (todoWriteTool.parameters as { shape?: Record<string, unknown> }).shape ?? {};
    expect(Object.keys(shape)).toEqual(['todos']);
  });

  it('публикует событие todos.updated с session_id и todos', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));

    const ctx = makeCtx();
    ctx.extra = { ...ctx.extra, eventBus };
    await todoWriteTool.execute({ todos }, ctx);

    const updated = events.find((e) => e.type === 'todos.updated');
    expect(updated).toBeDefined();
    expect(updated!.data.session_id).toBe(sessionId);
    expect(updated!.data.todos).toEqual(todos);
    unsub();
  });

  it('без eventBus — событие не публикуется, тул не падает', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));

    const result = await todoWriteTool.execute({ todos }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(events.some((e) => e.type === 'todos.updated')).toBe(false);
    unsub();
  });
});
