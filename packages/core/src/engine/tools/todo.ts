import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, TodoItem, TodoStatus, TodoPriority } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

export interface TodoToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
const TODO_PRIORITIES = ['high', 'medium', 'low'] as const;

/**
 * Ключи-обёртки, которыми слабые модели заворачивают аргумент: присылают
 * `{"todos": {"item": [{…}]}}` вместо `{"todos": […]}` и получают бесполезное
 * `todos: Invalid input`, после чего повторяют тот же вызов.
 */
const TODO_ITEM_WRAPPER_KEYS = ['item', 'items', 'todos'] as const;
const TODO_IDS_WRAPPER_KEYS = ['item', 'items', 'ids'] as const;

/** Глубина разворачивания обёрток (`{items:{item:…}}`) — защита от зацикливания. */
const TODO_WRAPPER_MAX_DEPTH = 3;

/**
 * Разворачивает одиночную обёртку `{item: …}`/`{items: …}`/`{todos: …}`.
 *
 * Разворачивается только объект с **единственным** ключом из списка — сам пункт
 * todo (`{content, status?}`), массив и любой другой объект остаются как есть.
 */
function unwrapTodoArg(value: unknown, wrapperKeys: readonly string[]): unknown {
  let current = value;
  for (let depth = 0; depth < TODO_WRAPPER_MAX_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return current;
    const keys = Object.keys(current);
    if (keys.length !== 1) return current;
    const key = keys[0]!;
    if (!wrapperKeys.includes(key)) return current;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Нормализация аргументов todo-тула до zod-валидации: `{todos:{item:[…]}}` →
 * `{todos:[…]}`. Валидные формы не меняются; сам union в схеме остаётся
 * (схема для модели не переписывается — нормализация только на приёме).
 */
function normalizeTodoArgs(
  args: Record<string, unknown>,
  field: 'todos' | 'ids',
  wrapperKeys: readonly string[],
): Record<string, unknown> {
  if (!(field in args)) return args;
  const value = args[field];
  const unwrapped = unwrapTodoArg(value, wrapperKeys);
  if (unwrapped === value) return args;
  return { ...args, [field]: unwrapped };
}

/** Приоритет по умолчанию (todo_add) — в компактном выводе не печатается. */
const DEFAULT_TODO_PRIORITY: TodoPriority = 'medium';

/**
 * Предел числа пунктов в компактном выводе списка: дальше — только хвост
 * «... and N more» (защита от разрастания ответа на длинных списках).
 */
const TODO_MAX_OUTPUT_ITEMS = 30;

const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: sm('todo.status_pending'),
  in_progress: sm('todo.status_in_progress'),
  completed: sm('todo.status_completed'),
  cancelled: sm('todo.status_cancelled'),
};

const PRIORITY_LABELS: Record<TodoPriority, string> = {
  high: sm('todo.priority_high'),
  medium: sm('todo.priority_medium'),
  low: sm('todo.priority_low'),
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
  planItemId: z.string().optional().describe('Reference to a project plan item (ADR-039)'),
});

