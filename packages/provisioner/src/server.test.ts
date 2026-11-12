/**
 * HTTP-контракт provisioner'а (PROP-135, Ф4b-2a).
 *
 * Проверяется то, чем пользуется `HttpExecutionPoolProvider` в core:
 * bearer-гард (401), `ensure` + идемпотентность, `touch` (204), `drain` (202),
 * `DELETE` (202/404), лимит пулов (429), `/health` без токена, `/metrics`
 * с токеном и `no-store`, URL-encoded ключ с `:`, диагностический список без
 * токенов пулов.
 */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createProvisionerMetrics, type ProvisionerMetrics } from './metrics.js';
import { PoolService } from './pool-service.js';
import { StaticPoolProvisioner } from './provider.js';
import { createProvisionerApp } from './server.js';
import type { EnsurePoolRequest } from './protocol.js';

// Токен собирается из частей (secret-scan).
const TOKEN = ['provisioner-server', 'token', 'test-1234567890'].join('-');

const PROFILES = {
  default: { url: 'http://executor-default:5100' },
  browser: { url: 'http://browser:4200' },
};

const STATIC_POOLS = {
  'project:p1:exec:default': 'http://executor-p1:5100',
};

interface Harness {
  app: Hono;
  service: PoolService;
  metrics: ProvisionerMetrics;
}

/** Приложение provisioner'а с сервисом в памяти (без сокета). */
function makeHarness(opts: { maxPools?: number } = {}): Harness {
  const maxPools = opts.maxPools ?? 50;
  const provider = new StaticPoolProvisioner(STATIC_POOLS, PROFILES);
  const metrics = createProvisionerMetrics({ profiles: Object.keys(PROFILES) });
  const service = new PoolService({
    provider,
    metrics,
    idleTimeoutMs: 900_000,
    sessionIdleTimeoutMs: 300_000,
    maxLifetimeMs: 43_200_000,
    drainGraceMs: 30_000,
    maxPools,
  });
  metrics.setPoolSource(() => service.list());
  const app = createProvisionerApp({
    token: TOKEN,
    service,
    metrics,
    providerName: 'static',
    limits: {
      maxPools,
      idleTimeoutMs: 900_000,
      sessionIdleTimeoutMs: 300_000,
      maxLifetimeMs: 43_200_000,
      drainGraceMs: 30_000,
    },
  });
  return { app, service, metrics };
}

/** Запрос к приложению; `token: null` — без авторизации. */
function request(
  app: Hono,
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const payload =
    opts.raw !== undefined
      ? opts.raw
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return Promise.resolve(
    app.request(path, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    }),
  );
}

/** Тело `ensure` для проектного пула. */
function ensureBody(overrides: Partial<EnsurePoolRequest> = {}): EnsurePoolRequest {
  return {
    key: 'project:p1:exec:default',
    scope: 'project',
    id: 'p1',
    class: 'exec',
    profile: 'default',
    ...overrides,
  };
}

/** Ошибка из тела ответа. */
async function readError(res: Response): Promise<{ reason: string; message: string }> {
  const body = (await res.json()) as { error: { reason: string; message: string } };
  return body.error;
}

describe('provisioner: аутентификация', () => {
  it('без токена — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: ensureBody(), token: null });
    expect(res.status).toBe(401);
    expect((await readError(res)).reason).toBe('unauthorized');
  });

  it('с неверным токеном — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody(),
      token: 'wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('текст ошибки не содержит ожидаемый токен', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/pools', { token: 'wrong-token' });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('/health — без токена, 200', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/health', { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: 'static' });
  });

  it('неизвестный маршрут с токеном — 404 JSON', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/unknown');
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('not_found');
  });
});

