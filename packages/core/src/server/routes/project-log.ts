/**
 * HTTP-контур журнала и инвариантов проекта (ADR-130).
 *
 * Единая core-фабрика (standalone и managed — одна реализация; backend
 * добавляет только RBAC/i18n через `opts`).
 *
 * Эндпоинты (все — под `/api/v2/projects`):
 * - `GET    /:id/log?limit&offset` → `{ entries, total, offset, limit, next_offset }`;
 * - `POST   /:id/log` → `{ entry }`;
 * - `PATCH  /:id/log/:entryId` → `{ entry }`;
 * - `DELETE /:id/log/:entryId` → `204`;
 * - `GET    /:id/invariants` → `{ invariants, updated_at }`;
 * - `PUT    /:id/invariants` → `{ invariants, updated_at }`.
 *
 * Журнал **вынесен из детали проекта** (`GET /:id` больше не отдаёт `log`) —
 * единственный источник записей журнала — эта страница.
 *
 * Права: чтение — право чтения проекта, мутации — право изменения
 * содержимого (`VIEWER` читает, но не мутирует — инвариант 21).
 *
 * Гибрид (ADR-042/ADR-130): для `remote:`-проекта запрос **форвардится** на
 * удалённый backend (права и валидация — там); без клиента — `502
 * REMOTE_UNAVAILABLE`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  projectLogCreateSchema,
  projectLogUpdateSchema,
  projectInvariantsUpdateSchema,
} from '@itphx/synth-shared';
import type { ProjectLogEntry } from '@itphx/synth-shared';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { paginate, parseBoundedInt } from '../pagination.js';
import {
  ProjectLogService,
  ProjectLogEntryNotFoundError,
  ProjectLogLimitExceededError,
  ProjectLogProjectNotFoundError,
  ProjectLogValidationError,
} from '../../engine/project/log-service.js';
import {
  ProjectInvariantsService,
  ProjectInvariantsLimitExceededError,
  ProjectInvariantsNotFoundError,
} from '../../engine/project/invariants-service.js';
import { publishProjectUpdated } from '../../engine/project/events.js';
import type { EventBus } from '../../events/bus.js';
import type { SessionManager } from '../../sessions/manager.js';
import {
  createProjectWorkAccess,
  type ProjectWorkRoutesAuth,
  type ProjectWorkRoutesOptions,
} from './project-work.js';

/** Размер страницы журнала по умолчанию и максимум. */
export const DEFAULT_PROJECT_LOG_LIMIT = 50;
export const MAX_PROJECT_LOG_LIMIT = 200;

/** Опции фабрики журнала/инвариантов (события + sessionManager). */
export interface ProjectLogRoutesOptions extends ProjectWorkRoutesOptions {
  /** Шина событий (публикация `project.updated`). */
  eventBus?: EventBus;
  /** Менеджер сессий (перечисление сессий проекта для события). */
  sessionManager?: SessionManager;
}

/** DTO записи журнала (snake_case — как у остального API v2). */
function serializeLogEntry(entry: ProjectLogEntry) {
  return {
    id: entry.id,
    text: entry.text,
    created_at: entry.createdAt,
    session_id: entry.sessionId || null,
    author: entry.author || null,
    updated_at: entry.updatedAt || null,
    updated_by: entry.updatedBy || null,
  };
}

/**
 * API журнала и инвариантов проекта (PROP-054). Монтируется в core и backend
 * на `/api/v2/projects`.
 */
