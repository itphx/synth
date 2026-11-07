import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { executeToolDef } from './tool-execution.js';
import type { TodoItem, ToolContext } from '@itphx/synth-shared';
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
    it('сохраняет список, генерирует id и возвращает компактный вывод', async () => {
      const result = await todoWriteTool.execute({ todos }, makeCtx());
      expect(result.isError).toBeUndefined();

      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos!.map(stripId)).toEqual(todos.map(stripId));
      expect(session.todos!.every((t) => t.id.length > 0)).toBe(true);

      // Компактный вывод: сводка + строка на пункт (без JSON)
      expect(result.content).toContain('Todo list: 0/2 completed, 1 in progress.');
      expect(result.content).toContain('- [ ] ');
      expect(result.content).toContain('Найти первопричину');
      expect(result.content).toContain('in progress');
      // id пункта обязателен — по нему модель зовёт todo_update
      for (const t of session.todos!) {
        expect(result.content).toContain(t.id);
      }
      expect(result.content).not.toContain('{');
      expect(result.content).not.toContain('}');
      expect(result.content).not.toContain('"');
    });

    it('помечает выполненный пункт как [x]', async () => {
      await todoWriteTool.execute(
        { todos: [{ content: 'Готово', status: 'completed', priority: 'medium' }] },
        makeCtx(),
      );
      const result = await todoListTool.execute({}, makeCtx());
      expect(result.content).toContain('- [x] ');
      expect(result.content).toContain('Todo list: 1/1 completed, 0 in progress.');
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
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.todos).toHaveLength(1);
      expect(session.todos![0]!.content).toBe('Новая задача');
      expect(session.todos![0]!.status).toBe('pending');
      expect(session.todos![0]!.priority).toBe('medium');
      expect(session.todos![0]!.id).toBeTruthy();

      // Компактный вывод: id добавленного пункта + сводка (без JSON)
      expect(result.content).toContain('Todo items added:');
      expect(result.content).toContain(session.todos![0]!.id);
      expect(result.content).toContain('Todo list: 0/1 completed, 0 in progress.');
      expect(result.content).not.toContain('"');
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
      // Компактный вывод: без JSON-скобок и кавычек
      expect(result.content).not.toContain('{');
      expect(result.content).not.toContain('}');
      expect(result.content).not.toContain('"');
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

      // Короткая строка о результате + сводка (полного списка/JSON нет)
      expect(result.content).toContain(`Todo item ${targetId} updated.`);
      expect(result.content).toContain('Todo list: 1/2 completed, 0 in progress.');
      expect(result.content).not.toContain('"');
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

      // Короткая строка о результате + сводка (полного списка/JSON нет)
      expect(result.content).toContain('Todo items deleted: 1.');
      expect(result.content).toContain('Todo list: 0/1 completed, 0 in progress.');
      expect(result.content).not.toContain('"');
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

  describe('компактный вывод', () => {
    it('усекает список длиннее 30 пунктов', async () => {
      const many: TodoInput[] = Array.from({ length: 35 }, (_, i) => ({
        content: `Задача ${i + 1}`,
        status: 'pending',
        priority: 'medium',
      }));

      const result = await todoWriteTool.execute({ todos: many }, makeCtx());
      expect(result.isError).toBeUndefined();
      // Сводка считает по всему списку, строки — только первые 30
      expect(result.content).toContain('Todo list: 0/35 completed, 0 in progress.');
      expect(result.content).toContain('Задача 30');
      expect(result.content).not.toContain('Задача 31');
      expect(result.content).toContain('... and 5 more');
    });

    it('в пустой список пишет существующий текст «список пуст»', async () => {
      const result = await todoWriteTool.execute({ todos: [] }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Todo list is empty');
    });
  });
});

/**
 * Терпимость к типовым обёрткам слабых моделей (проверено на test: модель
 * присылала `{"todos":{"item":[{…}]}}`, получала `todos: Invalid input` и
 * повторяла тот же вызов 10 раз подряд). Нормализация идёт **до** валидации —
 * в `executeToolDef`, поэтому тесты идут через него, а не напрямую в `execute`.
 */
