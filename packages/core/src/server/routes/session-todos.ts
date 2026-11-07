/**
 * HTTP-контур списка задач сессии (ToDo) — PROP-054, ADR-039.
 *
 * Единая core-фабрика: её зовут HTTP-роуты (`/api/v2/sessions/:id/todos*`).
 * Доступ — **существующий prefix-guard** сессий (`server/session-access-guard.ts`):
 * чтение — read-доступ к сессии, мутации — write-доступ. Проверок доступа
 * внутри обработчиков нет (инвариант 16) — фабрика **монтируется внутрь**
 * приложения сессий, поэтому guard её покрывает.
 *
 * Эндпоинты:
 * - `GET    /:id/todos` → `{ todos }`;
 * - `POST   /:id/todos` → `{ todos }`;
 * - `PATCH  /:id/todos/:todoId` → `{ todos }`;
 * - `DELETE /:id/todos/:todoId` → `{ todos }`;
 * - `PUT    /:id/todos/order` → `{ todos }`;
 * - `POST   /:id/todos/clear` → `{ todos }`.
 *
 * Все операции атомарны под `SessionManager.withLock`; отдельной версии ToDo
 * нет (конфликтов не бывает). После мутации публикуется `todos.updated` в
 * канал сессии (payload — актуальный список).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  todoCreateSchema,
  todoUpdateSchema,
  todoOrderSchema,
  todoClearSchema,
} from '@itphx/synth-shared';
import type { TodoItem } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import {
  TodoService,
  TodoLimitExceededError,
  TodoNotFoundError,
  TodoValidationError,
} from '../../engine/todo/service.js';
import type { ProjectWorkRoutesAuth } from './project-work.js';

/** Зависимости фабрики ToDo. */
export interface SessionTodoRoutesDeps extends ProjectWorkRoutesAuth {
  sessionManager: SessionManager;
  eventBus?: EventBus;
}

/**
 * API списка задач сессии (PROP-054). Монтируется **внутрь** приложения сессий
 * (`app.route('/', …)`), чтобы доступ решал единый prefix-guard.
 */
export function createSessionTodoRoutes(deps: SessionTodoRoutesDeps): Hono {
  const app = new Hono();
  const service = new TodoService(deps.sessionManager);

  const serviceError = (c: Context, err: unknown): Response | null => {
    if (err instanceof TodoNotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    }
    if (err instanceof TodoLimitExceededError || err instanceof TodoValidationError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
    }
    return null;
  };

  /** Ответ со списком + публикация `todos.updated` в канал сессии. */
  const respond = async (c: Context, sessionId: string, todos: TodoItem[]) => {
    deps.eventBus?.publish(sessionId, 'todos.updated', { session_id: sessionId, todos });
    return c.json({ todos });
  };

  // GET /api/v2/sessions/:id/todos — текущий список задач.
  app.get('/:id/todos', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    try {
      return await respond(c, sessionId, await service.list(sessionId));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // POST /api/v2/sessions/:id/todos — создать пункт.
  app.post('/:id/todos', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = todoCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }
    try {
      return await respond(c, sessionId, await service.add(sessionId, parsed.data));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // PATCH /api/v2/sessions/:id/todos/:todoId — правка пункта.
  app.patch('/:id/todos/:todoId', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const todoId = c.req.param('todoId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = todoUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }
    try {
      return await respond(c, sessionId, await service.update(sessionId, todoId, parsed.data));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // DELETE /api/v2/sessions/:id/todos/:todoId — удалить пункт.
  app.delete('/:id/todos/:todoId', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const todoId = c.req.param('todoId');
    try {
      return await respond(c, sessionId, await service.remove(sessionId, todoId));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // PUT /api/v2/sessions/:id/todos/order — новый порядок пунктов.
  app.put('/:id/todos/order', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = todoOrderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }
    try {
      return await respond(c, sessionId, await service.reorder(sessionId, parsed.data.ids));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // POST /api/v2/sessions/:id/todos/clear — очистить пункты по статусам.
  app.post('/:id/todos/clear', deps.requireAuth, async (c) => {
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = todoClearSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }
    try {
      return await respond(c, sessionId, await service.clear(sessionId, parsed.data.statuses));
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}
