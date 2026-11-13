/**
 * PROP-135 слайс 6b-1: профили и пулы исполнения
 * (`/api/v2/execution/*`).
 *
 * Проверяется контракт HTTP-контура, а не provisioner (его сервис — Ф4b-2):
 *
 * - DTO профилей: провайдер/пулинг/каталог из `ResolvedExecutionConfig`;
 * - пулы: `http` — `list()` провайдера, `static` — профили как `configured`,
 *   `inline` — пусто; недоступный провайдер — `503`;
 * - `drain`/`release`: `202`, URL-encoded ключ, `404` для неизвестного пула,
 *   `400` для невалидного ключа, `503` без провайдера;
 * - **секреты не отдаются**: ни адрес пула, ни токен provisioner'а;
 * - guard'ы по умолчанию — `requireAuth` на всех маршрутах (без
 *   аутентификации `401`); профили и пулы имеют **разные** guard'ы (managed
 *   открывает каталог профилей всем аутентифицированным).
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { createExecutionRoutes } from './execution.js';
import type {
  ExecutionPoolKey,
  ExecutionPoolProvider,
  PoolInfo,
} from '../../execution/pool-provider.js';
import { poolKeyString } from '../../execution/pool-provider.js';
import type { ExecutionRouter } from '../../execution/router.js';
import type { ExecutionPort } from '../../execution/ports/index.js';

/** Полный профиль секции `execution.remote` (значения не важны для роутов). */
function remoteConfig(
  overrides: Partial<ResolvedExecutionConfig['remote']> = {},
): ResolvedExecutionConfig {
  const profile = { url: ['http://executor:8080'], timeoutMs: 30_000, concurrency: 2, failMode: 'fail' as const };
  return {
    mode: 'remote',
    remote: {
      url: ['http://executor:8080'],
      timeoutMs: 30_000,
      concurrency: 2,
      failMode: 'fail',
      tokenSecret: '/secrets/executor-token',
      pooling: 'project',
      defaultProfile: 'default',
      browserProfile: 'browser',
      browserMcpServer: 'playwright',
      profiles: { default: { ...profile }, devops: { ...profile } },
      fallback: 'instance',
      provider: 'http',
      provisioner: {
        url: 'http://provisioner:8080',
        tokenSecret: '/secrets/provisioner-token',
        timeoutMs: 5_000,
      },
      ...overrides,
    },
  };
}

/** Заглушка провайдера пулов: запись вызовов + управляемые сбои. */
interface FakeProvider extends ExecutionPoolProvider {
  drained: string[];
  released: string[];
}

function fakeProvider(opts: {
  pools?: PoolInfo[];
  listThrows?: boolean;
  drainThrows?: boolean;
  releaseThrows?: boolean;
  withList?: boolean;
} = {}): FakeProvider {
  const drained: string[] = [];
  const released: string[] = [];
  const provider: FakeProvider = {
    drained,
    released,
    ensure: async () => ({ url: 'http://pool-1:8080', token: 'pool-token' }),
    drain: async (key: ExecutionPoolKey) => {
      if (opts.drainThrows) throw new Error('provisioner down');
      drained.push(poolKeyString(key));
    },
    release: async (key: ExecutionPoolKey) => {
      if (opts.releaseThrows) throw new Error('provisioner down');
      released.push(poolKeyString(key));
    },
  };
  if (opts.withList !== false) {
    provider.list = async () => {
      if (opts.listThrows) throw new Error('provisioner down');
      return opts.pools ?? [];
    };
  }
  return provider;
}

/** Заглушка роутера: каталог профилей + провайдер пулов. */
function routerStub(opts: {
  provider?: ExecutionPoolProvider;
  profiles?: string[];
  defaultProfile?: string;
} = {}): ExecutionRouter {
  return {
    portFor: () => ({}) as ExecutionPort,
    ...(opts.profiles ? { profiles: () => opts.profiles! } : {}),
    ...(opts.defaultProfile ? { defaultProfile: () => opts.defaultProfile! } : {}),
    ...(opts.provider ? { poolProvider: () => opts.provider } : {}),
  };
}

/** AuthKit-заглушка: `requireAuth` на 401 без пользователя (как в core). */
function authKit(authenticated = true) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!authenticated) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      await next();
    },
  };
}

/** Приложение с роутами исполнения (без глобального auth-гейта). */
function appWith(
  deps: Parameters<typeof createExecutionRoutes>[1],
  authenticated = true,
): Hono {
  const app = new Hono();
  app.route('/api/v2/execution', createExecutionRoutes(authKit(authenticated), deps));
  return app;
}

const httpProviderPool: PoolInfo = {
  key: 'project:prj_1:exec:default',
  profile: 'default',
  state: 'ready',
  createdAt: '2026-11-12T09:00:00.000Z',
  lastUsedAt: '2026-11-12T09:30:00.000Z',
};

