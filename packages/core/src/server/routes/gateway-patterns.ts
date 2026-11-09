import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SecretPattern } from '../../engine/gateway/secret-pattern-store.js';
import type { SecretPatternRepository } from '../../storage/ports/secret-pattern-repository.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface GatewayPatternsRoutesAuth {
  requireAuth: Middleware;
}

export interface GatewayPatternsRouteMessages {
  /** `patterns` — не массив валидных `{type, regex}`. */
  invalidPatterns: (c: Context) => string;
  /** Не удалось сохранить паттерны (store вернул false). */
  saveFailed: (c: Context) => string;
}

export interface GatewayPatternsRoutesOptions {
  /**
   * Guard на все методы (`GET`/`PUT`/`DELETE`).
   * Managed — `requireAdmin`, core — `requireAuth` (локальный пользователь
   * standalone всегда ADMIN).
   */
  adminGuard?: Middleware;
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<GatewayPatternsRouteMessages>;
}

const DEFAULT_MESSAGES: GatewayPatternsRouteMessages = {
  invalidPatterns: () => 'patterns должен быть массивом элементов {type: string, regex: string}',
  saveFailed: () => 'Не удалось сохранить паттерны обфускации',
};

function isValidPattern(p: unknown): p is SecretPattern {
  if (typeof p !== 'object' || p === null) return false;
  const { type, regex } = p as Record<string, unknown>;
  if (typeof type !== 'string' || type.trim() === '') return false;
  if (typeof regex !== 'string') return false;
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

/**
 * LLM Gateway (ADR-036) — управление regex-паттернами детекции секретов.
 *
 * Схема «системный + override»: пользовательский список полностью заменяет
 * дефолтный, DELETE сбрасывает к встроенным паттернам.
 *
 * Общая реализация для core (standalone) и backend (managed): отличается
 * только guard'ом (managed — ADMIN, core — requireAuth).
 */
export function createGatewayPatternsRoutes(
  auth: GatewayPatternsRoutesAuth,
  store: SecretPatternRepository,
  opts: GatewayPatternsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const adminGuard = opts.adminGuard ?? auth.requireAuth;
  const messages: GatewayPatternsRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  // GET /api/v2/gateway/patterns — текущий список + признак override + дефолт
  app.get('/patterns', adminGuard, (c) => {
    const raw = store.getRawPatterns();
    return c.json({
      patterns: raw.patterns,
      is_overridden: raw.isOverridden,
      default_patterns: raw.defaultPatterns,
    });
  });

  // PUT /api/v2/gateway/patterns — сохранить override-список
  app.put('/patterns', adminGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const patterns: unknown = (body as { patterns?: unknown })?.patterns;

    if (!Array.isArray(patterns) || !patterns.every(isValidPattern)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: messages.invalidPatterns(c) },
      }, 400);
    }

    const ok = await store.savePatterns(patterns as SecretPattern[]);
    if (!ok) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: messages.saveFailed(c) },
      }, 400);
    }

    return c.json({ patterns: store.getPatterns(), is_overridden: true, saved: true });
  });

  // DELETE /api/v2/gateway/patterns — сброс к дефолтным паттернам
  app.delete('/patterns', adminGuard, async (c) => {
    await store.reset();
    return c.json({ status: 'restored' });
  });

  return app;
}
