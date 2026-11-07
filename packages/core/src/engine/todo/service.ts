/**
 * Доменный сервис списка задач сессии (ADR-039, PROP-054).
 *
 * Единая точка правки `session.todos`: её зовут **и** инструменты
 * (`todo_add`/`todo_update`/`todo_delete`/`todo_reorder`/`todo_clear`),
 * **и** HTTP-роуты (`/api/v2/sessions/:id/todos*`).
 *
 * Правила:
 * - все операции атомарны под `SessionManager.withLock` (per-session лок);
 * - отдельной версии ToDo нет (операции атомарны, конфликтов не бывает);
 * - `order` принимает только существующие id: неизвестные игнорируются, новые
 *   пункты дописываются в конец (воскрешения удалённых нет);
 * - порядок списка = порядок массива (модель ToItem формы не меняем);
 * - лимит Markdown-текста (`MARKDOWN_LIMITS.todoContent`) проверяется здесь —
 *   и HTTP, и инструменты берут одну и ту же проверку.
 */
import { randomUUID } from 'node:crypto';
import { MARKDOWN_LIMITS } from '@itphx/synth-shared';
import type { Session, TodoItem, TodoStatus, TodoPriority } from '@itphx/synth-shared';

/** Минимальный контракт менеджера сессий, нужный сервису ToDo. */
export interface TodoSessionManager {
  withLock<T>(sessionId: string, fn: (session: Session) => Promise<T>): Promise<T>;
  saveSession(session: Session): Promise<void>;
}

/** Пункт ToDo не найден (HTTP 404). */
export class TodoNotFoundError extends Error {
  constructor(readonly todoId: string) {
    super(`Todo item "${todoId}" not found`);
    this.name = 'TodoNotFoundError';
  }
}

/** Некорректные данные правки (HTTP 400 `VALIDATION_ERROR`). */
export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoValidationError';
  }
}