describe('PROP-135 Ф6b-1: GET /api/v2/execution/profiles', () => {
  it('http: провайдер, пулинг и каталог профилей из конфигурации', async () => {
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ profiles: ['default', 'devops'], defaultProfile: 'default' }),
    });
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: 'http',
      pooling: 'project',
      defaultProfile: 'default',
      profiles: ['default', 'devops'],
      // Роутер без `profilesInfo`/провайдера: детали — только имена каталога.
      details: [{ name: 'default' }, { name: 'devops' }],
    });
  });

  it('http: детали профилей из провайдера (без env и секретов)', async () => {
    const provider = fakeProvider();
    provider.profilesInfo = async () => [
      {
        name: 'default',
        description: 'Базовый исполнитель',
        image: 'registry.example/synth-executor:latest',
        network: 'restricted',
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
    ];
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { details: unknown[] };
    expect(body.details).toEqual([
      {
        name: 'default',
        description: 'Базовый исполнитель',
        image: 'registry.example/synth-executor:latest',
        network: 'restricted',
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('/secrets/');
    expect(text).not.toContain('pool-token');
  });

  it('http: сбой метаданных провайдера — 200 и пустые details (имена остаются)', async () => {
    const provider = fakeProvider();
    provider.profilesInfo = async () => {
      throw new Error('provisioner down');
    };
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: string[]; details: unknown[] };
    expect(body.profiles).toEqual(['default', 'devops']);
    expect(body.details).toEqual([]);
  });

  it('static: провайдер static, каталог без роутера — из конфигурации', async () => {
    const config = remoteConfig({ provider: 'static', pooling: 'session' });
    const app = appWith({ executionConfig: config });
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: 'static',
      pooling: 'session',
      defaultProfile: 'default',
      profiles: ['default', 'devops'],
      // `static`: известны только имена — образа/сети у адреса нет.
      details: [{ name: 'default' }, { name: 'devops' }],
    });
  });

  it('static: details — метаданные профилей из config.profiles', async () => {
    const config = remoteConfig({
      provider: 'static',
      pooling: 'session',
      profiles: {
        default: {
          url: ['http://executor:8080'],
          timeoutMs: 30_000,
          concurrency: 2,
          failMode: 'fail',
          description: 'Инстанс-исполнитель test',
          image: 'synth-executor:0.13.9-full',
          network: 'restricted',
          resources: { limits: { cpu: '2', memory: '4Gi' } },
          runtimeClass: 'gvisor',
          mcpServers: ['playwright'],
        },
        devops: {
          url: ['http://executor-devops:8080'],
          timeoutMs: 30_000,
          concurrency: 2,
          failMode: 'fail',
        },
      },
    });
    const app = appWith({ executionConfig: config });
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profiles: string[];
      details: unknown[];
    };
    expect(body.profiles).toEqual(['default', 'devops']);
    expect(body.details).toEqual([
      {
        name: 'default',
        description: 'Инстанс-исполнитель test',
        image: 'synth-executor:0.13.9-full',
        network: 'restricted',
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
      { name: 'devops' },
    ]);
    const text = JSON.stringify(body);
    // Секреты и адреса пулов в details не попадают.
    expect(text).not.toContain('http://');
    expect(text).not.toContain('/secrets/');
  });

  it('inline: секции нет — пустой каталог, пулинг instance', async () => {
    const app = appWith({});
    const res = await app.request('/api/v2/execution/profiles');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      details: [],
    });
  });

  it('секреты не отдаются: ни адреса исполнителя, ни provisioner-токена', async () => {
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ profiles: ['default'], defaultProfile: 'default' }),
    });
    const text = await (await app.request('/api/v2/execution/profiles')).text();
    expect(text).not.toContain('http://executor');
    expect(text).not.toContain('http://provisioner');
    expect(text).not.toContain('/secrets/');
    expect(text).not.toContain('pool-token');
  });
});

describe('PROP-135 Ф6b-1: GET /api/v2/execution/pools', () => {
  it('http: пулы провайдера, без адреса и токена', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request('/api/v2/execution/pools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; pools: PoolInfo[] };
    expect(body.provider).toBe('http');
    expect(body.pools).toEqual([
      { key: 'project:prj_1:exec:default', profile: 'default', state: 'ready', createdAt: httpProviderPool.createdAt, lastUsedAt: httpProviderPool.lastUsedAt },
    ]);
    const text = JSON.stringify(body);
    const pool = body.pools[0] as unknown as Record<string, unknown>;
    expect(pool).not.toHaveProperty('url');
    expect(pool).not.toHaveProperty('token');
    expect(text).not.toContain('pool-token');
  });

  it('static: профили конфигурации как configured (ключа пула нет)', async () => {
    const config = remoteConfig({ provider: 'static' });
    const app = appWith({
      executionConfig: config,
      executionRouter: routerStub({ profiles: ['default', 'devops'], defaultProfile: 'default' }),
    });
    const res = await app.request('/api/v2/execution/pools');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: 'static',
      pools: [
        { profile: 'default', state: 'configured' },
        { profile: 'devops', state: 'configured' },
      ],
    });
  });

  it('inline: пулов нет — 200 с пустым списком', async () => {
    const app = appWith({});
    const res = await app.request('/api/v2/execution/pools');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: 'inline', pools: [] });
  });

  it('http: сбой провайдера → 503 EXECUTION_PROVIDER_UNAVAILABLE', async () => {
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider: fakeProvider({ listThrows: true }) }),
    });
    const res = await app.request('/api/v2/execution/pools');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });

  it('http: провайдер не умеет list → 503', async () => {
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider: fakeProvider({ withList: false }) }),
    });
    expect((await app.request('/api/v2/execution/pools')).status).toBe(503);
  });

  it('http: провайдера нет у роутера (instance-пулинг) → 503', async () => {
    const app = appWith({
      executionConfig: remoteConfig({ pooling: 'instance' }),
      executionRouter: routerStub(),
    });
    expect((await app.request('/api/v2/execution/pools')).status).toBe(503);
  });
});

