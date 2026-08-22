import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayPatternsRoutes } from './gateway-patterns.js';
import { SecretPatternStore, DEFAULT_PATTERNS } from '@itphx/synth-core';
import type { SecretPattern } from '@itphx/synth-core';
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

function defaultAsStrings(): SecretPattern[] {
  return DEFAULT_PATTERNS.map((p) => ({
    type: p.type,
    regex: typeof p.regex === 'string' ? p.regex : p.regex.source,
  }));
}

const customPatterns: SecretPattern[] = [
  { type: 'custom', regex: '\\bsk-custom-[A-Za-z0-9]{20,}' },
  { type: 'my_token', regex: '\\btok_[A-Za-z0-9]{32}\\b' },
];

describe('Gateway Patterns API Routes (AD-036)', () => {
  let tmpDir: string;
  let store: SecretPatternStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gw-patterns-'));
    store = new SecretPatternStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(user: User) {
    const app = new Hono();
    const kit = createMockKit(user);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/gateway', createGatewayPatternsRoutes(kit as any, store));
    return app;
  }

  describe('GET /api/v2/gateway/patterns', () => {
    it('без override возвращает дефолтные паттерны (9) и is_overridden=false', async () => {
      const res = await createApp(adminUser).request('/api/v2/gateway/patterns');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.is_overridden).toBe(false);
      expect(body.patterns).toEqual(defaultAsStrings());
      expect(body.patterns).toHaveLength(9);
      expect(body.default_patterns).toEqual(defaultAsStrings());
    });

    it('с override возвращает сохранённые паттерны и is_overridden=true', async () => {
      await store.savePatterns(customPatterns);
      const res = await createApp(adminUser).request('/api/v2/gateway/patterns');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.is_overridden).toBe(true);
      expect(body.patterns).toEqual(customPatterns);
      expect(body.default_patterns).toEqual(defaultAsStrings());
    });

    it('недоступен для USER (403)', async () => {
      const res = await createApp(userUser).request('/api/v2/gateway/patterns');
      expect(res.status).toBe(403);
      const body: any = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('PUT /api/v2/gateway/patterns', () => {
    it('сохраняет валидный список: 200, is_overridden=true, store обновлён', async () => {
      const res = await createApp(adminUser).request('/api/v2/gateway/patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: customPatterns }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.saved).toBe(true);
      expect(body.is_overridden).toBe(true);
      expect(body.patterns).toEqual(customPatterns);
      expect(store.hasOverride()).toBe(true);
      expect(store.getPatterns()).toEqual(customPatterns);
    });

    it('отклоняет невалидный regex: 400 VALIDATION_ERROR', async () => {
      const res = await createApp(adminUser).request('/api/v2/gateway/patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: [{ type: 'bad', regex: '(' }] }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(store.hasOverride()).toBe(false);
    });

    it('отклоняет не-массив и элемент без type: 400 VALIDATION_ERROR', async () => {
      const notArray = await createApp(adminUser).request('/api/v2/gateway/patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: { type: 'x', regex: 'a{2}' } }),
      });
      expect(notArray.status).toBe(400);

      const emptyType = await createApp(adminUser).request('/api/v2/gateway/patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: [{ type: '', regex: 'a{2}' }] }),
      });
      expect(emptyType.status).toBe(400);
      expect(store.hasOverride()).toBe(false);
    });

    it('недоступен для USER (403)', async () => {
      const res = await createApp(userUser).request('/api/v2/gateway/patterns', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns: customPatterns }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v2/gateway/patterns', () => {
    it('сбрасывает override: status=restored, is_overridden=false, store=дефолт', async () => {
      await store.savePatterns(customPatterns);
      expect(store.hasOverride()).toBe(true);

      const res = await createApp(adminUser).request('/api/v2/gateway/patterns', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ status: 'restored' });
      expect(store.hasOverride()).toBe(false);
      expect(store.getPatterns()).toEqual(defaultAsStrings());
    });

    it('идемпотентен: DELETE без override тоже 200', async () => {
      const res = await createApp(adminUser).request('/api/v2/gateway/patterns', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(store.getPatterns()).toEqual(defaultAsStrings());
    });

    it('недоступен для USER (403)', async () => {
      const res = await createApp(userUser).request('/api/v2/gateway/patterns', { method: 'DELETE' });
      expect(res.status).toBe(403);
    });
  });
});