describe('todo tools — обёртки аргументов', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-wrapper-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    const session = await sessionManager.createSession({ title: 'Todo wrapper test' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: { sessionManager, sessionId },
    };
  }

  it('todo_add: {"todos":{"item":[{…},{…}]}} → добавляется 2 пункта', async () => {
    const result = await executeToolDef(
      todoAddTool,
      { todos: { item: [{ content: 'Первый' }, { content: 'Второй' }] } },
      ctx(),
      'todo_add',
    );

    expect(result.isError).toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos!.map((t) => t.content)).toEqual(['Первый', 'Второй']);
  });

  it('todo_add: {"todos":{"items":{…}}} → добавляется 1 пункт', async () => {
    const result = await executeToolDef(
      todoAddTool,
      { todos: { items: { content: 'Один' } } },
      ctx(),
      'todo_add',
    );

    expect(result.isError).toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos).toHaveLength(1);
    expect(session.todos![0]!.content).toBe('Один');
  });

  it('todo_add: валидные формы не меняются (одиночный объект и массив)', async () => {
    const single = await executeToolDef(
      todoAddTool,
      { todos: { content: 'Одиночный', status: 'in_progress' } },
      ctx(),
      'todo_add',
    );
    expect(single.isError).toBeUndefined();

    const many = await executeToolDef(
      todoAddTool,
      { todos: [{ content: 'A' }, { content: 'B' }] },
      ctx(),
      'todo_add',
    );
    expect(many.isError).toBeUndefined();

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos!.map((t) => t.content)).toEqual(['Одиночный', 'A', 'B']);
    expect(session.todos![0]!.status).toBe('in_progress');
  });

  it('todo_delete: {"ids":{"item":"id"}} и {"ids":{"ids":["a","b"]}} работают', async () => {
    await executeToolDef(
      todoAddTool,
      { todos: [{ content: 'A' }, { content: 'B' }, { content: 'C' }] },
      ctx(),
      'todo_add',
    );
    let session = (await sessionManager.getSession(sessionId))!;
    const [first, second, third] = session.todos!.map((t) => t.id);

    const one = await executeToolDef(
      todoDeleteTool,
      { ids: { item: first } },
      ctx(),
      'todo_delete',
    );
    expect(one.isError).toBeUndefined();

    const rest = await executeToolDef(
      todoDeleteTool,
      { ids: { ids: [second, third] } },
      ctx(),
      'todo_delete',
    );
    expect(rest.isError).toBeUndefined();

    session = (await sessionManager.getSession(sessionId))!;
    expect(session.todos).toHaveLength(0);
  });

  it('мусорная обёртка не разворачивается — ошибка объясняет варианты', async () => {
    const result = await executeToolDef(
      todoAddTool,
      { todos: { item: 'не пункт', extra: 1 } },
      ctx(),
      'todo_add',
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not match any variant');
    expect(result.content).toContain('variant 1:');
    expect(result.content).toContain('variant 2:');
  });
});

/**
 * Legacy-пункты без `id`: `todo_list` проставляет id **и сохраняет их** —
 * иначе id из ответа менялся бы при каждом вызове (новый `randomUUID`), и
 * `todo_update`/`todo_delete` по нему не находили бы пункт.
 */
describe('todo tools — ленивая миграция legacy-пунктов без id', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-legacy-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    const session = await sessionManager.createSession({ title: 'Todo legacy test' });
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

  /** Пункт старого формата: `id` нет вовсе (тип его требует — приводим). */
  function legacy(
    content: string,
    status: TodoItem['status'],
    priority: TodoItem['priority'],
  ): TodoItem {
    return { content, status, priority } as unknown as TodoItem;
  }

  async function seedLegacy(): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.todos = [
        legacy('Найти первопричину', 'in_progress', 'high'),
        legacy('Написать тест', 'completed', 'low'),
      ];
      await sessionManager.saveSession(s);
    });
  }

  it('сохраняет id: todo_update по id из ответа меняет пункт, повторный todo_list отдаёт тот же id', async () => {
    await seedLegacy();

    const first = await todoListTool.execute({}, makeCtx());
    expect(first.isError).toBeUndefined();
    const listed = first.metadata?.todos as TodoItem[];
    expect(listed).toHaveLength(2);
    expect(listed.every((t) => typeof t.id === 'string' && t.id.length > 0)).toBe(true);
    // Содержимое и статусы миграция не теряет.
    expect(listed.map((t) => t.content)).toEqual(['Найти первопричину', 'Написать тест']);
    expect(listed.map((t) => t.status)).toEqual(['in_progress', 'completed']);

    const targetId = listed[0]!.id;
    const updated = await todoUpdateTool.execute(
      { id: targetId, status: 'completed' },
      makeCtx(),
    );
    expect(updated.isError).toBeUndefined();

    const second = await todoListTool.execute({}, makeCtx());
    expect(second.isError).toBeUndefined();
    const relisted = second.metadata?.todos as TodoItem[];
    expect(relisted.map((t) => t.id)).toEqual(listed.map((t) => t.id));
    expect(relisted[0]!.id).toBe(targetId);
    expect(relisted[0]!.status).toBe('completed');
    expect(relisted[0]!.content).toBe('Найти первопричину');
  });

  it('идемпотентно: у списка с id запись не выполняется', async () => {
    await todoWriteTool.execute(
      { todos: [{ content: 'A', status: 'pending', priority: 'medium' }] },
      makeCtx(),
    );
    const save = vi.spyOn(sessionManager, 'saveSession');

    const result = await todoListTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('read-тул не публикует todos.updated (todoSessionId)', async () => {
    await seedLegacy();
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe(sessionId, (e) => events.push(e.type));

    const result = await todoListTool.execute({}, makeCtx({ eventBus }));
    expect(result.isError).toBeUndefined();
    expect(events).not.toContain('todos.updated');
  });
});