describe('PROP-135 Ф6b-1: drain и release пулов', () => {
  const encoded = encodeURIComponent(httpProviderPool.key!);

  it('drain: 202, ключ из пути (URL-encoded) доезжает до провайдера', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request(`/api/v2/execution/pools/${encoded}/drain`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(provider.drained).toEqual([httpProviderPool.key]);
  });

  it('drain: неизвестный ключ реестра → 404 NOT_FOUND', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const other = encodeURIComponent('session:ses_9:exec:default');
    const res = await app.request(`/api/v2/execution/pools/${other}/drain`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(provider.drained).toEqual([]);
  });

  it('drain: реестр неизвестен (list без ключей) — 202, без ложного 404', async () => {
    const provider = fakeProvider({ pools: [{ profile: 'default', state: 'configured' }] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request(`/api/v2/execution/pools/${encoded}/drain`, { method: 'POST' });
    expect(res.status).toBe(202);
  });

  it('drain: невалидный ключ → 400 VALIDATION_ERROR', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const res = await app.request('/api/v2/execution/pools/not-a-key/drain', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('drain: без провайдера (inline) → 503', async () => {
    const app = appWith({});
    const res = await app.request(`/api/v2/execution/pools/${encoded}/drain`, { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('drain: сбой провайдера → 503', async () => {
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({
        provider: fakeProvider({ pools: [httpProviderPool], drainThrows: true }),
      }),
    });
    expect(
      (await app.request(`/api/v2/execution/pools/${encoded}/drain`, { method: 'POST' })).status,
    ).toBe(503);
  });

  it('release: 202 идемпотентно, ключ URL-encoded', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    const first = await app.request(`/api/v2/execution/pools/${encoded}`, { method: 'DELETE' });
    const second = await app.request(`/api/v2/execution/pools/${encoded}`, { method: 'DELETE' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true });
    expect(provider.released).toEqual([httpProviderPool.key, httpProviderPool.key]);
  });

  it('release: невалидный ключ → 400, без провайдера → 503', async () => {
    const provider = fakeProvider({ pools: [httpProviderPool] });
    const app = appWith({
      executionConfig: remoteConfig(),
      executionRouter: routerStub({ provider }),
    });
    expect((await app.request('/api/v2/execution/pools/broken', { method: 'DELETE' })).status).toBe(400);
    const inline = appWith({});
    expect((await inline.request(`/api/v2/execution/pools/${encoded}`, { method: 'DELETE' })).status).toBe(503);
  });
});

describe('PROP-135 Ф6b-1: guard по умолчанию (requireAuth)', () => {
  it('без аутентификации — 401 на всех маршрутах', async () => {
    const app = appWith({ executionConfig: remoteConfig() }, false);
    const key = encodeURIComponent('instance:exec:default');
    expect((await app.request('/api/v2/execution/profiles')).status).toBe(401);
    expect((await app.request('/api/v2/execution/pools')).status).toBe(401);
    expect(
      (await app.request(`/api/v2/execution/pools/${key}/drain`, { method: 'POST' })).status,
    ).toBe(401);
    expect(
      (await app.request(`/api/v2/execution/pools/${key}`, { method: 'DELETE' })).status,
    ).toBe(401);
  });

  it('профили, пулы и мутации — независимые guard\'ы', async () => {
    // Managed-раскладка: каталог профилей открыт аутентифицированному,
    // пулы и мутации закрыты ролевым guard'ом.
    const deny = async (c: Context) =>
      c.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
    const app = new Hono();
    app.route(
      '/api/v2/execution',
      createExecutionRoutes(
        authKit(),
        { executionConfig: remoteConfig(), executionRouter: routerStub({ profiles: ['default'] }) },
        { profilesReadGuard: authKit().requireAuth, poolsReadGuard: deny, writeGuard: deny },
      ),
    );
    expect((await app.request('/api/v2/execution/profiles')).status).toBe(200);
    expect((await app.request('/api/v2/execution/pools')).status).toBe(403);
    const key = encodeURIComponent('instance:exec:default');
    expect(
      (await app.request(`/api/v2/execution/pools/${key}/drain`, { method: 'POST' })).status,
    ).toBe(403);
    expect(
      (await app.request(`/api/v2/execution/pools/${key}`, { method: 'DELETE' })).status,
    ).toBe(403);
  });
});