export function createProjectLogRoutes(
  auth: ProjectWorkRoutesAuth,
  store: ProjectRepository,
  opts: ProjectLogRoutesOptions = {},
): Hono {
  const app = new Hono();
  const access = createProjectWorkAccess(store, opts);
  const log = new ProjectLogService(store);
  const invariants = new ProjectInvariantsService(store);

  const serviceError = (c: Context, err: unknown): Response | null => {
    if (err instanceof ProjectLogEntryNotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    }
    if (err instanceof ProjectLogProjectNotFoundError || err instanceof ProjectInvariantsNotFoundError) {
      return access.jsonNotFound(c);
    }
    if (
      err instanceof ProjectLogLimitExceededError
      || err instanceof ProjectInvariantsLimitExceededError
      || err instanceof ProjectLogValidationError
    ) {
      return access.jsonInvalid(c, err.message);
    }
    return null;
  };

  // GET /api/v2/projects/:id/log — страница журнала (новые сверху).
  app.get('/:id/log', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    // Гибрид (ADR-042/ADR-130): журнал удалённого проекта — на сервере.
    // Форвард ДО локальной проверки/валидации (права и лимиты — там).
    const forwarded = await access.forwardRemote(c, projectId, 'GET', '/log', undefined, {
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (forwarded) return forwarded;
    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_PROJECT_LOG_LIMIT, MAX_PROJECT_LOG_LIMIT);
    if (limit === null) {
      return access.jsonInvalid(c, 'limit должен быть целым числом');
    }
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (offset === null) {
      return access.jsonInvalid(c, 'offset должен быть целым числом');
    }
    const guard = await access.authorize(c, projectId, 'read');
    if (guard instanceof Response) return guard;
    try {
      const entries = await log.list(projectId);
      const { page, total, next_offset } = paginate(entries, offset, limit);
      return c.json({
        entries: page.map(serializeLogEntry),
        total,
        offset,
        limit,
        next_offset,
      });
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // POST /api/v2/projects/:id/log — новая запись журнала.
  app.post('/:id/log', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const forwarded = await access.forwardRemote(c, projectId, 'POST', '/log', body);
    if (forwarded) return forwarded;
    const parsed = projectLogCreateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    const guard = await access.authorize(c, projectId, 'write');
    if (guard instanceof Response) return guard;
    try {
      const entry = await log.append(projectId, {
        text: parsed.data.text,
        author: guard.userId,
      });
      await publishProjectUpdated(
        { eventBus: opts.eventBus, sessionManager: opts.sessionManager },
        projectId,
        'log',
      );
      return c.json({ entry: serializeLogEntry(entry) }, 201);
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // PATCH /api/v2/projects/:id/log/:entryId — правка текста записи.
  app.patch('/:id/log/:entryId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    const entryId = c.req.param('entryId');
    const body = await c.req.json().catch(() => ({}));
    const forwarded = await access.forwardRemote(
      c, projectId, 'PATCH', `/log/${encodeURIComponent(entryId)}`, body,
    );
    if (forwarded) return forwarded;
    const parsed = projectLogUpdateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    const guard = await access.authorize(c, projectId, 'write');
    if (guard instanceof Response) return guard;
    try {
      const entry = await log.update(projectId, entryId, {
        text: parsed.data.text,
        updatedBy: guard.userId,
      });
      await publishProjectUpdated(
        { eventBus: opts.eventBus, sessionManager: opts.sessionManager },
        projectId,
        'log',
      );
      return c.json({ entry: serializeLogEntry(entry) });
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // DELETE /api/v2/projects/:id/log/:entryId — удалить запись.
  app.delete('/:id/log/:entryId', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    const entryId = c.req.param('entryId');
    const forwarded = await access.forwardRemote(
      c, projectId, 'DELETE', `/log/${encodeURIComponent(entryId)}`,
    );
    if (forwarded) return forwarded;
    const guard = await access.authorize(c, projectId, 'write');
    if (guard instanceof Response) return guard;
    try {
      await log.remove(projectId, entryId);
      await publishProjectUpdated(
        { eventBus: opts.eventBus, sessionManager: opts.sessionManager },
        projectId,
        'log',
      );
      return c.body(null, 204);
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // GET /api/v2/projects/:id/invariants — текст инвариантов + время записи.
  app.get('/:id/invariants', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    const forwarded = await access.forwardRemote(c, projectId, 'GET', '/invariants');
    if (forwarded) return forwarded;
    const guard = await access.authorize(c, projectId, 'read');
    if (guard instanceof Response) return guard;
    try {
      const state = await invariants.get(projectId);
      return c.json({ invariants: state.invariants, updated_at: state.updatedAt });
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // PUT /api/v2/projects/:id/invariants — заменить текст инвариантов.
  app.put('/:id/invariants', auth.requireAuth, async (c) => {
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const forwarded = await access.forwardRemote(c, projectId, 'PUT', '/invariants', body);
    if (forwarded) return forwarded;
    const parsed = projectInvariantsUpdateSchema.safeParse(body);
    if (!parsed.success) return access.jsonInvalid(c, parsed.error.message);
    const guard = await access.authorize(c, projectId, 'write');
    if (guard instanceof Response) return guard;
    try {
      const state = await invariants.set(projectId, parsed.data.invariants);
      await publishProjectUpdated(
        { eventBus: opts.eventBus, sessionManager: opts.sessionManager },
        projectId,
        'invariants',
      );
      return c.json({ invariants: state.invariants, updated_at: state.updatedAt });
    } catch (err) {
      const mapped = serviceError(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}
