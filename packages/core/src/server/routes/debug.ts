import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { getAllGroups, setGroups, LOG_LEVEL_NAMES } from '../../logger.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface DebugRoutesAuth {
  requireAuth: Middleware;
}

export interface DebugRouteMessages {
  /** Тело без `groups`. */
  groupsRequired: (c: Context) => string;
  /** Прочие ошибки сохранения. */
  generic: (c: Context) => string;
}

export interface DebugRoutesOptions {
  /**
   * Guard на оба метода. Managed — `requireAdmin`, core — `requireAuth`
   * (локальный пользователь standalone всегда ADMIN).
   */
  adminGuard?: Middleware;
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<DebugRouteMessages>;
}

const DEFAULT_MESSAGES: DebugRouteMessages = {
  groupsRequired: () => 'groups обязательны',
  generic: () => 'Ошибка',
};

/**
 * Конфигурация групп логирования (debug-раздел админки).
 *
 * Общая реализация для core (standalone) и backend (managed): отличается
 * только guard'ом (managed — ADMIN, core — requireAuth) и текстами.
 */
export function createDebugRoutes(
  auth: DebugRoutesAuth,
  opts: DebugRoutesOptions = {},
): Hono {
  const app = new Hono();
  const adminGuard = opts.adminGuard ?? auth.requireAuth;
  const messages: DebugRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  // GET /config — группы логирования + уровни
  app.get('/config', adminGuard, async (c) => {
    return c.json({
      groups: getAllGroups(),
      available_levels: LOG_LEVEL_NAMES,
    });
  });

  // POST /config — сохранить конфигурацию групп логирования
  app.post('/config', adminGuard, async (c) => {
    const body = await c.req.json<{ groups?: Record<string, string> }>().catch(() => ({ groups: undefined }));
    if (!body.groups) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: messages.groupsRequired(c) },
      }, 400);
    }

    try {
      setGroups(body.groups);
      return c.json({ status: 'saved' });
    } catch (err) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err instanceof Error ? err.message : messages.generic(c),
        },
      }, 400);
    }
  });

  return app;
}
