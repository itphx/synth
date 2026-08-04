import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { todoWriteTool } from './todo.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import type { ToolContext, TodoItem } from '@synth/shared';
import { generateId } from '@synth/shared';

describe('todo_write', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-tool-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
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
});
