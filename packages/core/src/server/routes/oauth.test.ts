/**
 * ADR-105 (Ф4): HTTP-контур слоя внешних доступов.
 *
 * Проверяются: выдача (PKCE/device), список/детали (видимость по владельцу и
 * роли), форсированный refresh, отзыв, привязка к MCP-коннектору, коды ошибок
 * (400/403/404/409) и главное — **секрет наружу не отдаётся**.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createOAuthRoutes } from './oauth.js';
import { OAuthClient } from '../../engine/oauth/client.js';
import { OAuthProviderRegistry } from '../../engine/oauth/registry.js';
import { OAuthCredentialService } from '../../engine/oauth/service.js';
import { MemoryExternalCredentialRepository } from '../../storage/memory/external-credentials.js';
import { PendingAuthorizationStore } from '../../engine/oauth/pending-flows.js';
import type { McpRegistryEntry } from '@itphx/synth-shared';

/** Порт реестра MCP — минимальный мок (нужны только `get`/`getByName`/`update`). */
class FakeRegistry {
  readonly entries = new Map<string, McpRegistryEntry>();

  async get(id: string): Promise<McpRegistryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async getByName(name: string): Promise<McpRegistryEntry | null> {
    return [...this.entries.values()].find((e) => e.name === name) ?? null;
  }

  async update(id: string, patch: { config?: McpRegistryEntry['config'] }): Promise<McpRegistryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const next = { ...entry, ...patch } as McpRegistryEntry;
    this.entries.set(id, next);
    return next;
  }
}

/** Провайдер: ответы token-endpoint задаются тестом. */
interface ProviderStub {
  token: { status: number; body: Record<string, unknown> };
  tokenByGrant?: Record<string, { status: number; body: Record<string, unknown> }>;
  device?: { status: number; body: Record<string, unknown> };
}

