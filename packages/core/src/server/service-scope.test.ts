import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { GlobalRole } from '@itphx/synth-shared';
import {
  requireScope,
  requireScopeOrAdminRole,
  checkProjectAccess,
  isProjectAllowed,
  getServiceCredential,
} from './service-scope.js';
import type { ServiceKeyCredential } from '../storage/service-api-key-store.js';

const baseCredential: ServiceKeyCredential = {
  keyId: 'svk_1',
  label: 'svc',
  roles: [GlobalRole.USER],
  scopes: ['events:ingest'],
};

/** Приложение с guard'ом и опциональной установкой serviceKey в контекст. */
function makeApp(cred?: ServiceKeyCredential) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (cred) c.set('serviceKey' as never, cred as never);
    await next();
  });
  app.get('/ingest', requireScope('events:ingest'), (c) => c.json({ ok: true }));
  app.get('/watch', requireScope('events:watch'), (c) => c.json({ ok: true }));
  app.get('/family', requireScope('events:ingest'), (c) => c.json({ ok: true }));
  app.get('/project', (c) => {
    const denied = checkProjectAccess(c, c.req.query('p'));
    if (denied) return denied;
    return c.json({ ok: true });
  });
  return app;
}

describe('requireScope (ADR-052)', () => {
  it('без serviceKey — пропускает (интерактивные креды не ограничиваются)', async () => {
    const app = makeApp();
    expect((await app.request('/watch')).status).toBe(200);
    expect((await app.request('/ingest')).status).toBe(200);
  });

  it('с serviceKey: достаточный scope → 200, недостаточный → 403 SCOPE_REQUIRED', async () => {
    const app = makeApp(baseCredential);
    expect((await app.request('/ingest')).status).toBe(200);
    const denied = await app.request('/watch');
    expect(denied.status).toBe(403);
    const body = await denied.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('wildcard-семейство покрывает свои скоупы', async () => {
    const app = makeApp({ ...baseCredential, scopes: ['events:*'] });
    expect((await app.request('/family')).status).toBe(200);
    expect((await app.request('/watch')).status).toBe(200);
  });
});

describe('requireScopeOrAdminRole (ADR-052)', () => {
  /** Приложение с гейтом «scope или роль ADMIN». */
  function makeAdminApp(cred?: ServiceKeyCredential) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (cred) c.set('serviceKey' as never, cred as never);
      await next();
    });
    app.get('/agents', requireScopeOrAdminRole('automation:install'), (c) => c.json({ ok: true }));
    app.get('/routes', requireScopeOrAdminRole('routes:write', 'automation:install'), (c) => c.json({ ok: true }));
    return app;
  }

  it('без serviceKey — пропускает (интерактивные креды не ограничиваются)', async () => {
    const app = makeAdminApp();
    expect((await app.request('/agents')).status).toBe(200);
    expect((await app.request('/routes')).status).toBe(200);
  });

  it('service-key со scope automation:install → 200', async () => {
    const app = makeAdminApp({ ...baseCredential, scopes: ['automation:install'] });
    expect((await app.request('/agents')).status).toBe(200);
    expect((await app.request('/routes')).status).toBe(200);
  });

  it('service-key с ролью ADMIN проходит и без scope (прежние права не отбираются)', async () => {
    const app = makeAdminApp({ ...baseCredential, roles: [GlobalRole.ADMIN], scopes: [] });
    expect((await app.request('/agents')).status).toBe(200);
    expect((await app.request('/routes')).status).toBe(200);
  });

  it('service-key без scope и без роли ADMIN → 403 SCOPE_REQUIRED', async () => {
    const app = makeAdminApp({ ...baseCredential, scopes: ['addons:install'] });
    const denied = await app.request('/agents');
    expect(denied.status).toBe(403);
    const body = await denied.json() as { error: { code: string } };
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('«любой из»: routes:write открывает запись правил, automation:install — тоже', async () => {
    const byRoute = makeAdminApp({ ...baseCredential, scopes: ['routes:write'] });
    expect((await byRoute.request('/routes')).status).toBe(200);
    const byInstall = makeAdminApp({ ...baseCredential, scopes: ['automation:install'] });
    expect((await byInstall.request('/routes')).status).toBe(200);
    const byAddons = makeAdminApp({ ...baseCredential, scopes: ['addons:install'] });
    expect((await byAddons.request('/routes')).status).toBe(403);
  });
});

describe('isProjectAllowed / checkProjectAccess (ADR-052)', () => {
  it('пусто/отсутствует allowedProjects — разрешено любой проект', () => {
    expect(isProjectAllowed(undefined, 'p1')).toBe(true);
    expect(isProjectAllowed({ allowedProjects: [] }, 'p1')).toBe(true);
    expect(isProjectAllowed({ allowedProjects: [] }, undefined)).toBe(true);
  });

  it('заданный allowedProjects — только проект из списка (fail-closed)', () => {
    expect(isProjectAllowed({ allowedProjects: ['p1'] }, 'p1')).toBe(true);
    expect(isProjectAllowed({ allowedProjects: ['p1'] }, 'p2')).toBe(false);
    expect(isProjectAllowed({ allowedProjects: ['p1'] }, undefined)).toBe(false);
  });

  it('checkProjectAccess: без serviceKey — пропускает; с проекцией — 403 на чужой/пустой', async () => {
    const open = makeApp();
    expect((await open.request('/project?p=p2')).status).toBe(200);

    const cred = { ...baseCredential, allowedProjects: ['p1'] };
    const guarded = makeApp(cred);
    expect((await guarded.request('/project?p=p1')).status).toBe(200);
    expect((await guarded.request('/project?p=p2')).status).toBe(403);
    expect((await guarded.request('/project')).status).toBe(403);
    const body = await (await guarded.request('/project?p=p2')).json() as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_FORBIDDEN');
  });

  it('getServiceCredential: читает serviceKey из контекста', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('serviceKey' as never, baseCredential as never);
      await next();
    });
    app.get('/x', (c) => c.json({ keyId: getServiceCredential(c)?.keyId ?? null }));
    const body = await (await app.request('/x')).json() as { keyId: string | null };
    expect(body.keyId).toBe('svk_1');
  });
});
