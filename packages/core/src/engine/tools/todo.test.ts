import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  todoWriteTool,
  todoListTool,
  todoAddTool,
  todoUpdateTool,
  todoDeleteTool,
} from './todo.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

interface TodoInput {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  planItemId?: string;
}

function stripId<T extends { id?: string }>(t: T): Omit<T, 'id'> {
  const { id, ...rest } = t;
  void id;
  return rest;
}

describe('todo tools', () => {
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

  function makeCtx(extra?: Record<string, unknown>): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, sessionId, ...(extra ?? {}) },
    };
  }

  const todos: TodoInput[] = [
    { content: 'Найти первопричину', status: 'in_progress', priority: 'high' },
    { content: 'Написать тест', status: 'pending', priority: 'medium' },
  ];

  describe('todo_write', () => {
    it('сохраняет список, генерирует id и возвращает JSON', async () => {
      const result = await todoWriteTool.execute({ todos }, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as Array<{ id?: string }>;
      expect(parsed.map(stripId)).toEqual(todos.map(stripId));
      expect(parsed.every((t) => typeof t.id === 'string' && t.id.length > 0)).toBe(true);

      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos!.map(stripId)).toEqual(todos.map(stripId));
      expect(session.todos!.every((t) => t.id.length > 0)).toBe(true);
    });

    it('сохраняет переданные id как есть', async () => {
      const withIds = todos.map((t) => ({ ...t, id: `fixed-${t.content}` }));
      await todoWriteTool.execute({ todos: withIds }, makeCtx());
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos!.map((t) => t.id)).toEqual([
        'fixed-Найти первопричину',
        'fixed-Написать тест',
      ]);
    });

    it('заменяет предыдущий список', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const updated: TodoInput[] = [{ content: 'Единственная задача', status: 'completed', priority: 'low' }];
      await todoWriteTool.execute({ todos: updated }, makeCtx());
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos!.map(stripId)).toEqual(updated.map(stripId));
    });

    it('невалидный status — ошибка валидации', async () => {
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

    it('публикует событие todos.updated', async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const unsub = eventBus.subscribe(sessionId, (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));

      await todoWriteTool.execute({ todos }, makeCtx({ eventBus }));

      const updated = events.find((e) => e.type === 'todos.updated');
      expect(updated).toBeDefined();
      expect(updated!.data.session_id).toBe(sessionId);
      expect((updated!.data.todos as TodoInput[]).map(stripId)).toEqual(todos.map(stripId));
      unsub();
    });

    it('без eventBus — тул не падает', async () => {
      const result = await todoWriteTool.execute({ todos }, makeCtx());
      expect(result.isError).toBeUndefined();
    });
  });

  describe('todo_add', () => {
    it('добавляет один пункт с дефолтными status/priority', async () => {
      const result = await todoAddTool.execute({ todos: { content: 'Новая задача' } }, makeCtx());
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as TodoInput[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.content).toBe('Новая задача');
      expect(parsed[0]!.status).toBe('pending');
      expect(parsed[0]!.priority).toBe('medium');
      expect(parsed[0]!.id).toBeTruthy();
    });

    it('добавляет несколько пунктов к существующим', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const result = await todoAddTool.execute(
        {
          todos: [
            { content: 'A', status: 'in_progress', priority: 'high' },
            { content: 'B' },
          ],
        },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos).toHaveLength(4);
      expect(session.todos![2]!.content).toBe('A');
      expect(session.todos![2]!.status).toBe('in_progress');
      expect(session.todos![3]!.content).toBe('B');
      expect(session.todos![3]!.status).toBe('pending');
    });

    it('принимает planItemId', async () => {
      await todoAddTool.execute(
        { todos: { content: 'Связанная задача', planItemId: 'plan-1' } },
        makeCtx(),
      );
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos![0]!.planItemId).toBe('plan-1');
    });
  });

  describe('todo_list', () => {
    it('возвращает отформатированный текст', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const result = await todoListTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Найти первопричину');
      expect(result.content).toContain('in progress');
      expect(result.content).toContain('high');
    });

    it('пустой список', async () => {
      const result = await todoListTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Todo list is empty');
    });
  });

  describe('todo_update', () => {
    it('обновляет пункт по id', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const before = (await sessionManager.getSession(sessionId))!;
      const targetId = before.todos![0]!.id;

      const result = await todoUpdateTool.execute(
        { id: targetId, status: 'completed', content: 'Обновлено' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();

      const after = (await sessionManager.getSession(sessionId))!;
      expect(after.todos![0]!.id).toBe(targetId);
      expect(after.todos![0]!.status).toBe('completed');
      expect(after.todos![0]!.content).toBe('Обновлено');
    });

    it('несуществующий id — ошибка', async () => {
      const result = await todoUpdateTool.execute({ id: 'missing', content: 'x' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  describe('todo_delete', () => {
    it('удаляет по одному id', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const before = (await sessionManager.getSession(sessionId))!;
      const targetId = before.todos![0]!.id;

      const result = await todoDeleteTool.execute({ ids: targetId }, makeCtx());
      expect(result.isError).toBeUndefined();

      const after = (await sessionManager.getSession(sessionId))!;
      expect(after.todos).toHaveLength(1);
      expect(after.todos![0]!.content).toBe('Написать тест');
    });

    it('удаляет по массиву ids', async () => {
      await todoWriteTool.execute({ todos }, makeCtx());
      const before = (await sessionManager.getSession(sessionId))!;
      const ids = before.todos!.map((t) => t.id);

      await todoDeleteTool.execute({ ids }, makeCtx());

      const after = (await sessionManager.getSession(sessionId))!;
      expect(after.todos).toHaveLength(0);
    });

    it('несуществующий id — ошибка', async () => {
      const result = await todoDeleteTool.execute({ ids: 'missing' }, makeCtx());
      expect(result.isError).toBe(true);
    });
  });
});
