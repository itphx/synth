/**
 * ADR-052/O1: запись скиллов — guard «ADMIN или scope `addons:install`»
 * (backend передаёт `writeGuard` в core-фабрику `createSkillRoutes`).
 * Проверяем на `POST /reload` (простейшая мутация): service-key со scope
 * проходит, без scope — 403 SCOPE_REQUIRED, интерактивный не-ADMIN — 403.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createSkillRoutes } from '@itphx/synth-core';
import { requireAdminOrScope } from './guards.js';

interface MockUser {
  id: string;
  username: string;
  roles: string[];
}

function serviceKeyFromHeader(
  header: string | undefined,
): { user: MockUser; scopes: string[] } | null {
  if (header === 'Bearer svc-scope') {
    return { user: { id: 'service:svc1', username: 'installer', roles: ['USER'] }, scopes: ['addons:install'] };
  }
  if (header === 'Bearer svc-noscope') {
    return { user: { id: 'service:svc2', username: 'installer', roles: ['USER'] }, scopes: [] };
  }
  return null;
}

describe('backend skills writeGuard — ADMIN или scope addons:install (ADR-052/O1)', () => {
  let app: Hono;
  const reload = vi.fn();

  beforeEach(() => {
    reload.mockClear();

    const kit = {
      requireAuth: async (c: Context, next: Next) => {
        const svc = serviceKeyFromHeader(c.req.header('Authorization'));
        if (svc) {
          c.set('user', svc.user);
          c.set('serviceKey', {
            keyId: svc.user.id,
            label: svc.user.username,
            roles: svc.user.roles,
            scopes: svc.scopes,
          });
          await next();
          return;
        }
        const header = c.req.header('Authorization');
        if (header === 'Bearer admin') c.set('user', { id: 'admin', username: 'admin', roles: ['ADMIN'] });
        else if (header === 'Bearer dev') c.set('user', { id: 'dev', username: 'dev', roles: ['USER'] });
        if (!c.get('user')) return c.json({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401);
        await next();
      },
    };

    app = new Hono();
    app.route('/api/v2/skills', createSkillRoutes(
      kit as never,
      { skillService: { reload } as never },
      { writeGuard: requireAdminOrScope('addons:install') },
    ));
  });

  const post = async (auth?: string): Promise<Response> =>
    app.request('/api/v2/skills/reload', {
      method: 'POST',
      headers: auth ? { Authorization: auth } : {},
    });

  it('service-key со scope → 200', async () => {
    const res = await post('Bearer svc-scope');
    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalled();
  });

  it('service-key без scope → 403 SCOPE_REQUIRED', async () => {
    const res = await post('Bearer svc-noscope');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
    expect(reload).not.toHaveBeenCalled();
  });

  it('интерактивный не-ADMIN → 403 FORBIDDEN', async () => {
    const res = await post('Bearer dev');
    expect(res.status).toBe(403);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ADMIN → 200', async () => {
    const res = await post('Bearer admin');
    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalled();
  });
});
