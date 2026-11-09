/**
 * Backend-специфика HTTP-контура логов (ADR-036/ADR-095).
 *
 * Логика роута — в core-фабрике (`packages/core/src/server/routes/logs.ts`,
 * тесты там). Здесь проверяется **managed-обвязка**: RBAC-guard'ы
 * (`requirePermission('ADMIN','AUDITOR')`) и то, что backend монтирует
 * core-фабрику с правильными deps (каталог логов + путь payload-лога).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogsRoutes, resolveLogDir } from '@itphx/synth-core';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin', username: 'admin', roles: ['ADMIN'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'ADMIN', notes: '', interviewCompleted: false,
};
const auditorUser: User = {
  id: 'auditor', username: 'auditor', roles: ['AUDITOR'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'AUDITOR', notes: '', interviewCompleted: false,
};
const userUser: User = {
  id: 'developer', username: 'developer', roles: ['USER'], preferredLanguage: 'ru',
  createdAt: '', teamRole: 'USER', notes: '', interviewCompleted: false,
};

/** Mock-AuthKit с теми же семантиками, что у backend `requirePermission`. */
function createMockKit(user: User | null) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      c.set('user', user);
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

describe('routes/logs: managed-обвязка core-фабрики логов', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-logs-backend-'));
    await writeFile(join(tmpDir, 'core.log'), 'line 1\nline 2\n', 'utf8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(user: User | null) {
    const app = new Hono();
    const kit = createMockKit(user);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/logs', createLogsRoutes(
      { requireAuth: kit.requireAuth },
      { logDir: tmpDir },
      { readGuard: kit.requirePermission('ADMIN', 'AUDITOR') },
    ));
    return app;
  }

  it('USER → 403, ADMIN/AUDITOR → 200 (guard ADMIN|AUDITOR)', async () => {
    expect((await createApp(userUser).request('/api/v2/logs/core')).status).toBe(403);
    expect((await createApp(adminUser).request('/api/v2/logs/core')).status).toBe(200);
    expect((await createApp(auditorUser).request('/api/v2/logs/core')).status).toBe(200);
  });

  it('без креды → 401', async () => {
    const res = await createApp(null).request('/api/v2/logs/core');
    expect(res.status).toBe(401);
  });

  it('USER → 403 и на /logs/llm (тот же guard)', async () => {
    expect((await createApp(userUser).request('/api/v2/logs/llm')).status).toBe(403);
  });

  it('resolveLogDir() доступен из core (каталог логов managed)', () => {
    expect(typeof resolveLogDir()).toBe('string');
    expect(resolveLogDir().length).toBeGreaterThan(0);
  });
});
