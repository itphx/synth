/**
 * Backend-специфика HTTP-контура regex-паттернов LLM Gateway (ADR-036).
 *
 * Логика роута — в core-фабрике (`packages/core/src/server/routes/gateway-patterns.ts`,
 * тесты там). Здесь — managed-обвязка: guard `requireAdmin` на всех методах.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayPatternsRoutes } from '@itphx/synth-core';
import { SecretPatternStore } from '@itphx/synth-core';
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

describe('routes/gateway-patterns: managed-обвязка core-фабрики паттернов', () => {
  let tmpDir: string;
  let store: SecretPatternStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gw-patterns-backend-'));
    store = new SecretPatternStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(user: User | null) {
    const app = new Hono();
    const kit = createMockKit(user);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/gateway', createGatewayPatternsRoutes(
      { requireAuth: kit.requireAuth },
      store,
      { adminGuard: kit.requireAdmin },
    ));
    return app;
  }

  it('USER → 403 на всех методах (guard ADMIN)', async () => {
    const app = createApp(userUser);
    expect((await app.request('/api/v2/gateway/patterns')).status).toBe(403);
    expect((await app.request('/api/v2/gateway/patterns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patterns: [] }),
    })).status).toBe(403);
    expect((await app.request('/api/v2/gateway/patterns', { method: 'DELETE' })).status).toBe(403);
  });

  it('ADMIN → 200 на всех методах', async () => {
    const app = createApp(adminUser);
    expect((await app.request('/api/v2/gateway/patterns')).status).toBe(200);
    expect((await app.request('/api/v2/gateway/patterns', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patterns: [] }),
    })).status).toBe(200);
    expect((await app.request('/api/v2/gateway/patterns', { method: 'DELETE' })).status).toBe(200);
  });

  it('без креды → 401', async () => {
    const res = await createApp(null).request('/api/v2/gateway/patterns');
    expect(res.status).toBe(401);
  });
});
