import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { GlobalRole } from '@itphx/synth-shared';
import type { AuthConfig, User } from '@itphx/synth-shared';
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

// Аудит F5: единый API-ключ (`auth.apiKey`) вне debug/OIDC.
// - неверный ключ (любой длины) → 401 UNAUTHORIZED, без падений;
// - верный ключ → пользователь `api`;
// - роли — только явной настройкой `apiKeyRoles`, по умолчанию USER (не ADMIN).
describe('API Key mode (аудит F5)', () => {
  const API_KEY = 'instance-secret-key';

  const makeApp = (over: Partial<AuthConfig> = {}): Hono => {
    const auth = createAuthMiddleware({
      debugMode: false,
      sessionMaxAgeMinutes: 60,
      apiKey: API_KEY,
      ...over,
    });
    const app = new Hono();
    app.use('*', auth.attachUser);
    app.get('/me', auth.requireAuth, (c) => c.json(c.get('user' as never) as User));
    app.get('/admin', auth.requireAdmin, (c) => c.json({ ok: true }));
    return app;
  };

  const call = (app: Hono, path: string, token?: string): Promise<Response> =>
    Promise.resolve(app.request(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }));

  it('верный ключ → пользователь api с ролью USER по умолчанию', async () => {
    const res = await call(makeApp(), '/me', API_KEY);
    expect(res.status).toBe(200);
    const user = (await res.json()) as User;
    expect(user.id).toBe('api');
    expect(user.username).toBe('api');
    expect(user.roles).toEqual([GlobalRole.USER]);
    expect(user.teamRole).toBe(GlobalRole.USER);
  });

  it('по умолчанию api-key НЕ получает ADMIN', async () => {
    const res = await call(makeApp(), '/admin', API_KEY);
    expect(res.status).toBe(403);
  });

  it('неверный ключ одинаковой длины → 401', async () => {
    const res = await call(makeApp(), '/me', 'instance-secret-keY');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('неверный ключ другой длины → 401 (без падения)', async () => {
    const short = await call(makeApp(), '/me', 'short');
    expect(short.status).toBe(401);
    const long = await call(makeApp(), '/me', `${API_KEY}-extra-longer`);
    expect(long.status).toBe(401);
  });

  it('без заголовка Authorization → 401', async () => {
    const res = await call(makeApp(), '/me');
    expect(res.status).toBe(401);
  });

  it('явная настройка apiKeyRoles: ADMIN,USER → роль и доступ к ADMIN-роуту', async () => {
    const app = makeApp({ apiKeyRoles: [GlobalRole.ADMIN, GlobalRole.USER] });
    const me = await call(app, '/me', API_KEY);
    const user = (await me.json()) as User;
    expect(user.roles).toEqual([GlobalRole.ADMIN, GlobalRole.USER]);
    expect(user.teamRole).toBe(GlobalRole.ADMIN);
    expect((await call(app, '/admin', API_KEY)).status).toBe(200);
  });

  it('явная настройка apiKeyRoles: только USER → ADMIN-роут закрыт', async () => {
    const app = makeApp({ apiKeyRoles: [GlobalRole.USER] });
    expect((await call(app, '/admin', API_KEY)).status).toBe(403);
  });

  it('debug-режим сохраняет роли тестовых пользователей (admin-key-123 → ADMIN)', async () => {
    const auth = createAuthMiddleware({
      debugMode: true,
      sessionMaxAgeMinutes: 60,
      apiKey: API_KEY,
      testUsers: [{ username: 'admin', apiKey: 'admin-key-123', roles: ['ADMIN'], displayName: 'Admin' }],
    });
    const app = new Hono();
    app.use('*', auth.attachUser);
    app.get('/me', auth.requireAuth, (c) => c.json(c.get('user' as never) as User));
    const res = await call(app, '/me', 'admin-key-123');
    const user = (await res.json()) as User;
    expect(user.roles).toEqual(['ADMIN']);
    expect(user.isTestUser).toBe(true);
  });
});