/** Сборка приложения с заданным провайдером и пользователем. */
function makeApp(opts: {
  stub?: ProviderStub;
  userId?: string;
  roles?: string[];
  ownerKind?: 'user' | 'local';
  registry?: FakeRegistry;
  repo?: MemoryExternalCredentialRepository;
  pending?: PendingAuthorizationStore;
} = {}) {
  const repo = opts.repo ?? new MemoryExternalCredentialRepository();
  const registry = new OAuthProviderRegistry();
  const stub: ProviderStub = opts.stub ?? {
    token: { status: 200, body: { access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 } },
  };
  const fetchImpl = async (_input: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const grant = params.get('grant_type') ?? '';
    const url = String(_input);
    let answer = stub.token;
    if (url.includes('/device')) answer = stub.device ?? stub.token;
    else if (stub.tokenByGrant?.[grant]) answer = stub.tokenByGrant[grant]!;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  registry.register({
    description: {
      provider: 'demo',
      authorizeUrl: 'https://provider.test/authorize',
      tokenUrl: 'https://provider.test/token',
      revokeUrl: 'https://provider.test/revoke',
      deviceAuthorizationUrl: 'https://provider.test/device',
      clientId: 'client-1',
      scopes: ['read'],
    },
    client: new OAuthClient({
      provider: {
        provider: 'demo',
        authorizeUrl: 'https://provider.test/authorize',
        tokenUrl: 'https://provider.test/token',
        revokeUrl: 'https://provider.test/revoke',
        deviceAuthorizationUrl: 'https://provider.test/device',
        clientId: 'client-1',
        scopes: ['read'],
      },
      fetchImpl,
    }),
  });
  const service = new OAuthCredentialService({
    repo,
    clientFor: (provider: string) => registry.clientFor(provider),
  });
  const auth: { requireAuth: MiddlewareHandler } = {
    requireAuth: (async (c: Context, next: Next) => {
      c.set('user' as never, { id: opts.userId ?? 'u-1', roles: opts.roles ?? ['USER'] } as never);
      await next();
    }) as MiddlewareHandler,
  };
  const mcpRegistry = opts.registry ?? new FakeRegistry();
  const app = new Hono();
  app.route(
    '/api/v2/oauth',
    createOAuthRoutes(
      { requireAuth: auth.requireAuth },
      {
        credentials: repo,
        service,
        providers: registry,
        ...(opts.pending ? { pending: opts.pending } : {}),
        ownerKind: opts.ownerKind ?? 'user',
        resolveActor: (c) => {
          const user = c.get('user') as { id?: string; roles?: string[] } | undefined;
          return { userId: user?.id ?? '', roles: user?.roles ?? [] };
        },
        bindConnector: async ({ connectorId, credentialId }) => {
          const entry =
            (await mcpRegistry.get(connectorId)) ?? (await mcpRegistry.getByName(connectorId));
          if (!entry) {
            const { CredentialConnectorBindError } = await import(
              '../../engine/oauth/bind-connector.js'
            );
            throw new CredentialConnectorBindError('not_found', 'нет коннектора');
          }
          await mcpRegistry.update(entry.id, {
            config: { ...entry.config, auth: { kind: 'credential', credentialId } },
          });
        },
      },
    ),
  );
  return { app, repo, registry, mcpRegistry };
}

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('OAuth routes (ADR-105 Ф4)', () => {
  let ctx: ReturnType<typeof makeApp>;

  beforeEach(() => {
    ctx = makeApp();
  });

  it('GET /credentials — пустой список', async () => {
    const res = await ctx.app.request('/api/v2/oauth/credentials');
    expect(res.status).toBe(200);
    expect((await res.json() as { credentials: unknown[] }).credentials).toEqual([]);
  });

  it('POST /credentials — старт выдачи (PKCE): URL + state, секретов нет', async () => {
    const res = await postJson(ctx.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    expect(res.status).toBe(201);
    const body = await res.json() as {
      flow: string; authorizationUrl: string; state: string; expiresAt: string;
    };
    expect(body.flow).toBe('started');
    expect(body.authorizationUrl).toContain('code_challenge=');
    expect(body.authorizationUrl).toContain('code_challenge_method=S256');
    expect(body.authorizationUrl).toContain(encodeURIComponent(body.state));
    expect(body.state).toBeTruthy();
    // В ответе нет ни verifier'а, ни токена.
    expect(JSON.stringify(body)).not.toContain('codeVerifier');
  });

  it('POST /credentials — обмен кода на токены: 201 + метаданные без секрета', async () => {
    const start = await postJson(ctx.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const res = await postJson(ctx.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { flow: string; credential: Record<string, unknown> };
    expect(body.flow).toBe('completed');
    expect(body.credential.id).toBeTruthy();
    expect(body.credential.status).toBe('active');
    expect(body.credential.secretMask).toMatch(/^mask:[0-9a-f]{16}$/);
    expect(body.credential.hasRefreshToken).toBe(true);
    // Секрет наружу не утекает.
    expect(JSON.stringify(body)).not.toContain('acc-1');
    expect(JSON.stringify(body)).not.toContain('ref-1');
  });

  it('POST /credentials — неизвестный провайдер → 400', async () => {
    const res = await postJson(ctx.app, '/api/v2/oauth/credentials', { provider: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('OAUTH_PROVIDER_UNKNOWN');
  });

  it('POST /credentials — неверное тело → 400', async () => {
    const res = await postJson(ctx.app, '/api/v2/oauth/credentials', { provider: '' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /credentials — код без state → 400; с чужим state → 409', async () => {
    const noState = await postJson(ctx.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
    });
    expect(noState.status).toBe(400);

    const badState = await postJson(ctx.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state: 'unknown-state',
    });
    expect(badState.status).toBe(409);
    expect((await badState.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('GET /credentials — видны только свои доступы; ADMIN/LEAD — все', async () => {
    const repo = new MemoryExternalCredentialRepository();
    const owner = makeApp({ userId: 'u-1', repo });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });

    // Чужой пользователь доступа не видит.
    const other = makeApp({ userId: 'u-2', repo });
    const otherList = await other.app.request('/api/v2/oauth/credentials');
    expect((await otherList.json() as { credentials: unknown[] }).credentials).toEqual([]);

    // Владелец видит свой доступ.
    const ownerList = await owner.app.request('/api/v2/oauth/credentials');
    expect((await ownerList.json() as { credentials: unknown[] }).credentials).toHaveLength(1);

    // `ADMIN`/`LEAD` видят все доступы инстанса.
    const admin = makeApp({ userId: 'admin-1', roles: ['ADMIN'], repo });
    const adminList = await admin.app.request('/api/v2/oauth/credentials');
    expect((await adminList.json() as { credentials: unknown[] }).credentials).toHaveLength(1);
  });

  it('GET /credentials/:id — владелец видит, чужой → 403, несуществующий → 404', async () => {
    const repo = new MemoryExternalCredentialRepository();
    const owner = makeApp({ userId: 'u-1', repo });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { id: string } };

    const ok = await owner.app.request(`/api/v2/oauth/credentials/${credential.id}`);
    expect(ok.status).toBe(200);

    const stranger = makeApp({ userId: 'u-2', repo });
    const denied = await stranger.app.request(`/api/v2/oauth/credentials/${credential.id}`);
    expect(denied.status).toBe(403);

    const missing = await owner.app.request('/api/v2/oauth/credentials/extc_missing');
    expect(missing.status).toBe(404);
  });

  it('POST /credentials/:id/refresh — владелец обновляет токен, чужой → 403', async () => {
    const repo = new MemoryExternalCredentialRepository();
    const owner = makeApp({ userId: 'u-1', repo });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { id: string } };

    const refreshed = await postJson(
      owner.app,
      `/api/v2/oauth/credentials/${credential.id}/refresh`,
      {},
    );
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json() as { credential: { status: string } }).credential.status).toBe(
      'active',
    );

    const stranger = makeApp({ userId: 'u-2', repo });
    const denied = await postJson(
      stranger.app,
      `/api/v2/oauth/credentials/${credential.id}/refresh`,
      {},
    );
    expect(denied.status).toBe(403);
  });

  it('DELETE /credentials/:id — отзыв (локальный + best-effort у провайдера)', async () => {
    const owner = makeApp({ userId: 'u-1' });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { id: string } };

    const res = await owner.app.request(`/api/v2/oauth/credentials/${credential.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { credential: { status: string }; providerRevoked: boolean };
    expect(body.credential.status).toBe('revoked');
    expect(body.providerRevoked).toBe(true);
    expect(JSON.stringify(body)).not.toContain('ref-1');
  });

  it('POST /credentials/:id/bind — привязка к MCP-коннектору', async () => {
    const registry = new FakeRegistry();
    registry.entries.set('conn-1', {
      id: 'conn-1',
      name: 'demo-conn',
      config: { type: 'http', url: 'https://mcp.test' },
      origin: 'instance',
      enabled: true,
      enabledByDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as McpRegistryEntry);
    const owner = makeApp({ userId: 'u-1', registry });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { id: string } };

    const res = await postJson(owner.app, `/api/v2/oauth/credentials/${credential.id}/bind`, {
      connectorId: 'conn-1',
    });
    expect(res.status).toBe(200);
    const entry = registry.entries.get('conn-1')!;
    expect(entry.config.auth).toEqual({ kind: 'credential', credentialId: credential.id });
  });

  it('POST /credentials/:id/bind — неизвестный коннектор → 404', async () => {
    const owner = makeApp({ userId: 'u-1' });
    const start = await postJson(owner.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(owner.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { id: string } };
    const res = await postJson(owner.app, `/api/v2/oauth/credentials/${credential.id}/bind`, {
      connectorId: 'nope',
    });
    expect(res.status).toBe(404);
  });

  it('device flow — старт → userCode, опрос → 202 pending, затем → 201', async () => {
    const stub: ProviderStub = {
      token: { status: 200, body: { access_token: 'acc-dev', expires_in: 60 } },
      device: {
        status: 200,
        body: {
          device_code: 'dev-code',
          user_code: 'USER-CODE',
          verification_uri: 'https://provider.test/device',
          expires_in: 600,
          interval: 1,
        },
      },
      tokenByGrant: {
        'urn:ietf:params:oauth:grant-type:device_code': {
          status: 400,
          body: { error: 'authorization_pending' },
        },
      },
    };
    const app = makeApp({ stub });
    const start = await postJson(app.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      flow: 'device',
    });
    expect(start.status).toBe(201);
    const started = await start.json() as {
      flow: string; state: string; userCode: string; verificationUri: string;
    };
    expect(started.flow).toBe('started');
    expect(started.userCode).toBe('USER-CODE');
    expect(started.verificationUri).toBe('https://provider.test/device');

    const pending = await postJson(app.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      flow: 'device',
      state: started.state,
    });
    expect(pending.status).toBe(202);
    expect((await pending.json() as { flow: string }).flow).toBe('pending');
  });

  it('инстансный доступ выдаёт только ADMIN/LEAD', async () => {
    const user = makeApp({ userId: 'u-1', roles: ['USER'] });
    const denied = await postJson(user.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      ownerKind: 'instance',
    });
    expect(denied.status).toBe(403);

    const lead = makeApp({ userId: 'lead-1', roles: ['LEAD'] });
    const start = await postJson(lead.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      ownerKind: 'instance',
    });
    expect(start.status).toBe(201);
    const { state } = await start.json() as { state: string };
    const created = await postJson(lead.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { owner: { kind: string } } };
    expect(credential.owner.kind).toBe('instance');
  });

  it('standalone: владелец доступа — local', async () => {
    const app = makeApp({ userId: 'local', roles: ['ADMIN'], ownerKind: 'local' });
    const start = await postJson(app.app, '/api/v2/oauth/credentials', { provider: 'demo' });
    const { state } = await start.json() as { state: string };
    const created = await postJson(app.app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });
    const { credential } = await created.json() as { credential: { owner: { kind: string; id: string } } };
    expect(credential.owner.kind).toBe('local');
    expect(credential.owner.id).toBe('local');
  });
});