/** Превышен лимит Markdown-текста пункта (HTTP 400 `VALIDATION_ERROR`). */
export class TodoLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Todo content exceeds the limit of ${limit} bytes (${actual})`);
    this.name = 'TodoLimitExceededError';
  }
}

/** Приоритет по умолчанию (в компактном выводе не печатается). */
export const DEFAULT_TODO_PRIORITY: TodoPriority = 'medium';

/** Статусы, очищаемые по умолчанию (`todo_clear`). */
export const DEFAULT_TODO_CLEAR_STATUSES: readonly TodoStatus[] = ['completed', 'cancelled'];

/** Ввод: создание пункта ToDo. */
export interface TodoCreateInput {
  /** Готовый id пункта (не задан — генерируется). */
  id?: string;
  content: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  planItemId?: string;
}

/** Ввод: точечная правка пункта ToDo (`planItemId: null` — отвязать). */
export interface TodoUpdateInput {
  content?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  planItemId?: string | null;
}

/**
 * Приводит пункт к каноническому виду: генерирует id, если его нет.
 * Экспортируется — тем же контрактом пользуется стартовый список саб-агента
 * (`task.todos`): id, пришедшие от модели, сохраняются как есть.
 */
export function toTodoItem(input: {
  id?: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  planItemId?: string;
}): TodoItem {
  return {
    id: input.id || randomUUID(),
    content: input.content,
    status: input.status,
    priority: input.priority,
    ...(input.planItemId !== undefined ? { planItemId: input.planItemId } : {}),
  };
}

/** Нормализует сохранённый список: старые пункты без id получают id на лету. */
export function normalizeTodos(todos: TodoItem[] | undefined): TodoItem[] {
  return (todos ?? []).map((t) => toTodoItem(t));
}

/** Проверка лимита Markdown-текста пункта. */
export function assertTodoContentLimit(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MARKDOWN_LIMITS.todoContent) {
    throw new TodoLimitExceededError(MARKDOWN_LIMITS.todoContent, bytes);
  }
}

/**
 * Доменный сервис списка задач сессии.
 */
export class TodoService {
  constructor(private readonly sessions: TodoSessionManager) {}

  /** Текущий список задач сессии (с ленивой нормализацией legacy-пунктов). */
  async list(sessionId: string): Promise<TodoItem[]> {
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      // Ленивая миграция legacy-пунктов без id: пишем только если id реально
      // не хватало (иначе повторный вызов ничего не сохраняет — идемпотентно).
      const missingId = (session.todos ?? []).some((t) => !t.id);
      if (missingId) {
        session.todos = current;
        await this.sessions.saveSession(session);
      }
      return current;
    });
  }

  /** Полная замена списка (legacy-инструмент `todo_write`). */
  async replaceAll(sessionId: string, items: TodoItem[]): Promise<TodoItem[]> {
    for (const item of items) assertTodoContentLimit(item.content);
    return this.sessions.withLock(sessionId, async (session) => {
      session.todos = items;
      await this.sessions.saveSession(session);
      return session.todos;
    });
  }

  /** Добавить пункт(ы) в конец списка. */
  async add(sessionId: string, input: TodoCreateInput | TodoCreateInput[]): Promise<TodoItem[]> {
    const inputs = Array.isArray(input) ? input : [input];
    for (const one of inputs) {
      if (!one.content?.trim()) throw new TodoValidationError('Todo content is required');
      assertTodoContentLimit(one.content);
    }
    const items = inputs.map((one) =>
      toTodoItem({
        ...(one.id !== undefined ? { id: one.id } : {}),
        content: one.content,
        status: one.status ?? 'pending',
        priority: one.priority ?? DEFAULT_TODO_PRIORITY,
        ...(one.planItemId !== undefined ? { planItemId: one.planItemId } : {}),
      }),
    );
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      session.todos = [...current, ...items];
      await this.sessions.saveSession(session);
      return session.todos;
    });
  }

  /** Точечная правка пункта. */
  async update(
    sessionId: string,
    todoId: string,
    patch: TodoUpdateInput,
  ): Promise<TodoItem[]> {
    if (patch.content !== undefined) {
      if (!patch.content.trim()) throw new TodoValidationError('Todo content is required');
      assertTodoContentLimit(patch.content);
    }
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      const index = current.findIndex((t) => t.id === todoId);
      if (index < 0) throw new TodoNotFoundError(todoId);
      const item = current[index]!;
      current[index] = {
        ...item,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.planItemId !== undefined
          ? patch.planItemId === null
            ? { planItemId: undefined }
            : { planItemId: patch.planItemId }
          : {}),
      };
      session.todos = current;
      await this.sessions.saveSession(session);
      return current;
    });
  }

  /** Удалить пункт. */
  async remove(sessionId: string, todoId: string): Promise<TodoItem[]> {
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      const remaining = current.filter((t) => t.id !== todoId);
      if (remaining.length === current.length) throw new TodoNotFoundError(todoId);
      session.todos = remaining;
      await this.sessions.saveSession(session);
      return remaining;
    });
  }

  /**
   * Новый порядок пунктов: `ids` — желаемый порядок существующих пунктов.
   * Неизвестные id игнорируются, не названные пункты дописываются в конец.
   */
  async reorder(sessionId: string, ids: string[]): Promise<TodoItem[]> {
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      const byId = new Map(current.map((t) => [t.id, t]));
      const ordered: TodoItem[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        const item = byId.get(id);
        if (!item || seen.has(id)) continue;
        seen.add(id);
        ordered.push(item);
      }
      for (const item of current) {
        if (!seen.has(item.id)) ordered.push(item);
      }
      session.todos = ordered;
      await this.sessions.saveSession(session);
      return ordered;
    });
  }

  /** Очистить пункты по статусам (по умолчанию — `completed` + `cancelled`). */
  async clear(sessionId: string, statuses?: readonly TodoStatus[]): Promise<TodoItem[]> {
    const targets = new Set<TodoStatus>(statuses?.length ? statuses : DEFAULT_TODO_CLEAR_STATUSES);
    return this.sessions.withLock(sessionId, async (session) => {
      const current = normalizeTodos(session.todos);
      const remaining = current.filter((t) => !targets.has(t.status));
      session.todos = remaining;
      await this.sessions.saveSession(session);
      return remaining;
    });
  }
}
