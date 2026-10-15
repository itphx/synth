import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';

/**
 * In-memory rate limiter.
 * Ключ — Authorization header (уникален для каждого пользователя/ключа).
 * `message` — опциональный резолвер локализованного текста (i18n); по умолчанию —
 * общий русский текст (обратная совместимость).
 */
export function createRateLimiter(
  maxRequests = 20,
  windowMs = 60_000,
  message?: (c: Context) => string,
) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);

  return createMiddleware(async (c, next) => {
    const key = c.req.header('Authorization')
      || c.req.header('x-forwarded-for')
      || 'anonymous';
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: message ? message(c) : 'Превышен лимит запросов' } },
        429,
      );
    }

    await next();
  });
}
