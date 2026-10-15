import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  webhookSubscriptionCreateSchema,
  webhookSubscriptionUpdateSchema,
} from '@itphx/synth-shared';
import { WebhookConflictError } from '../../storage/webhook-store.js';
import type { WebhookStore } from '../../storage/webhook-store.js';
import type { WebhookDeliveryStore } from '../../storage/webhook-delivery-store.js';
import type { WebhookService } from '../../engine/webhooks/service.js';
import { evaluateWebhookTarget } from '../../engine/webhooks/network.js';

/**
 * ADR-052 (этап II): CRUD подписок на исходящие webhooks + журнал доставок +
 * тестовая доставка. Единая реализация для core (standalone) и backend
 * (managed): RBAC задаётся `opts.writeGuard`/`opts.readGuard`, локализация —
 * `opts.messages`.
 *
 * Signing-секрет (`whsec_…`) отдаётся только в ответах `POST /` и
 * `POST /:id/regenerate`; в списке/деталях — `secretPrefix`.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface WebhookRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface WebhookRouteMessages {
  invalid: (c: Context) => string;
  notFound: (c: Context) => string;
  labelConflict: (c: Context) => string;
  targetForbidden: (c: Context) => string;
  disabled: (c: Context) => string;
}

export interface WebhookRoutesDeps {
  store: WebhookStore;
  deliveryStore: WebhookDeliveryStore;
  /** Движок доставки — для `POST /:id/test`. Не передан — тест недоступен. */
  service?: WebhookService;
}

export interface WebhookRoutesOptions {
  messages?: Partial<WebhookRouteMessages>;
  /** Guard на мутации (POST/PATCH/DELETE/revoke/regenerate/test); дефолт — `requireAuth`. */
  writeGuard?: Middleware;
  /** Guard на чтение (GET); дефолт — `requireAuth`. */
  readGuard?: Middleware;
  /** userId создателя подписки. Core — 'local'; backend — user.id. */
  resolveUserId?: (c: Context) => string;
  /** Мастер-выключатель доставки (`webhooks.enabled`). `false` → 503 на мутации/тест. */
  isEnabled?: () => boolean;
  /** Разрешить http/приватные адреса (`webhooks.allowPrivateTargets`). */
  allowPrivateTargets?: boolean;
}

const DEFAULT_MESSAGES: WebhookRouteMessages = {
  invalid: () => 'Некорректное тело webhook-подписки',
  notFound: () => 'Webhook-подписка не найдена',
  labelConflict: (c) => {
    const label = (c.get('webhookConflictLabel' as never) as string | undefined) ?? '';
    return label ? `Метка webhook уже используется: ${label}` : 'Метка webhook уже используется';
  },
  targetForbidden: (c) => {
    const reason = (c.get('webhookTargetReason' as never) as string | undefined) ?? '';
    return reason || 'Целевой URL webhook запрещён политикой безопасности';
  },
  disabled: () => 'Доставка webhooks отключена',
};

const DELIVERIES_LIMIT_DEFAULT = 50;
const DELIVERIES_LIMIT_MAX = 500;

/** id текущего пользователя из контекста (`unknown` в core без RBAC). */
function currentUserId(c: Context, resolveUserId?: (c: Context) => string): string {
  if (resolveUserId) return resolveUserId(c);
  const user = c.get('user' as never) as { id?: unknown } | undefined;
  return typeof user?.id === 'string' && user.id ? user.id : 'unknown';
}

/**
 * ADR-052 (этап II): `GET /` — список; `POST /` — создание (секрет единожды);
 * `GET /:id`; `PATCH /:id`; `DELETE /:id`; `POST /:id/regenerate` — ротация
 * секрета; `POST /:id/revoke` — мягкое отключение; `POST /:id/test` — тестовая
 * доставка; `GET /:id/deliveries` — журнал. Конфликт метки → 409 `CONFLICT`;
 * невалидный/запрещённый URL → 400 `VALIDATION_ERROR`; мастер выключен → 503.
 */
