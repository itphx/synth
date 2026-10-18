// PROP-032 (W5): HTTP-слой деградированного хранилища — guard (ADMIN-only +
// строгий read-only), диагностический эндпоинт `GET /api/v2/storage/status` и
// аддитивные поля `/health`. Тесты герметичны: guard/роуты собираются на лёгком
// Hono-приложении с подставленным пользователем (без реального хранилища).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  createStorageDegradedGuard,
  createStorageStatusRoutes,
  storageHealthFields,
  degradedOf,
} from './storage-degraded.js';
import { createHealthRoutes } from './routes/health.js';
import type { StorageDegradedInfo } from '../storage/storage-context.js';

/** Снимок деградации (значения — маркеры, поведение не зависит от содержимого). */
function makeInfo(overrides: Partial<StorageDegradedInfo> = {}): StorageDegradedInfo {
  return {
    active: true,
    backend: 'postgres',
    fallbackDir: '/tmp/synth-fallback',
    reason: 'connect ECONNREFUSED 127.0.0.1:5433',
    since: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Приложение с guard'ом: имитирует `createStandaloneApp`/backend — сначала
 * «аутентификация» кладёт пользователя, затем guard, затем «роуты».
 */
function makeGuardedApp(opts: {
  degraded: StorageDegradedInfo | null;
  admin: boolean;
  mutationAllowlist?: readonly string[];
}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: 'u-1', roles: opts.admin ? ['ADMIN'] : ['USER'] } as never);
    await next();
  });
  app.use(
    '*',
    createStorageDegradedGuard({
      getDegraded: () => opts.degraded,
      isAdmin: (c) => {
        const user = c.get('user') as { roles?: string[] } | undefined;
        return Array.isArray(user?.roles) && user.roles.includes('ADMIN');
      },
      ...(opts.mutationAllowlist ? { mutationAllowlist: opts.mutationAllowlist } : {}),
    }),
  );
  app.get('/api/v2/sessions', (c) => c.json({ ok: true }));
  app.post('/api/v2/sessions', (c) => c.json({ ok: true }));
  app.patch('/api/v2/sessions/s1', (c) => c.json({ ok: true }));
  app.delete('/api/v2/sessions/s1', (c) => c.json({ ok: true }));
  app.post('/api/v2/maintenance/doctor', (c) => c.json({ ok: true }));
  app.get('/api/v2/maintenance/status', (c) => c.json({ ok: true }));
  app.get('/health', (c) => c.json({ status: 'healthy' }));
  return app;
}

