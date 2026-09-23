import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createDebugRoutes } from './debug.js';
import { getAllGroups, resetGroupOverrides } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin',
  username: 'admin',
  roles: ['ADMIN'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'ADMIN',
  notes: '',
  interviewCompleted: false,
};

const userUser: User = {
  id: 'developer',
  username: 'developer',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

function createMockKit(user: User) {
  return {
    requireAuth: async (c: Context, next: Next) => {
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
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const u = c.get('user') as User | undefined;
      if (!u || !roles.some((r) => u.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
      }
      await next();
    },
    getCurrentUser: () => user,
  };
}

function createApp(user: User) {
  const app = new Hono();
  const kit = createMockKit(user);
  app.use('*', kit.requireAuth);
  app.route('/api/v2/admin/debug', createDebugRoutes(kit as any));
  return app;
}

function postConfig(app: Hono, groups?: Record<string, string>) {
  return app.request('/api/v2/admin/debug/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(groups === undefined ? {} : { groups }),
  });
}

describe('Debug Config API Routes', () => {
  beforeEach(() => {
    resetGroupOverrides();
  });

  describe('POST /api/v2/admin/debug/config', () => {
    it('сохраняет переданные группы (merge)', async () => {
      const res = await postConfig(createApp(adminUser), { ROUTES: 'DEBUG' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'saved' });
      expect(getAllGroups().ROUTES).toBe('DEBUG');
    });

    it('не сбрасывает overrides другой категории', async () => {
      const app = createApp(adminUser);
      await postConfig(app, { OPENAI: 'DEBUG', ANTHROPIC: 'ERROR' });
      await postConfig(app, { ROUTES: 'DEBUG', STORAGE: 'ERROR' });

      const groups = getAllGroups();
      expect(groups.OPENAI).toBe('DEBUG');
      expect(groups.ANTHROPIC).toBe('ERROR');
      expect(groups.ROUTES).toBe('DEBUG');
      expect(groups.STORAGE).toBe('ERROR');
    });

    it('возвращает 400 VALIDATION_ERROR без groups', async () => {
      const res = await postConfig(createApp(adminUser));
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('возвращает 400 на невалидный уровень', async () => {
      const res = await postConfig(createApp(adminUser), { ROUTES: 'TRACE' });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(getAllGroups().ROUTES).toBe('WARNING');
    });

    it('недоступен для USER (403)', async () => {
      const res = await postConfig(createApp(userUser), { ROUTES: 'DEBUG' });
      expect(res.status).toBe(403);
    });
  });
});