export function createWebhookRoutes(
  auth: WebhookRoutesAuth,
  deps: WebhookRoutesDeps,
  opts: WebhookRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: WebhookRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const allowPrivateTargets = opts.allowPrivateTargets ?? false;

  // Мастер-выключатель (`webhooks.enabled`): по умолчанию выключено — как config default.
  const enabled = (): boolean => opts.isEnabled?.() ?? false;

  const invalid = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalid(c) } }, 400);

  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.notFound(c) } }, 404);

  const disabled = (c: Context) =>
    c.json({ error: { code: 'UNAVAILABLE', message: messages.disabled(c) } }, 503);

  const conflict = (c: Context, label: string) => {
    c.set('webhookConflictLabel' as never, label as never);
    return c.json({ error: { code: 'CONFLICT', message: messages.labelConflict(c) } }, 409);
  };

  const targetForbidden = (c: Context, reason: string) => {
    c.set('webhookTargetReason' as never, reason as never);
    return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.targetForbidden(c) } }, 400);
  };

  /** Проверяет целевой URL политикой SSRF/https; `null` — допустим. */
  const ensureTargetAllowed = async (c: Context, url: string): Promise<Response | null> => {
    const check = await evaluateWebhookTarget(url, { allowPrivateTargets });
    if (check.allowed) return null;
    return targetForbidden(c, check.reason ?? 'Целевой URL запрещён');
  };

  // GET /api/v2/webhooks — список подписок (без секретов).
  app.get('/', readGuard, async (c) => {
    const subscriptions = await deps.store.list();
    return c.json({ subscriptions });
  });

  // POST /api/v2/webhooks — создание подписки (секрет — единожды).
  app.post('/', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }
    const parsed = webhookSubscriptionCreateSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const denied = await ensureTargetAllowed(c, parsed.data.url);
    if (denied) return denied;

    try {
      const created = await deps.store.create(parsed.data, currentUserId(c, opts.resolveUserId));
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof WebhookConflictError) return conflict(c, err.label);
      throw err;
    }
  });

  // GET /api/v2/webhooks/:id — метаданные подписки.
  app.get('/:id', readGuard, async (c) => {
    const sub = await deps.store.get(c.req.param('id'));
    if (!sub) return notFound(c);
    return c.json(sub);
  });

  // PATCH /api/v2/webhooks/:id — обновление подписки.
  app.patch('/:id', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }
    const parsed = webhookSubscriptionUpdateSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    if (parsed.data.url !== undefined) {
      const denied = await ensureTargetAllowed(c, parsed.data.url);
      if (denied) return denied;
    }

    try {
      const updated = await deps.store.update(c.req.param('id'), parsed.data);
      if (!updated) return notFound(c);
      return c.json(updated);
    } catch (err) {
      if (err instanceof WebhookConflictError) return conflict(c, err.label);
      throw err;
    }
  });

  // DELETE /api/v2/webhooks/:id — удаление подписки.
  app.delete('/:id', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);
    const removed = await deps.store.remove(c.req.param('id'));
    if (!removed) return notFound(c);
    return c.body(null, 204);
  });

  // POST /api/v2/webhooks/:id/regenerate — ротация signing-секрета (единожды).
  app.post('/:id/regenerate', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);
    const rotated = await deps.store.regenerateSecret(c.req.param('id'));
    if (!rotated) return notFound(c);
    return c.json(rotated);
  });

  // POST /api/v2/webhooks/:id/revoke — мягкое отключение подписки (идемпотентно).
  app.post('/:id/revoke', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);
    const sub = await deps.store.setEnabled(c.req.param('id'), false);
    if (!sub) return notFound(c);
    return c.json(sub);
  });

  // POST /api/v2/webhooks/:id/test — тестовая доставка.
  app.post('/:id/test', writeGuard, async (c) => {
    if (!enabled()) return disabled(c);
    if (!deps.service) return notFound(c);
    const delivery = await deps.service.deliverTest(c.req.param('id'));
    if (!delivery) return notFound(c);
    return c.json(delivery);
  });

  // GET /api/v2/webhooks/:id/deliveries?limit= — журнал доставок (default 50, cap 500).
  app.get('/:id/deliveries', readGuard, async (c) => {
    const id = c.req.param('id');
    if (!(await deps.store.get(id))) return notFound(c);
    const raw = c.req.query('limit');
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    const limit = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, DELIVERIES_LIMIT_MAX)
      : DELIVERIES_LIMIT_DEFAULT;
    const deliveries = await deps.deliveryStore.listBySubscription(id, limit);
    return c.json({ deliveries });
  });

  return app;
}