describe('provisioner: ensure', () => {
  it('выдаёт url и токен', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string };
    expect(body.url).toBe('http://executor-p1:5100');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
  });

  it('идемпотентен: тот же url и токен на повторный ключ', async () => {
    const { app } = makeHarness();
    const first = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      url: string;
      token: string;
    };
    const second = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      url: string;
      token: string;
    };
    expect(second).toEqual(first);
  });

  it('по профилю, когда точного ключа нет', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({
        key: 'session:s1:browser:default',
        scope: 'session',
        id: 's1',
        class: 'browser',
        profile: 'browser',
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe('http://browser:4200');
  });

  it('неизвестный профиль — 404 pool_not_found', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key: 'project:p9:exec:missing', id: 'p9', profile: 'missing' }),
    });
    expect(res.status).toBe(404);
    expect((await readError(res)).reason).toBe('pool_not_found');
  });

  it('невалидное тело — 400 invalid_request', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { body: { scope: 'project' } });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('project без id — 400 (изоляция пулов)', async () => {
    const { app } = makeHarness();
    const body = ensureBody();
    delete (body as { id?: string }).id;
    const res = await request(app, 'POST', '/v1/pools', { body });
    expect(res.status).toBe(400);
    expect((await readError(res)).message).toContain('id');
  });

  it('workspaceSubPath: относительный путь принимается, небезопасный — 400', async () => {
    const { app } = makeHarness();
    const ok = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ workspaceSubPath: 'proj-slug/.worktrees/x' }),
    });
    expect(ok.status).toBe(200);
    for (const workspaceSubPath of ['../x', '/abs', 'a//b']) {
      const res = await request(app, 'POST', '/v1/pools', {
        body: ensureBody({ key: 'project:p2:exec:default', id: 'p2', workspaceSubPath }),
      });
      expect(res.status).toBe(400);
      expect((await readError(res)).reason).toBe('invalid_request');
    }
  });

  it('невалидный JSON — 400', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'POST', '/v1/pools', { raw: '__not_json__' });
    expect(res.status).toBe(400);
    expect((await readError(res)).reason).toBe('invalid_request');
  });

  it('превышение MAX_POOLS — 429 capacity', async () => {
    const { app } = makeHarness({ maxPools: 1 });
    expect((await request(app, 'POST', '/v1/pools', { body: ensureBody() })).status).toBe(200);
    const res = await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key: 'project:p2:exec:default', id: 'p2' }),
    });
    expect(res.status).toBe(429);
    expect((await readError(res)).reason).toBe('capacity');
  });
});

describe('provisioner: touch / drain / delete', () => {
  it('touch известного пула — 204, неизвестного — 404', async () => {
    const { app } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const touch = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/touch');
    expect(touch.status).toBe(204);
    const missing = await request(app, 'POST', '/v1/pools/project%3Ap9%3Aexec%3Adefault/touch');
    expect(missing.status).toBe(404);
    expect((await readError(missing)).reason).toBe('not_found');
  });

  it('drain — 202, повторно 202, состояние draining', async () => {
    const { app, service } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const first = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/drain');
    expect(first.status).toBe(202);
    expect(service.get('project:p1:exec:default')?.state).toBe('draining');
    const second = await request(app, 'POST', '/v1/pools/project%3Ap1%3Aexec%3Adefault/drain');
    expect(second.status).toBe(202);
  });

  it('delete — 202 и удаляет пул; повторно — 404', async () => {
    const { app, service } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const first = await request(app, 'DELETE', '/v1/pools/project%3Ap1%3Aexec%3Adefault');
    expect(first.status).toBe(202);
    expect(service.size()).toBe(0);
    const second = await request(app, 'DELETE', '/v1/pools/project%3Ap1%3Aexec%3Adefault');
    expect(second.status).toBe(404);
  });

  it('ключ с «:» в URL-кодировке работает во всех путях', async () => {
    const { app } = makeHarness();
    const key = 'session:s-1:exec:default';
    await request(app, 'POST', '/v1/pools', {
      body: ensureBody({ key, scope: 'session', id: 's-1' }),
    });
    const encoded = encodeURIComponent(key);
    expect((await request(app, 'POST', `/v1/pools/${encoded}/touch`)).status).toBe(204);
    expect((await request(app, 'POST', `/v1/pools/${encoded}/drain`)).status).toBe(202);
    expect((await request(app, 'DELETE', `/v1/pools/${encoded}`)).status).toBe(202);
  });
});

describe('provisioner: диагностика и метрики', () => {
  it('GET /v1/pools — список без токенов пулов', async () => {
    const { app } = makeHarness();
    const ensured = (await (await request(app, 'POST', '/v1/pools', { body: ensureBody() })).json()) as {
      token: string;
    };
    const res = await request(app, 'GET', '/v1/pools');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ensured.token);
    const body = JSON.parse(text) as { pools: Array<{ key: string; state: string }> };
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0]?.key).toBe('project:p1:exec:default');
    expect(body.pools[0]?.state).toBe('ready');
  });

  it('GET /v1/capabilities — провайдер, профили, протокол, лимиты', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/v1/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      profiles: string[];
      protocol: number;
      limits: { maxPools: number };
    };
    expect(body.provider).toBe('static');
    expect(body.profiles.sort()).toEqual(['browser', 'default']);
    expect(body.protocol).toBe(1);
    expect(body.limits.maxPools).toBe(50);
  });

  it('/metrics без токена — 401', async () => {
    const { app } = makeHarness();
    const res = await request(app, 'GET', '/metrics', { token: null });
    expect(res.status).toBe(401);
  });

  it('/metrics с токеном — exposition 0.0.4 и no-store', async () => {
    const { app } = makeHarness();
    await request(app, 'POST', '/v1/pools', { body: ensureBody() });
    const res = await request(app, 'GET', '/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain('# TYPE synth_provisioner_pools gauge');
    expect(text).toContain('synth_provisioner_pools{profile="default",state="ready"} 1');
    expect(text).toContain('synth_provisioner_provision_total{outcome="ok"} 1');
  });
});
