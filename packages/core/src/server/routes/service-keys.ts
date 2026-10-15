import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  GlobalRole,
  SERVICE_SCOPES,
  SERVICE_SCOPE_FAMILIES,
  serviceApiKeyCreateSchema,
  serviceApiKeyUpdateSchema,
} from '@itphx/synth-shared';
import { ServiceApiKeyConflictError } from '../../storage/service-api-key-store.js';
import type { ServiceKeyRepository } from '../../storage/ports/service-key-repository.js';

/**
 * ADR-052 (этап I): CRUD service-key инстанса. Единая реализация для core
 * (standalone) и backend (managed): RBAC задаётся через `opts.writeGuard`/
 * `opts.readGuard`, локализация — через `opts.messages`.
 *
 * Плейнтекст-секрет (`synth_svc_…`) отдаётся только в ответе `POST /` — при
 * создании; в списке/деталях — `prefix`.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface ServiceKeyRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface ServiceKeyRouteMessages {
  invalidKey: (c: Context) => string;
  keyNotFound: (c: Context) => string;
  keyLabelConflict: (c: Context) => string;
}

export interface ServiceKeyRoutesDeps {
  store: ServiceKeyRepository;
}

export interface ServiceKeyRoutesOptions {
  messages?: Partial<ServiceKeyRouteMessages>;
  /** Guard на мутации (POST/PATCH/DELETE/revoke); по умолчанию — `requireAuth`. */
  writeGuard?: Middleware;
  /** Guard на чтение (GET); по умолчанию — `requireAuth`. */
  readGuard?: Middleware;
  /** userId создателя ключа. Core — 'local'; backend — user.id. */
  resolveUserId?: (c: Context) => string;
}

const DEFAULT_MESSAGES: ServiceKeyRouteMessages = {
  invalidKey: () => 'Некорректное тело service-key',
  keyNotFound: () => 'Service-key не найден',
  keyLabelConflict: (c) => {
    const label = (c.get('serviceKeyConflictLabel' as never) as string | undefined) ?? '';
    return label ? `Метка service-key уже используется: ${label}` : 'Метка service-key уже используется';
  },
};

/** id текущего пользователя из контекста (`unknown` в core без RBAC). */
function currentUserId(c: Context, resolveUserId?: (c: Context) => string): string {
  if (resolveUserId) return resolveUserId(c);
  const user = c.get('user' as never) as { id?: unknown } | undefined;
  return typeof user?.id === 'string' && user.id ? user.id : 'unknown';
}

/**
 * ADR-052: `GET /` — список; `GET /scopes` — каталог scope'ов/ролей; `POST /` —
 * создание (секрет единожды); `GET /:id`; `PATCH /:id`; `DELETE /:id`;
 * `POST /:id/revoke` — мягкий отзыв (идемпотентно).
 * Конфликт метки → 409 `CONFLICT`; невалидные scope/role → 400 `VALIDATION_ERROR`.
 */
export function createServiceKeyRoutes(
  auth: ServiceKeyRoutesAuth,
  deps: ServiceKeyRoutesDeps,
  opts: ServiceKeyRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: ServiceKeyRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;

  const invalid = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKey(c) } }, 400);

  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.keyNotFound(c) } }, 404);

  const conflict = (c: Context, label: string) => {
    c.set('serviceKeyConflictLabel' as never, label as never);
    return c.json({ error: { code: 'CONFLICT', message: messages.keyLabelConflict(c) } }, 409);
  };

  // GET /api/v2/service-keys — список ключей (без секретов).
  app.get('/', readGuard, async (c) => {
    const keys = await deps.store.list();
    return c.json({ keys });
  });

  // POST /api/v2/service-keys — создание ключа (секрет — единожды).
  app.post('/', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }

    const parsed = serviceApiKeyCreateSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    try {
      const created = await deps.store.create(parsed.data, currentUserId(c, opts.resolveUserId));
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof ServiceApiKeyConflictError) return conflict(c, err.label);
      throw err;
    }
  });

  // GET /api/v2/service-keys/scopes — каталог для форм/клиентов.
  // ВАЖНО: объявлен ДО параметрического `/:id`, иначе `/:id` перехватит
  // литерал `scopes` как id. Источник — shared (`SERVICE_SCOPES`/
  // `SERVICE_SCOPE_FAMILIES`/`GlobalRole`), списки здесь НЕ дублируются:
  // каталог — серверная сущность, UI не должен компилировать его в бандл.
  // Гвард — тот же `readGuard`, что у `GET /` (паритет доступа).
  app.get('/scopes', readGuard, (c) =>
    c.json({
      scopes: [...SERVICE_SCOPES],
      families: [...SERVICE_SCOPE_FAMILIES],
      roles: Object.values(GlobalRole),
    }),
  );

  // GET /api/v2/service-keys/:id — метаданные ключа.
  app.get('/:id', readGuard, async (c) => {
    const key = await deps.store.get(c.req.param('id'));
    if (!key) return notFound(c);
    return c.json(key);
  });

  // PATCH /api/v2/service-keys/:id — обновление метаданных.
  app.patch('/:id', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }

    const parsed = serviceApiKeyUpdateSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    try {
      const updated = await deps.store.update(c.req.param('id'), parsed.data);
      if (!updated) return notFound(c);
      return c.json(updated);
    } catch (err) {
      if (err instanceof ServiceApiKeyConflictError) return conflict(c, err.label);
      throw err;
    }
  });

  // DELETE /api/v2/service-keys/:id — удаление ключа.
  app.delete('/:id', writeGuard, async (c) => {
    const removed = await deps.store.remove(c.req.param('id'));
    if (!removed) return notFound(c);
    return c.body(null, 204);
  });

  // POST /api/v2/service-keys/:id/revoke — мягкий отзыв (идемпотентно).
  app.post('/:id/revoke', writeGuard, async (c) => {
    const id = c.req.param('id');
    const revoked = await deps.store.revoke(id);
    if (!revoked) return notFound(c);
    const key = await deps.store.get(id);
    return c.json(key);
  });

  return app;
}
