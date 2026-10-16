import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { isSessionCookieSecure, createAuthMiddleware } from './middleware.js';

// Cookie сессии: `Secure` по умолчанию; отключается только явным opt-out
// `SYNTH_COOKIE_INSECURE=true` (локальная http-разработка).
describe('isSessionCookieSecure', () => {
  it('по умолчанию (пустое окружение) → true', () => {
    expect(isSessionCookieSecure({})).toBe(true);
  });

  it('NODE_ENV=production → true', () => {
    expect(isSessionCookieSecure({ NODE_ENV: 'production' })).toBe(true);
  });

  it('NODE_ENV=development без opt-out → true (Secure по умолчанию)', () => {
    expect(isSessionCookieSecure({ NODE_ENV: 'development' })).toBe(true);
  });

  it('SYNTH_COOKIE_INSECURE=true → false (явный opt-out)', () => {
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: 'true' })).toBe(false);
  });

  it('SYNTH_COOKIE_INSECURE=false/иное значение → true', () => {
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: 'false' })).toBe(true);
    expect(isSessionCookieSecure({ SYNTH_COOKIE_INSECURE: '1' })).toBe(true);
  });
});

// Ролевые guard'ы: семантика HTTP — нет аутентификации → 401 UNAUTHORIZED,
// аутентифицирован без роли → 403 FORBIDDEN. Проверяем на реальном
// `createAuthMiddleware` (debug-ключи) поверх `attachUser`, как в приложении.
describe('requireAdmin / requirePermission — 401 vs 403', () => {
  const auth = createAuthMiddleware({
    debugMode: true,
    sessionMaxAgeMinutes: 60,
    testUsers: [
      { username: 'admin', apiKey: 'admin-key-123', roles: ['ADMIN'], displayName: 'Admin' },
      { username: 'developer', apiKey: 'user-key-456', roles: ['USER'], displayName: 'Developer' },
      { username: 'lead', apiKey: 'lead-key-789', roles: ['LEAD'], displayName: 'Lead' },
      { username: 'auditor', apiKey: 'auditor-key-012', roles: ['AUDITOR'], displayName: 'Auditor' },
    ],
  });

  const app = new Hono();
  app.use('*', auth.attachUser);
  app.get('/admin', auth.requireAdmin, (c) => c.json({ ok: true }));
  app.get('/permission', auth.requirePermission('ADMIN', 'AUDITOR'), (c) => c.json({ ok: true }));

  const call = (path: string, token?: string): Promise<Response> =>
    Promise.resolve(app.request(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }));

  describe('requireAdmin', () => {
    it('без пользователя → 401 UNAUTHORIZED', async () => {
      const res = await call('/admin');
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    });

    it('пользователь без роли ADMIN → 403 FORBIDDEN', async () => {
      const res = await call('/admin', 'user-key-456');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('ADMIN → проходит', async () => {
      const res = await call('/admin', 'admin-key-123');
      expect(res.status).toBe(200);
    });
  });

  describe('requirePermission(ADMIN, AUDITOR)', () => {
    it('без пользователя → 401 UNAUTHORIZED', async () => {
      const res = await call('/permission');
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    });

    it('роль LEAD (не в списке) → 403 FORBIDDEN', async () => {
      const res = await call('/permission', 'lead-key-789');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('роль AUDITOR → проходит', async () => {
      const res = await call('/permission', 'auditor-key-012');
      expect(res.status).toBe(200);
    });
  });
});
