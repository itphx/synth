/**
 * Backend-специфика HTTP-контура конфигурации групп логирования (debug-раздел).
 *
 * Логика роута — в core-фабрике (`packages/core/src/server/routes/debug.ts`,
 * тесты там). Здесь — managed-обвязка: guard `requireAdmin` на обоих методах
 * и локализованные тексты ошибок (i18n, ADR-041).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createDebugRoutes } from '@itphx/synth-core';
import { getAllGroups, resetGroupOverrides } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin', username: 'admin', roles: ['ADMIN'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'ADMIN', notes: '', interviewCompleted: false,
};
const userUser: User = {
  id: 'developer', username: 'developer', roles: ['USER'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'USER', notes: '', interviewCompleted: false,
};

function createMockKit(user: User | null) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      c.set('user', user);
      await next();
    },
    requireAdmin: async (c: Context, next: Next) => {
      const u = c.get('user') as User | undefined;
      if (!u || !u.roles.includes('ADMIN')) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
      }
      await next();
    },
    getCurrentUser: () => user,
  };
}

describe('routes/debug: managed-обвязка core-фабрики debug-конфига', () => {
  beforeEach(() => {
    resetGroupOverrides();
  });

  function createApp(user: User | null) {
    const app = new Hono();
    const kit = createMockKit(user);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/admin/debug', createDebugRoutes(
      { requireAuth: kit.requireAuth },
      {
        adminGuard: kit.requireAdmin,
        messages: {
          groupsRequired: (c) => t('errors.validation.groupsRequired', undefined, c),
          generic: (c) => t('errors.generic', undefined, c),
        },
      },
    ));
    return app;
  }

  function postConfig(app: Hono, groups?: Record<string, string>) {
    return app.request('/api/v2/admin/debug/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(groups === undefined ? {} : { groups }),
    });
  }

  it('USER → 403 на обоих методах (guard ADMIN)', async () => {
    const app = createApp(userUser);
    expect((await app.request('/api/v2/admin/debug/config')).status).toBe(403);
    expect((await postConfig(app, { ROUTES: 'DEBUG' })).status).toBe(403);
  });

  it('ADMIN → 200; группы сохраняются', async () => {
    const res = await postConfig(createApp(adminUser), { ROUTES: 'DEBUG' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'saved' });
    expect(getAllGroups().ROUTES).toBe('DEBUG');
  });

  it('текст ошибки локализован (i18n, ADR-041)', async () => {
    const res = await postConfig(createApp(adminUser));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe(t('errors.validation.groupsRequired'));
  });

  it('без креды → 401', async () => {
    const res = await createApp(null).request('/api/v2/admin/debug/config');
    expect(res.status).toBe(401);
  });
});
