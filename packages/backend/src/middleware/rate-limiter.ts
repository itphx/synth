import { createMiddleware } from 'hono/factory';

/**
 * In-memory rate limiter.
 * Ограничивает количество запросов с одного IP за интервал.
 */
export function createRateLimiter(maxRequests = 20, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Периодическая очистка истёкших записей
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);

  return createMiddleware(async (c, next) => {
    const key = c.req.header('x-forwarded-for') || 'anonymous';
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Превышен лимит запросов' } },
        429,
      );
    }

    await next();
  });
}
