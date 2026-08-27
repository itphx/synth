import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, TodoItem, TodoStatus, TodoPriority } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import { isAborted, abortedResult } from './abort.js';

export interface TodoToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
const TODO_PRIORITIES = ['high', 'medium', 'low'] as const;

const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: 'ожидает',
  in_progress: 'в работе',
  completed: 'выполнено',
  cancelled: 'отменено',
};

const PRIORITY_LABELS: Record<TodoPriority, string> = {
  high: 'высокий',
  medium: 'средний',
  low: 'низкий',
};

/**
 * Пункт todo на входе инструмента: id опционален (генерируется при создании),
 * status/priority — обязательны для todo_write (полная замена списка).
 */
type TodoInputItem = {
  id?: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  planItemId?: string;
};

// Полный пункт для todo_write: status/priority обязательны, id/planItemId — опциональны.
const todoWriteItemSchema = z.object({
  id: z.string().optional().describe('Item id (generated if not provided)'),
  content: z.string().describe('Todo item text'),
  status: z.enum(TODO_STATUSES).describe('Current status of the item'),
  priority: z.enum(TODO_PRIORITIES).describe('Priority of the item'),
  planItemId: z.string().optional().describe('Reference to a project plan item (AD-039)'),
});

// Пункт для todo_add: content обязателен, status/priority — со значениями по умолчанию.
const todoAddItemSchema = z.object({
  id: z.string().optional().describe('Item id (generated if not provided)'),
  content: z.string().describe('Todo item text'),
  status: z.enum(TODO_STATUSES).optional().default('pending').describe('Status of the item'),
  priority: z.enum(TODO_PRIORITIES).optional().default('medium').describe('Priority of the item'),
  planItemId: z.string().optional().describe('Reference to a project plan item (AD-039)'),
});

/** Приводит пункт к каноническому виду: генерирует id, если его нет. */
function toTodoItem(input: TodoInputItem): TodoItem {
  return {
    id: input.id || randomUUID(),
    content: input.content,
    status: input.status,
    priority: input.priority,
    ...(input.planItemId !== undefined ? { planItemId: input.planItemId } : {}),
  };
}

/** Нормализует сохранённый список: старые пункты без id получают id на лету. */
function normalizeTodos(todos: TodoItem[] | undefined): TodoItem[] {
  return (todos ?? []).map((t) => toTodoItem(t));
}

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return `Ошибка аргументов инструмента "${toolName}": ${issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ')}`;
}

function requireSessionManager(
  extra: TodoToolExtra | undefined,
  toolName: string,
): { content: string; isError: true } | null {
  if (!extra?.sessionManager || !extra.sessionId) {
    return { content: `Ошибка: менеджер сессий недоступен для ${toolName}`, isError: true };
  }
  return null;
}

/**
 * Markdown-представление списка todo для system prompt (AD-039):
 * строка на пункт `- [статус] [приоритет] содержание`. Пустой список → null.
 */
export function renderTodosMarkdown(todos: TodoItem[]): string | null {
  if (!todos || todos.length === 0) return null;
  return todos
    .map((t) => `- [${STATUS_LABELS[t.status]}] [${PRIORITY_LABELS[t.priority]}] ${t.content}`)
    .join('\n');
}

/**
 * todo_write — полная замена списка задач сессии (обратная совместимость).
 * Пункты без id получают сгенерированный id.
 */
