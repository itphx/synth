import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { eventBindingInputSchema, eventIngestSchema } from '@itphx/synth-shared';
import type { EventIngress } from '../../engine/events/ingest.js';
import type { EventBindingStore } from '../../storage/event-binding-store.js';
import type { EventJournalStore } from '../../storage/event-journal-store.js';

/**
 * AD-089: маршруты приёма внешних событий и управления биндингами.
 * Единая реализация для core (standalone) и backend (managed): RBAC и rate limit
 * задаются через `opts.ingestGuard`/`opts.writeGuard`.
 *
 * ВАЖНО: `GET /` намеренно не определяется — на этом пути в core/backend живёт
 * SSE-хаб (`GET /api/v2/events`).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface EventRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface EventRouteMessages {
  invalidEvent: (c: Context) => string;
  invalidBinding: (c: Context) => string;
  bindingNotFound: (c: Context) => string;
}

export interface EventRoutesDeps {
  ingress: EventIngress;
  bindingStore: EventBindingStore;
  journal: EventJournalStore;
}

export interface EventRoutesOptions {
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<EventRouteMessages>;
  /** Guard на мутации биндингов; по умолчанию — `requireAuth` (backend: requireAdmin). */
  writeGuard?: Middleware;
  /** Guard на приём события; по умолчанию — `requireAuth` (backend: auth + rate limit). */
  ingestGuard?: Middleware;
}

const DEFAULT_MESSAGES: EventRouteMessages = {
  invalidEvent: () => 'Некорректное тело события',
  invalidBinding: () => 'Некорректное тело биндинга',
  bindingNotFound: () => 'Биндинг не найден',
};

const JOURNAL_LIMIT_DEFAULT = 50;
const JOURNAL_LIMIT_MAX = 500;

export function createEventRoutes(
  auth: EventRoutesAuth,
  deps: EventRoutesDeps,
  opts: EventRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: EventRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  // Дефолты — requireAuth: в core RBAC не требуется, в backend передаются
  // requireAdmin/rate limit явно.
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const ingestGuard: Middleware = opts.ingestGuard ?? auth.requireAuth;

  // POST /api/v2/events — приём внешнего события (ingress).
  app.post('/', ingestGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
    }

    const parsed = eventIngestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidEvent(c) } }, 400);
    }

    try {
      const { event, decision, session } = await deps.ingress.ingest(parsed.data);
      // Наружу — без внутренних полей сессии, только id.
      return c.json({ event, decision, sessionId: session?.id ?? null }, 201);
    } catch (err) {
      return c.json({
        error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      }, 500);
    }
  });

  // GET /api/v2/events/bindings — список биндингов.
  app.get('/bindings', auth.requireAuth, async (c) => {
    const bindings = await deps.bindingStore.list();
    return c.json({ bindings });
  });

  // POST /api/v2/events/bindings — upsert биндинга (по source+chatKey/threadKey).
  app.post('/bindings', writeGuard, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBinding(c) } }, 400);
    }

    const parsed = eventBindingInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBinding(c) } }, 400);
    }

    const input = parsed.data;
    // Существующую привязку по ключу заменяем (id сохраняется) — это upsert.
    const existing = input.threadKey || input.chatKey
      ? await deps.bindingStore.findByKey({
          source: input.source,
          chatKey: input.chatKey,
          threadKey: input.threadKey,
        })
      : null;
    const binding = await deps.bindingStore.upsert({ ...input, id: existing?.id });
    return c.json(binding, existing ? 200 : 201);
  });

  // DELETE /api/v2/events/bindings/:id — удаление биндинга.
  app.delete('/bindings/:id', writeGuard, async (c) => {
    const removed = await deps.bindingStore.remove(c.req.param('id'));
    if (!removed) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.bindingNotFound(c) } }, 404);
    }
    return c.body(null, 204);
  });

  // GET /api/v2/events/journal?limit= — последние записи журнала (default 50, cap 500).
  app.get('/journal', auth.requireAuth, async (c) => {
    const raw = c.req.query('limit');
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    const limit = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, JOURNAL_LIMIT_MAX)
      : JOURNAL_LIMIT_DEFAULT;
    const entries = await deps.journal.list(limit);
    return c.json({ entries });
  });

  return app;
}