/**
 * ADR-039: у прогона саб-агента todo-тулы меняют список **ребёнка**
 * (`extra.todoSessionId`), а `extra.sessionId` остаётся родительским (события,
 * permission, проектный скоуп). Раньше тулы писали в родительский список.
 */
describe('todo tools — ownership через todoSessionId (саб-агент)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;
  let parentId: string;
  let childId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-ownership-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const child = await sessionManager.createSession({
      title: 'Child',
      parentId: parent.id,
      sessionOrigin: 'subagent',
    });
    parentId = parent.id;
    childId = child.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(over: { todoSessionId?: string } = {}): ToolContext {
    return {
      sessionId: parentId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        sessionId: parentId,
        eventBus,
        ...(over.todoSessionId !== undefined ? { todoSessionId: over.todoSessionId } : {}),
      },
    };
  }

  it('todo_write пишет в список ребёнка, родительский не меняется, событие — в канал ребёнка', async () => {
    const childEvents: Array<Record<string, unknown>> = [];
    const parentEvents: Array<Record<string, unknown>> = [];
    eventBus.subscribe(childId, (e) => childEvents.push(e.data as Record<string, unknown>));
    eventBus.subscribe(parentId, (e) => parentEvents.push(e.data as Record<string, unknown>));

    const result = await todoWriteTool.execute(
      { todos: [{ content: 'Задача ребёнка', status: 'in_progress', priority: 'high' }] },
      makeCtx({ todoSessionId: childId }),
    );
    expect(result.isError).toBeUndefined();

    const child = (await sessionManager.getSession(childId))!;
    const parent = (await sessionManager.getSession(parentId))!;
    expect(child.todos).toHaveLength(1);
    expect(child.todos![0]!.content).toBe('Задача ребёнка');
    expect(parent.todos ?? []).toHaveLength(0);
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0]!.session_id).toBe(childId);
    expect(parentEvents).toHaveLength(0);
  });

  it('todo_add/todo_list работают со списком ребёнка', async () => {
    await todoAddTool.execute(
      { todos: { content: 'Добавлено ребёнку' } },
      makeCtx({ todoSessionId: childId }),
    );

    const child = (await sessionManager.getSession(childId))!;
    const parent = (await sessionManager.getSession(parentId))!;
    expect(child.todos!.map((t) => t.content)).toEqual(['Добавлено ребёнку']);
    expect(parent.todos ?? []).toHaveLength(0);

    const listed = await todoListTool.execute({}, makeCtx({ todoSessionId: childId }));
    expect(listed.content).toContain('Добавлено ребёнку');
  });

  it('без todoSessionId — прежнее поведение: список сессии sessionId', async () => {
    await todoWriteTool.execute(
      { todos: [{ content: 'Родительская задача', status: 'pending', priority: 'medium' }] },
      makeCtx(),
    );

    const parent = (await sessionManager.getSession(parentId))!;
    const child = (await sessionManager.getSession(childId))!;
    expect(parent.todos!.map((t) => t.content)).toEqual(['Родительская задача']);
    expect(child.todos ?? []).toHaveLength(0);
  });
});

