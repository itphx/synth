/**
 * HTTP-контур плана проекта (PROP-054, ADR-039).
 *
 * Единая core-фабрика (standalone и managed — одна реализация; backend
 * добавляет только RBAC/i18n через `opts`).
 *
 * Эндпоинты (все — под `/api/v2/projects`):
 * - `GET    /:id/plan` → `{ plan }`;
 * - `POST   /:id/plan/items` → `{ plan }`;
 * - `PATCH  /:id/plan/items/:itemId` → `{ plan }`;
 * - `PATCH  /:id/plan/items/:itemId/move` → `{ plan }`;
 * - `DELETE /:id/plan/items/:itemId` → `{ plan }`;
 * - `POST   /:id/plan/columns` → `{ plan }`;
 * - `PATCH  /:id/plan/columns/:columnId` → `{ plan }`;
 * - `DELETE /:id/plan/columns/:columnId` → `{ plan }`;
 * - `PUT    /:id/plan/columns/order` → `{ plan }`.
 *
 * Права: чтение — право чтения проекта, мутации — право изменения
 * содержимого (`VIEWER` читает, но не мутирует — инвариант 21).
 * Ошибки: `400 VALIDATION_ERROR` (в т.ч. лимиты Markdown), `403
 * PROJECT_FORBIDDEN`, `404 NOT_FOUND`, `409 PLAN_VERSION_CONFLICT` (в теле —
 * актуальный план).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  planItemCreateSchema,
  planItemUpdateSchema,
  planItemMoveSchema,
  planColumnCreateSchema,
  planColumnUpdateSchema,
  planColumnDeleteSchema,
  planColumnsOrderSchema,
} from '@itphx/synth-shared';
import type { ProjectPlan } from '@itphx/synth-shared';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { isRemoteRef } from '../../remote/aggregate.js';
import {
  PlanService,
  PlanColumnNotFoundError,
  PlanItemNotFoundError,
  PlanLimitExceededError,
  PlanProjectNotFoundError,
  PlanValidationError,
  PlanVersionConflictError,
} from '../../engine/plan/service.js';
import { publishPlanUpdated } from '../../engine/plan/events.js';
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';
import {
  createProjectWorkAccess,
  type ProjectWorkRoutesAuth,
  type ProjectWorkRoutesOptions,
} from './project-work.js';

/** Опции фабрики плана (события + sessionManager — для `plan.updated`). */
export interface ProjectPlanRoutesOptions extends ProjectWorkRoutesOptions {
  /** Шина событий (публикация `plan.updated`). */
  eventBus?: EventBus;
  /** Менеджер сессий (перечисление сессий проекта для события). */
  sessionManager?: SessionManager;
}

/**
 * API плана проекта (PROP-054). Монтируется в core и backend на
 * `/api/v2/projects`.
 */
export function createProjectPlanRoutes(
  auth: ProjectWorkRoutesAuth,
  store: ProjectRepository,
  opts: ProjectPlanRoutesOptions = {},
): Hono {
  const app = new Hono();
  const access = createProjectWorkAccess(store, opts);
  const plan = new PlanService(store);

  /** Тело ответа с актуальным планом. */
  const withPlan = (c: Context, value: ProjectPlan) => c.json({ plan: value });

  /** Ошибка доменного сервиса → HTTP-ответ. */
  const serviceError = (c: Context, err: unknown): Response | null => {
    if (err instanceof PlanVersionConflictError) {
      return c.json(
        {
          error: {
            code: 'PLAN_VERSION_CONFLICT',
            message: `Plan version conflict: expected ${err.expected}, actual ${err.actual}`,
            details: { expected: err.expected, actual: err.actual },
          },
          plan: err.plan,
        },
        409,
      );
    }
    if (err instanceof PlanItemNotFoundError || err instanceof PlanColumnNotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    }
    if (err instanceof PlanProjectNotFoundError) {
      return access.jsonNotFound(c);
    }
    if (err instanceof PlanLimitExceededError) {
      return access.jsonInvalid(c, err.message);
    }
    if (err instanceof PlanValidationError) {
      return access.jsonInvalid(c, err.message);
    }
    return null;
  };

  /**
   * Общая часть мутации: проверка права, вызов доменного сервиса,
   * публикация `plan.updated` в каналы всех сессий проекта.
   */
  const mutate = async (
    c: Context,
    projectId: string,
    run: (service: PlanService) => Promise<ProjectPlan>,
  ): Promise<Response> => {
    const guard = await access.authorize(c, projectId, 'write');
    if (guard instanceof Response) return guard;
    let result: ProjectPlan;
    try {
      result = await run(plan);
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
    await publishPlanUpdated(
      { eventBus: opts.eventBus, sessionManager: opts.sessionManager },
      projectId,
      result.version,
    );
    return withPlan(c, result);
  };

  // GET /api/v2/projects/:id/plan — план целиком (для модального окна доски).
  app.get('/:id/plan', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const guard = await access.authorize(c, projectId, 'read');
    if (guard instanceof Response) return guard;
    try {
      const value = await plan.read(projectId);
      return withPlan(c, value as ProjectPlan);
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // POST /api/v2/projects/:id/plan/items — создать пункт.
  app.post('/:id/plan/items', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = planItemCreateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.createItem(projectId, parsed.data));
  });

  // PATCH /api/v2/projects/:id/plan/items/:itemId — правка полей пункта.
  app.patch('/:id/plan/items/:itemId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const itemId = c.req.param('itemId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = planItemUpdateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.updateItem(projectId, itemId, parsed.data));
  });

  // PATCH /api/v2/projects/:id/plan/items/:itemId/move — перемещение пункта.
  app.patch('/:id/plan/items/:itemId/move', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const itemId = c.req.param('itemId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = planItemMoveSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.moveItem(projectId, itemId, parsed.data));
  });

  // DELETE /api/v2/projects/:id/plan/items/:itemId — удалить пункт.
  app.delete('/:id/plan/items/:itemId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const itemId = c.req.param('itemId');
    return mutate(c, projectId, (service) => service.deleteItem(projectId, itemId));
  });

  // POST /api/v2/projects/:id/plan/columns — создать колонку.
  app.post('/:id/plan/columns', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = planColumnCreateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.addColumn(projectId, parsed.data));
  });

  // PATCH /api/v2/projects/:id/plan/columns/:columnId — переименовать/WIP.
  app.patch('/:id/plan/columns/:columnId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const columnId = c.req.param('columnId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = planColumnUpdateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.updateColumn(projectId, columnId, parsed.data));
  });

  // DELETE /api/v2/projects/:id/plan/columns/:columnId — удалить колонку.
  app.delete('/:id/plan/columns/:columnId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const columnId = c.req.param('columnId');
    const body = await c.req.json().catch(() => ({}));
    const parsed = planColumnDeleteSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.deleteColumn(projectId, columnId, parsed.data));
  });

  // PUT /api/v2/projects/:id/plan/columns/order — новый порядок колонок.
  app.put('/:id/plan/columns/order', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    if (isRemoteRef(projectId)) return access.jsonRemoteUnavailable(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = planColumnsOrderSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    return mutate(c, projectId, (service) => service.reorderColumns(projectId, parsed.data));
  });

  return app;
}
