/**
 * In-memory rate limiter: динамический порог, отключение лимита и `Retry-After`.
 *
 * Контракт: `maxRequests` может быть геттером (порог читается на каждый
 * запрос), `<= 0` — без ограничения, на 429 — `Retry-After` (целые секунды,
 * минимум 1). Обратная совместимость числового порога обязательна.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter } from './rate-limiter.js';

function makeApp(limiter: ReturnType<typeof createRateLimiter>): Hono {
  const app = new Hono();
  app.get('/x', limiter, (c) => c.json({ ok: true }));
  return app;
}

const auth = { Authorization: 'Bearer test-key' };

describe('createRateLimiter — динамический порог', () => {
  it('числовой порог (обратная совместимость): 2 запроса, третий — 429', async () => {
    const app = makeApp(createRateLimiter(2, 60_000));
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(429);
  });

  it('геттер меняет порог на лету', async () => {
    let limit = 1;
    const app = makeApp(createRateLimiter(() => limit, 60_000));
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(429);
    // runtime-изменение (как из админки) применяется без пересоздания лимитера.
    // Счётчик не сбрасывается: после двух запросов порог 4 даёт ещё два.
    limit = 4;
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(429);
  });

  it('0 отключает лимит (счётчик не ведётся)', async () => {
    let limit = 0;
    const app = makeApp(createRateLimiter(() => limit, 60_000));
    for (let i = 0; i < 50; i += 1) {
      expect((await app.request('/x', { headers: auth })).status).toBe(200);
    }
    // Включили лимит — счётчик чист, первый запрос проходит.
    limit = 2;
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(200);
    expect((await app.request('/x', { headers: auth })).status).toBe(429);
  });

  it('отрицательный порог отключает лимит', async () => {
    const app = makeApp(createRateLimiter(-5, 60_000));
    for (let i = 0; i < 10; i += 1) {
      expect((await app.request('/x', { headers: auth })).status).toBe(200);
    }
  });

  it('429 несёт Retry-After (целые секунды, минимум 1)', async () => {
    const app = makeApp(createRateLimiter(1, 60_000));
    await app.request('/x', { headers: auth });
    const res = await app.request('/x', { headers: auth });
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    // Тело ответа не изменилось.
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