export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description:
    'Replace the session todo list with the given items. '
    + 'The todo list is the operational task list of this session (distinct from the project plan '
    + 'stored in project.plan); use planItemId to link an item to a plan item. '
    + 'The list is stored in the session state (not a file) and can be read by the UI. '
    + 'Item ids are generated automatically if not provided. '
    + 'Returns the resulting todo list as JSON.',
  parameters: z.object({
    todos: z.array(todoWriteItemSchema).describe('Full list of todo items to store'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { todos: TodoInputItem[] };
    const extra = ctx.extra as TodoToolExtra | undefined;

    const missing = requireSessionManager(extra, this.name);
    if (missing) return missing;

    const todos = params.todos.map(toTodoItem);

    try {
      await extra!.sessionManager!.withLock(extra!.sessionId!, async (s) => {
        s.todos = todos;
        await extra!.sessionManager!.saveSession(s);
      });
    } catch (err) {
      return {
        content: `Ошибка сохранения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    return {
      content: JSON.stringify(todos),
      metadata: { todos },
    };
  },
};

/**
 * todo_list — вернуть текущий список задач. Старые пункты без id получают
 * сгенерированный id в ответе (не сохраняются).
 */
export const todoListTool: ToolDefinition = {
  name: 'todo_list',
  description:
    'Return the current session todo list as a human-readable text. '
    + 'The todo list is the operational task list of this session (distinct from the project plan '
    + 'stored in project.plan); items may be linked to plan items via planItemId. '
    + 'Items without an id (legacy data) get a generated id in the response.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = ctx.extra as TodoToolExtra | undefined;

    const missing = requireSessionManager(extra, this.name);
    if (missing) return missing;

    let todos: TodoItem[];
    try {
      const session = await extra!.sessionManager!.getSession(extra!.sessionId!);
      todos = normalizeTodos(session?.todos);
    } catch (err) {
      return {
        content: `Ошибка чтения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (todos.length === 0) {
      return { content: 'Todo-список пуст', metadata: { todos } };
    }

    const lines = todos.map(
      (t) => `- ${t.content} [${STATUS_LABELS[t.status]}, ${PRIORITY_LABELS[t.priority]}]`,
    );
    return {
      content: `Todo-список (${todos.length}):\n${lines.join('\n')}`,
      metadata: { todos },
    };
  },
};

/**
 * todo_add — добавить один или несколько пунктов в список задач.
 */
export const todoAddTool: ToolDefinition = {
  name: 'todo_add',
  description:
    'Add one or more items to the session todo list. '
    + 'The todo list is the operational task list of this session (distinct from the project plan '
    + 'stored in project.plan); use planItemId to link an item to a plan item. '
    + 'Accepts a single item or an array of items '
    + '{ content, status?, priority?, planItemId? }. status defaults to "pending", priority to "medium". '
    + 'Item ids are generated automatically. Returns the resulting todo list as JSON.',
  parameters: z.object({
    todos: z.union([todoAddItemSchema, z.array(todoAddItemSchema)])
      .describe('Todo item or array of todo items to add'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const raw = parsed.data as { todos: TodoInputItem | TodoInputItem[] };
    const extra = ctx.extra as TodoToolExtra | undefined;

    const missing = requireSessionManager(extra, this.name);
    if (missing) return missing;

    const inputs = Array.isArray(raw.todos) ? raw.todos : [raw.todos];
    const newItems = inputs.map(toTodoItem);

    let todos: TodoItem[];
    try {
      todos = await extra!.sessionManager!.withLock(extra!.sessionId!, async (s) => {
        const current = normalizeTodos(s.todos);
        s.todos = [...current, ...newItems];
        await extra!.sessionManager!.saveSession(s);
        return s.todos!;
      });
    } catch (err) {
      return {
        content: `Ошибка сохранения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    return {
      content: JSON.stringify(todos),
      metadata: { todos },
    };
  },
};

/**
 * todo_update — обновить пункт по id.
 */
export const todoUpdateTool: ToolDefinition = {
  name: 'todo_update',
  description:
    'Update a todo item by id. '
    + 'The todo list is the operational task list of this session (distinct from the project plan '
    + 'stored in project.plan); use planItemId to link an item to a plan item. '
    + 'Parameters: { id, content?, status?, priority?, planItemId? }. '
    + 'Returns the resulting todo list as JSON. Errors if the item is not found.',
  parameters: z.object({
    id: z.string().describe('Id of the todo item to update'),
    content: z.string().optional().describe('New item text'),
    status: z.enum(TODO_STATUSES).optional().describe('New status'),
    priority: z.enum(TODO_PRIORITIES).optional().describe('New priority'),
    planItemId: z.string().optional().describe('Reference to a project plan item (AD-039)'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as {
      id: string;
      content?: string;
      status?: TodoStatus;
      priority?: TodoPriority;
      planItemId?: string;
    };
    const extra = ctx.extra as TodoToolExtra | undefined;

    const missing = requireSessionManager(extra, this.name);
    if (missing) return missing;

    let todos: TodoItem[];
    let found = false;
    try {
      todos = await extra!.sessionManager!.withLock(extra!.sessionId!, async (s) => {
        const current = normalizeTodos(s.todos);
        const idx = current.findIndex((t) => t.id === params.id);
        if (idx < 0) return current;
        const item = current[idx]!;
        const updated: TodoItem = {
          ...item,
          ...(params.content !== undefined ? { content: params.content } : {}),
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(params.priority !== undefined ? { priority: params.priority } : {}),
          ...(params.planItemId !== undefined ? { planItemId: params.planItemId } : {}),
        };
        current[idx] = updated;
        s.todos = current;
        await extra!.sessionManager!.saveSession(s);
        found = true;
        return current;
      });
    } catch (err) {
      return {
        content: `Ошибка сохранения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (!found) {
      return {
        content: `Ошибка: пункт todo с id "${params.id}" не найден`,
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    return {
      content: JSON.stringify(todos),
      metadata: { todos },
    };
  },
};

/**
 * todo_delete — удалить пункты по id (один или массив).
 */
export const todoDeleteTool: ToolDefinition = {
  name: 'todo_delete',
  description:
    'Delete todo items by id. '
    + 'The todo list is the operational task list of this session (distinct from the project plan '
    + 'stored in project.plan); items are removed from the session state, not from the project plan. '
    + 'Accepts a single id or an array of ids. '
    + 'Returns the resulting todo list as JSON. Errors if none of the ids are found.',
  parameters: z.object({
    ids: z.union([z.string(), z.array(z.string())])
      .describe('Todo item id or array of ids to delete'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const rawIds = (parsed.data as { ids: string | string[] }).ids;
    const extra = ctx.extra as TodoToolExtra | undefined;

    const missing = requireSessionManager(extra, this.name);
    if (missing) return missing;

    const ids = Array.isArray(rawIds) ? rawIds : [rawIds];
    const idSet = new Set(ids);

    let todos: TodoItem[];
    let removed = 0;
    try {
      todos = await extra!.sessionManager!.withLock(extra!.sessionId!, async (s) => {
        const current = normalizeTodos(s.todos);
        const remaining = current.filter((t) => !idSet.has(t.id));
        removed = current.length - remaining.length;
        if (removed === 0) return current;
        s.todos = remaining;
        await extra!.sessionManager!.saveSession(s);
        return remaining;
      });
    } catch (err) {
      return {
        content: `Ошибка сохранения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (removed === 0) {
      return {
        content: `Ошибка: пункты todo с id "${ids.join('", "')}" не найдены`,
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    return {
      content: JSON.stringify(todos),
      metadata: { todos },
    };
  },
};