// Пункт для todo_add: content обязателен, status/priority — со значениями по умолчанию.
const todoAddItemSchema = z.object({
  id: z.string().optional().describe('Item id (generated if not provided)'),
  content: z.string().describe('Todo item text'),
  status: z.enum(TODO_STATUSES).optional().default('pending').describe('Status of the item'),
  priority: z.enum(TODO_PRIORITIES).optional().default(DEFAULT_TODO_PRIORITY).describe('Priority of the item'),
  planItemId: z.string().optional().describe('Reference to a project plan item (ADR-039)'),
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

function requireSessionManager(
  extra: TodoToolExtra | undefined,
  toolName: string,
): { content: string; isError: true; metadata?: Record<string, unknown> } | null {
  if (!extra?.sessionManager || !extra.sessionId) {
    return { content: sm('plan.session_manager_unavailable', { tool: toolName }), isError: true, metadata: { i18n: i18nMeta('plan.session_manager_unavailable', { tool: toolName }) } };
  }
  return null;
}

/**
 * Markdown-представление списка todo для system prompt (ADR-039):
 * строка на пункт `- [статус] [приоритет] содержание`. Пустой список → null.
 */
export function renderTodosMarkdown(todos: TodoItem[]): string | null {
  if (!todos || todos.length === 0) return null;
  return todos
    .map((t) => `- [${STATUS_LABELS[t.status]}] [${PRIORITY_LABELS[t.priority]}] ${t.content}`)
    .join('\n');
}

/**
 * Компактный человекочитаемый вывод списка todo (по образцу opencode):
 * строка сводки + строка на пункт. JSON в ответе не отдаётся — он шумный и
 * съедает контекст модели; модель зовёт `todo_update`/`todo_delete` по id,
 * поэтому id в выводе обязателен.
 */

/** Сводка списка: сколько пунктов выполнено, сколько всего и сколько в работе. */
function renderTodoSummary(todos: TodoItem[]): string {
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  return sm('todo.summary', {
    completed: String(completed),
    total: String(todos.length),
    inProgress: String(inProgress),
  });
}

/** Отметка выполнения: `[x]` — выполнен, `[ ]` — иначе. */
function todoMark(todo: TodoItem): string {
  return todo.status === 'completed' ? 'x' : ' ';
}

/**
 * Заголовок пункта: id (обязателен — по нему модель зовёт `todo_update`)
 * и текст задачи.
 */
function todoTitle(todo: TodoItem): string {
  return `${todo.id}: ${todo.content}`;
}

/**
 * Статус пункта и необязательные признаки одной скобкой. Приоритет печатается,
 * только если он отличается от дефолтного (иначе строка шумит); связь с
 * пунктом плана — когда она задана.
 */
function todoStatus(todo: TodoItem): string {
  const details = [STATUS_LABELS[todo.status]];
  if (todo.priority && todo.priority !== DEFAULT_TODO_PRIORITY) {
    details.push(sm('todo.hint_priority', { priority: PRIORITY_LABELS[todo.priority] }));
  }
  if (todo.planItemId) {
    details.push(sm('todo.hint_plan', { plan: todo.planItemId }));
  }
  return details.join(', ');
}

/** Строка пункта: `- [x] {id}: {title} ({status})`. */
function renderTodoLine(todo: TodoItem): string {
  return sm('todo.line', {
    mark: todoMark(todo),
    title: todoTitle(todo),
    status: todoStatus(todo),
  });
}

/**
 * Полный компактный список: сводка + строки пунктов. Список длиннее
 * `TODO_MAX_OUTPUT_ITEMS` усекается хвостом «... and N more».
 */
function renderTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return sm('todo.list_empty');
  const shown = todos.slice(0, TODO_MAX_OUTPUT_ITEMS).map(renderTodoLine);
  if (todos.length > TODO_MAX_OUTPUT_ITEMS) {
    shown.push(sm('todo.more', { count: String(todos.length - TODO_MAX_OUTPUT_ITEMS) }));
  }
  return [renderTodoSummary(todos), ...shown].join('\n');
}

/** Короткий результат одиночного действия + сводка списка. */
function renderTodoResult(result: string, todos: TodoItem[]): string {
  return [result, renderTodoSummary(todos)].join('\n');
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
    + 'Returns a compact summary and one line per item (with the item id, needed by todo_update).',
  parameters: z.object({
    todos: z.array(todoWriteItemSchema).describe('Full list of todo items to store'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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
        content: sm('todo.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    return {
      content: renderTodoList(todos),
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
        content: sm('todo.read_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    if (todos.length === 0) {
      return { content: sm('todo.list_empty'), metadata: { todos, i18n: i18nMeta('todo.list_empty') } };
    }

    return {
      content: renderTodoList(todos),
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
    + 'Item ids are generated automatically. '
    + 'Returns the ids of the added items and a short summary of the list.',
  parameters: z.object({
    todos: z.union([todoAddItemSchema, z.array(todoAddItemSchema)])
      .describe('Todo item or array of todo items to add'),
  }),
  // Терпимость к `{todos:{item:[…]}}`/`{todos:{items:…}}` от слабых моделей.
  normalizeArgs: (args) => normalizeTodoArgs(args, 'todos', TODO_ITEM_WRAPPER_KEYS),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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
        content: sm('todo.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    // Одиночное действие: короткая строка о результате + сводка (полный список
    // не нужен — модель знает, что добавила).
    return {
      content: renderTodoResult(
        sm('todo.added', { ids: newItems.map((t) => t.id).join(', ') }),
        todos,
      ),
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
    + 'Returns a short confirmation and a summary of the list. Errors if the item is not found.',
  parameters: z.object({
    id: z.string().describe('Id of the todo item to update'),
    content: z.string().optional().describe('New item text'),
    status: z.enum(TODO_STATUSES).optional().describe('New status'),
    priority: z.enum(TODO_PRIORITIES).optional().describe('New priority'),
    planItemId: z.string().optional().describe('Reference to a project plan item (ADR-039)'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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
        content: sm('todo.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    if (!found) {
      return {
        content: sm('todo.item_not_found', { id: params.id }),
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    // Одиночное действие: строка о результате + сводка (без полного списка).
    return {
      content: renderTodoResult(sm('todo.updated', { id: params.id }), todos),
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
    + 'Returns a short confirmation and a summary of the list. Errors if none of the ids are found.',
  parameters: z.object({
    ids: z.union([z.string(), z.array(z.string())])
      .describe('Todo item id or array of ids to delete'),
  }),
  // Терпимость к `{ids:{item:'…'}}`/`{ids:{ids:[…]}}` от слабых моделей.
  normalizeArgs: (args) => normalizeTodoArgs(args, 'ids', TODO_IDS_WRAPPER_KEYS),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
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
        content: sm('todo.save_error', { error: err instanceof Error ? err.message : String(err) }),
        isError: true,
      };
    }

    if (removed === 0) {
      return {
        content: sm('todo.items_not_found', { ids: ids.join('", "') }),
        isError: true,
      };
    }

    extra!.eventBus?.publish(extra!.sessionId!, 'todos.updated', {
      session_id: extra!.sessionId!,
      todos,
    });

    // Одиночное действие: строка о результате + сводка (без полного списка).
    return {
      content: renderTodoResult(sm('todo.deleted', { count: String(removed) }), todos),
      metadata: { todos },
    };
  },
};
