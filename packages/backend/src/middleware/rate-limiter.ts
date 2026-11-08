import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';

/**
 * In-memory rate limiter.
 * Ключ — Authorization header (уникален для каждого пользователя/ключа).
 * `maxRequests` — число запросов в окно; может быть **геттером** — тогда порог
 * вычисляется на каждый запрос (runtime-настройка без рестарта). `<= 0` —
 * без ограничения (счётчик не ведётся).
 * `message` — опциональный резолвер локализованного текста (i18n); по умолчанию —
 * общий русский текст (обратная совместимость).
 */
export function createRateLimiter(
  maxRequests: number | (() => number) = 20,
  windowMs = 60_000,
  message?: (c: Context) => string,
) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref?.();

  return createMiddleware(async (c, next) => {
    // Порог вычисляется на каждый запрос: динамический геттер позволяет
    // применять runtime-изменение из админки без пересоздания middleware.
    const limit = typeof maxRequests === 'function' ? maxRequests() : maxRequests;
    if (limit <= 0) {
      await next();
      return;
    }

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

    if (entry.count > limit) {
      // Аддитивный заголовок: клиенту полезно знать, когда пробовать снова.
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: { code: 'RATE_LIMITED', message: message ? message(c) : 'Превышен лимит запросов' } },
        429,
      );
    }

    await next();
  });
}