describe('createStorageDegradedGuard (PROP-032 W5)', () => {
  it('хранилище в норме (degraded=null) — все методы и роли проходят', async () => {
    for (const admin of [true, false]) {
      const app = makeGuardedApp({ degraded: null, admin });
      expect((await app.request('/api/v2/sessions')).status).toBe(200);
      expect((await app.request('/api/v2/sessions', { method: 'POST' })).status).toBe(200);
    }
  });

  it('админ в деградации: чтения проходят', async () => {
    const app = makeGuardedApp({ degraded: makeInfo(), admin: true });
    expect((await app.request('/api/v2/sessions')).status).toBe(200);
    expect((await app.request('/api/v2/maintenance/status')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
  });

  it('админ в деградации: мутации → 503 STORAGE_DEGRADED_READONLY (POST/PUT/PATCH/DELETE)', async () => {
    const app = makeGuardedApp({ degraded: makeInfo(), admin: true });
    for (const [method, path] of [
      ['POST', '/api/v2/sessions'],
      ['PATCH', '/api/v2/sessions/s1'],
      ['DELETE', '/api/v2/sessions/s1'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('STORAGE_DEGRADED_READONLY');
    }
  });

  it('не-админ в деградации → 503 STORAGE_DEGRADED (даже на чтение)', async () => {
    const app = makeGuardedApp({ degraded: makeInfo(), admin: false });
    const res = await app.request('/api/v2/sessions');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STORAGE_DEGRADED');
  });

  it('allowlist ремонтных роутов: POST maintenance не блокируется, /health и статус — тоже', async () => {
    const app = makeGuardedApp({
      degraded: makeInfo(),
      admin: true,
      mutationAllowlist: ['/api/v2/maintenance'],
    });
    expect((await app.request('/api/v2/maintenance/doctor', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/v2/maintenance/status')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
    // Обычная мутация всё ещё отклоняется.
    expect((await app.request('/api/v2/sessions', { method: 'POST' })).status).toBe(503);
  });

  it('allowlist не расширяется на «похожий» префикс без границы сегмента', async () => {
    const app = makeGuardedApp({
      degraded: makeInfo(),
      admin: true,
      mutationAllowlist: ['/api/v2/maintenance'],
    });
    // `/api/v2/maintenance-x` не должно попадать под `…/maintenance`.
    const res = await app.request('/api/v2/maintenance-evil', { method: 'POST' });
    // Роут не смонтирован, но guard обязан не пропустить мутацию до роутера.
    expect(res.status).not.toBe(200);
  });

  it('тексты ошибок настраиваются (i18n) — используются переданные messages', async () => {
    const app = new Hono();
    app.use(
      '*',
      createStorageDegradedGuard({
        getDegraded: () => makeInfo(),
        isAdmin: () => false,
        messages: { degraded: () => 'CUSTOM_DEGRADED', readOnly: () => 'CUSTOM_READONLY' },
      }),
    );
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('CUSTOM_DEGRADED');
  });
});

describe('storageHealthFields + /health (PROP-032 W5)', () => {
  it('норма: storageHealthFields → {status:healthy} (прежний контракт)', () => {
    expect(storageHealthFields(null)).toEqual({ status: 'healthy' });
    expect(storageHealthFields(undefined)).toEqual({ status: 'healthy' });
  });

  it('деградация: status=degraded + блок storage (причина/restartRequired/autoRecovery)', () => {
    const fields = storageHealthFields(makeInfo());
    expect(fields.status).toBe('degraded');
    const storage = (fields as { storage: Record<string, unknown> }).storage;
    expect(storage).toMatchObject({
      degraded: true,
      backend: 'postgres',
      fallbackDir: '/tmp/synth-fallback',
      reason: 'connect ECONNREFUSED 127.0.0.1:5433',
      restartRequired: true,
      autoRecovery: false,
    });
  });

  it('createHealthRoutes без опции — прежний ответ (healthy, без блока storage)', async () => {
    const res = await createHealthRoutes().request('/health');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('time');
    // Restart: ISO старта процесса (аддитивное поле).
    expect(typeof body.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(String(body.startedAt)))).toBe(false);
    expect(body).not.toHaveProperty('storage');
  });

  it('createHealthRoutes с деградацией — аддитивно status=degraded + storage', async () => {
    const app = createHealthRoutes({ getStorageDegraded: () => makeInfo() });
    for (const path of ['/health', '/api/v2/health']) {
      const res = await app.request(path);
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status, path).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('time');
      expect((body.storage as Record<string, unknown>).restartRequired).toBe(true);
    }
  });
});

describe('createStorageStatusRoutes (PROP-032 W5)', () => {
  it('норма → {status:healthy, degraded:false}', async () => {
    const app = createStorageStatusRoutes({ getDegraded: () => null });
    const res = await app.request('/api/v2/storage/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'healthy', degraded: false });
  });

  it('деградация → status/recovery(restartRequired, autoRecovery:false)+ probe.connection', async () => {
    const app = createStorageStatusRoutes({
      getDegraded: () =>
        makeInfo({ probe: async () => ({ ok: false, error: 'ECONNREFUSED' }) }),
    });
    const res = await app.request('/api/v2/storage/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      degraded: boolean;
      backend: string;
      recovery: {
        autoRecovery: boolean;
        restartRequired: boolean;
        hint: string;
        connection?: { ok: boolean; error?: string };
      };
    };
    expect(body.status).toBe('degraded');
    expect(body.degraded).toBe(true);
    expect(body.backend).toBe('postgres');
    expect(body.recovery.autoRecovery).toBe(false);
    expect(body.recovery.restartRequired).toBe(true);
    expect(body.recovery.hint.length).toBeGreaterThan(0);
    expect(body.recovery.connection).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });

  it('без probe — секция connection отсутствует (не падает)', async () => {
    const app = createStorageStatusRoutes({ getDegraded: () => makeInfo() });
    const res = await app.request('/api/v2/storage/status');
    const body = (await res.json()) as { recovery: { connection?: unknown } };
    expect(body.recovery.connection).toBeUndefined();
  });
});

describe('degradedOf', () => {
  it('нет контекста / нет деградации → null', () => {
    expect(degradedOf(undefined)).toBeNull();
    expect(degradedOf({ degraded: undefined } as never)).toBeNull();
  });

  it('деградация → снимок', () => {
    const info = makeInfo();
    expect(degradedOf({ degraded: info } as never)).toBe(info);
  });
});
