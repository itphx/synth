/**
 * ADR-090 Ф7 (Уровень 2): guard server-scoped токена плагина.
 *
 * Ключ с привязкой `plugin_id` (token, выданный `POST /api/v2/plugins/token`)
 * сервер принимает только если:
 * 1. запрос несёт заголовок `X-Synth-Plugin-Id` **и** его значение совпадает
 *    с `plugin_id` ключа (иначе 403 `PLUGIN_ID_MISMATCH`);
 * 2. у ключа есть scope `plugins:invoke` (иначе 403 `SCOPE_REQUIRED`);
 * 3. `plugin_id` входит в серверный allow-list — при
 *    `plugins.hybrid.mode='allowlist'` (иначе 403 `PLUGIN_NOT_ALLOWED`).
 *
 * Правило **fail-closed**: ключ с привязкой без корректного заголовка
 * отвергается всегда. Guard стоит на границе (после резолва service-креда),
 * поэтому действует на все серверные API — в тесте это обычный роут.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';

import { requirePluginTokenBinding } from './plugin-scope.js';

/** Контекст service-креда: привязка к плагину + scope'ы. */
interface MockServiceKey {
  keyId: string;
  label: string;
  roles: string[];
  scopes: string[];
  pluginId?: string;
}

/** Креды по значению заголовка `Authorization`. */
function serviceKeyFromHeader(header: string | undefined): MockServiceKey | null {
  if (header === 'Bearer svc-plugin') {
    return {
      keyId: 'service:svc1',
      label: 'plugin:demo',
      roles: ['USER'],
      scopes: ['plugins:invoke'],
      pluginId: 'demo-plugin',
    };
  }
  if (header === 'Bearer svc-plugin-other') {
    return {
      keyId: 'service:svc2',
      label: 'plugin:other',
      roles: ['USER'],
      scopes: ['plugins:invoke'],
      pluginId: 'other-plugin',
    };
  }
  if (header === 'Bearer svc-plugin-noscope') {
    return {
      keyId: 'service:svc3',
      label: 'plugin:noscope',
      roles: ['USER'],
      scopes: ['events:ingest'],
      pluginId: 'demo-plugin',
    };
  }
  if (header === 'Bearer svc-plain') {
    return {
      keyId: 'service:svc4',
      label: 'plain',
      roles: ['USER'],
      scopes: ['events:ingest'],
    };
  }
  return null;
}

/** Приложение с guard'ом на обычном серверном роуте. */
function makeApp(policy?: { mode: 'off' | 'allowlist'; allow: string[] }): Hono {
  const app = new Hono();
  // Мок глобального `attachUser` (как в реальном backend): service-кредентал
  // кладётся в контекст, guard только читает.
  app.use('*', async (c: Context, next: Next) => {
    const svc = serviceKeyFromHeader(c.req.header('Authorization'));
    if (svc) {
      c.set('user', { id: `service:${svc.keyId}`, username: svc.label, roles: svc.roles });
      c.set('serviceKey', svc);
    }
    await next();
  });
  app.use('/api/*', requirePluginTokenBinding(() => policy));
  app.get('/api/v2/ping', (c) => c.json({ ok: true }));
  return app;
}

/** Запрос к защищённому роуту. */
function call(
  app: Hono,
  opts: { auth?: string; pluginId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.Authorization = opts.auth;
  if (opts.pluginId) headers['X-Synth-Plugin-Id'] = opts.pluginId;
  return Promise.resolve(app.request('/api/v2/ping', { headers }));
}

/** Код ошибки ответа. */
async function codeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body?.error?.code ?? '';
}

describe('requirePluginTokenBinding — server-scoped токен плагина (Ф7, Уровень 2)', () => {
  it('корректный токен: заголовок совпадает, scope есть, плагин в allow-list → запрос проходит', async () => {
    const app = makeApp({ mode: 'allowlist', allow: ['demo-plugin'] });
    const res = await call(app, { auth: 'Bearer svc-plugin', pluginId: 'demo-plugin' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('чужая привязка: заголовок X-Synth-Plugin-Id не совпадает с plugin_id ключа → 403', async () => {
    const app = makeApp({ mode: 'allowlist', allow: ['demo-plugin', 'other-plugin'] });
    const res = await call(app, { auth: 'Bearer svc-plugin', pluginId: 'other-plugin' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('PLUGIN_ID_MISMATCH');
  });

  it('без заголовка X-Synth-Plugin-Id → 403 (fail-closed)', async () => {
    const app = makeApp({ mode: 'allowlist', allow: ['demo-plugin'] });
    const res = await call(app, { auth: 'Bearer svc-plugin' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('PLUGIN_ID_MISMATCH');
  });

  it('ключ без scope plugins:invoke → 403 SCOPE_REQUIRED', async () => {
    const app = makeApp({ mode: 'allowlist', allow: ['demo-plugin'] });
    const res = await call(app, { auth: 'Bearer svc-plugin-noscope', pluginId: 'demo-plugin' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SCOPE_REQUIRED');
  });

  it('plugin_id вне серверного allow-list → 403 PLUGIN_NOT_ALLOWED', async () => {
    const app = makeApp({ mode: 'allowlist', allow: ['demo-plugin'] });
    const res = await call(app, { auth: 'Bearer svc-plugin-other', pluginId: 'other-plugin' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('PLUGIN_NOT_ALLOWED');
  });

  it('обычный service-key (без привязки к плагину) — проверка не применяется', async () => {
    const app = makeApp({ mode: 'allowlist', allow: [] });
    const res = await call(app, { auth: 'Bearer svc-plain' });
    expect(res.status).toBe(200);
  });

  it('интерактивный запрос (нет service-креда) — проверка не применяется', async () => {
    const app = makeApp({ mode: 'allowlist', allow: [] });
    const res = await call(app);
    expect(res.status).toBe(200);
  });

  it('режим off: сервер не ограничивает — корректный токен проходит', async () => {
    const app = makeApp({ mode: 'off', allow: [] });
    const res = await call(app, { auth: 'Bearer svc-plugin-other', pluginId: 'other-plugin' });
    expect(res.status).toBe(200);
  });
});
