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
import { requireAdminOrScope, requireAdminRoleOrScope } from './guards.js';

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

// Семантика HTTP у комбинированного guard'а: без service-key и без пользователя
// (аноним) → 401 UNAUTHORIZED, а не 403; аутентифицирован без ADMIN → 403 FORBIDDEN.
describe('requireAdminOrScope — 401 без аутентификации (ADR-052)', () => {
  const app = new Hono();
  app.get('/guard', requireAdminOrScope('addons:install'), (c) => c.json({ ok: true }));

  const call = (auth?: string): Promise<Response> =>
    Promise.resolve(app.request('/guard', {
      headers: auth ? { Authorization: auth } : {},
    }));

  it('без cred и без пользователя → 401 UNAUTHORIZED', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});

/**
 * ADR-052: guard «роль ADMIN **или** scope» (`requireAdminRoleOrScope`).
 *
 * Отличие от `requireAdminOrScope`: у service-key учитывается **и** роль ADMIN
 * среди выданных ролей — зонтичный scope не отбирает прежние права ключа с
 * ролью ADMIN. Интерактивные креды — по-прежнему требуют роль ADMIN
 * (401 без аутентификации, 403 без роли).
 */
describe('requireAdminRoleOrScope — ADMIN или scope (ADR-052)', () => {
  const app = new Hono();

  // Мок глобального `attachUser` (как в реальном backend, `src/app.ts:255`):
  // пользователь и service-key кладутся в контекст, guard'ы только читают.
  app.use('*', async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    if (header === 'Bearer svc-install') {
      c.set('user', { id: 'service:svc1', username: 'installer', roles: ['USER'] });
      c.set('serviceKey', {
        keyId: 'service:svc1',
        label: 'installer',
        roles: ['USER'],
        scopes: ['automation:install'],
      });
    } else if (header === 'Bearer svc-admin') {
      c.set('user', { id: 'service:svc2', username: 'installer-admin', roles: ['ADMIN'] });
      c.set('serviceKey', {
        keyId: 'service:svc2',
        label: 'installer-admin',
        roles: ['ADMIN'],
        scopes: [],
      });
    } else if (header === 'Bearer svc-plain') {
      c.set('user', { id: 'service:svc3', username: 'plain', roles: ['USER'] });
      c.set('serviceKey', {
        keyId: 'service:svc3',
        label: 'plain',
        roles: ['USER'],
        scopes: [],
      });
    } else if (header === 'Bearer admin') {
      c.set('user', { id: 'admin', username: 'admin', roles: ['ADMIN'] });
    } else if (header === 'Bearer dev') {
      c.set('user', { id: 'dev', username: 'dev', roles: ['USER'] });
    }
    await next();
  });

  app.post('/guard', requireAdminRoleOrScope('automation:install'), (c) => c.json({ ok: true }));

  const post = (auth?: string): Promise<Response> =>
    Promise.resolve(app.request('/guard', {
      method: 'POST',
      headers: auth ? { Authorization: auth } : {},
    }));

  it('service-key со scope из списка → 200', async () => {
    const res = await post('Bearer svc-install');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('service-key с ролью ADMIN и без scope → 200 (прежние права не отбираются)', async () => {
    const res = await post('Bearer svc-admin');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('service-key без scope и без роли ADMIN → 403 SCOPE_REQUIRED', async () => {
    const res = await post('Bearer svc-plain');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('интерактивный пользователь без роли ADMIN → 403 FORBIDDEN', async () => {
    const res = await post('Bearer dev');
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('интерактивный ADMIN → 200', async () => {
    const res = await post('Bearer admin');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('анонимный запрос → 401 UNAUTHORIZED', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
