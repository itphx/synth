/**
 * Событие шины `credentials.updated` на write-путях `createOAuthRoutes`.
 *
 * Баг, который событие закрывает: «внешний доступ (OAuth), выданный/отозванный в
 * другом клиенте или в соседней вкладке, не появляется в разделе „Внешние
 * доступы“» — список грузится один раз при монтировании, а перечитывать его
 * было не из чего: сервер молчал о мутации (инвариант 27 `AGENTS.md`).
 *
 * Контракт проверяется здесь целиком:
 * - выдача: `POST /credentials` — завершение authorize-выдачи (обмен кода) и
 *   завершение device flow → `{ action: 'save' }`; **старт** выдачи (ни код, ни
 *   device-токен ещё не получены) молчит — записи нет;
 * - refresh: `POST /credentials/:id/refresh` → `{ action: 'refresh' }`;
 * - отзыв: `DELETE /credentials/:id` → `{ action: 'delete' }`;
 * - привязка: `POST /credentials/:id/bind` → `{ action: 'bind' }`;
 * - **не** публикуется при ошибке: 400 (невалидное тело), 403 (чужая запись),
 *   404 (нет записи/коннектора) — тишина;
 * - payload — только id записи, провайдер и вид мутации: `access_token`,
 *   `refresh_token`, маска секрета и прочие детали записи в событие не попадают
 *   ни при каких условиях (инвариант 13 `AGENTS.md`).
 *
 * Хук подменён настоящим публикатором поверх фейковой шины
 * (`credentialsChangedPublisher` — тот же, что ставит точка сборки): тест про
 * контракт фабрики, а сам шов — `src/events/credentials-events.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createOAuthRoutes } from './oauth.js';
import { OAuthClient } from '../../engine/oauth/client.js';
import { OAuthProviderRegistry } from '../../engine/oauth/registry.js';
import { OAuthCredentialService } from '../../engine/oauth/service.js';
import { MemoryExternalCredentialRepository } from '../../storage/memory/external-credentials.js';
import type { McpRegistryEntry } from '@itphx/synth-shared';
import { publishCredentialsUpdated } from '../../events/credentials-events.js';
import type { CredentialsChangedInfo } from '../../events/credentials-events.js';

/** Записанное событие (тип + payload; инстансный канал подразумевается). */
interface PublishedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: только инстансный канал (события ресурсов инстанса). */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `credentialsChangedPublisher(eventBus)`. */
function credentialsHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: CredentialsChangedInfo) => publishCredentialsUpdated(bus, info);
}

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

/** Ответы token-endpoint провайдера. */
interface ProviderStub {
  token: { status: number; body: Record<string, unknown> };
  tokenByGrant?: Record<string, { status: number; body: Record<string, unknown> }>;
  device?: { status: number; body: Record<string, unknown> };
}

/** Токены, которые провайдер выдаёт в тестах: их не должно быть в событии. */
const ACCESS_TOKEN = 'acc-super-secret';
const REFRESH_TOKEN = 'ref-super-secret';

function makeApp(published: PublishedEvent[], opts: {
  stub?: ProviderStub;
  userId?: string;
  roles?: string[];
  registry?: FakeRegistry;
  repo?: MemoryExternalCredentialRepository;
  bindConnector?: boolean;
} = {}) {
  const repo = opts.repo ?? new MemoryExternalCredentialRepository();
  const registry = new OAuthProviderRegistry();
  const stub: ProviderStub = opts.stub ?? {
    token: {
      status: 200,
      body: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 },
    },
  };
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const grant = params.get('grant_type') ?? '';
    const url = String(input);
    let answer = stub.token;
    if (url.includes('/device')) answer = stub.device ?? stub.token;
    else if (stub.tokenByGrant?.[grant]) answer = stub.tokenByGrant[grant]!;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const description = {
    provider: 'demo',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    revokeUrl: 'https://provider.test/revoke',
    deviceAuthorizationUrl: 'https://provider.test/device',
    clientId: 'client-1',
    scopes: ['read'],
  };
  registry.register({
    description,
    client: new OAuthClient({ provider: description, fetchImpl }),
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
        ownerKind: 'user',
        onCredentialsChanged: credentialsHook(published),
        resolveActor: (c) => {
          const user = c.get('user') as { id?: string; roles?: string[] } | undefined;
          return { userId: user?.id ?? '', roles: user?.roles ?? [] };
        },
        ...(opts.bindConnector === false
          ? {}
          : {
              bindConnector: async ({ connectorId, credentialId }: {
                connectorId: string; credentialId: string;
              }) => {
                const entry =
                  (await mcpRegistry.get(connectorId))
                  ?? (await mcpRegistry.getByName(connectorId));
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
            }),
      },
    ),
  );
  return { app, repo, mcpRegistry };
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Старт + завершение authorize-выдачи: id записи доступа. */
async function issueCredential(app: Hono): Promise<{ id: string; provider: string }> {
  const start = await postJson(app, '/api/v2/oauth/credentials', { provider: 'demo' });
  const { state } = (await start.json()) as { state: string };
  const done = await postJson(app, '/api/v2/oauth/credentials', {
    provider: 'demo',
    code: 'auth-code',
    state,
  });
  const { credential } = (await done.json()) as { credential: { id: string; provider: string } };
  return credential;
}

/** Коннектор для привязки доступа. */
function seedConnector(registry: FakeRegistry, id = 'conn-1'): void {
  registry.entries.set(id, {
    id,
    name: 'demo-conn',
    config: { type: 'http', url: 'https://mcp.test' },
    origin: 'instance',
    enabled: true,
    enabledByDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as McpRegistryEntry);
}

describe('createOAuthRoutes — событие credentials.updated на write-путях', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  it('POST /credentials (завершение authorize-выдачи) публикует { action: save }', async () => {
    const { app } = makeApp(published);

    const start = await postJson(app, '/api/v2/oauth/credentials', { provider: 'demo' });
    expect(start.status).toBe(201);
    // Старт выдачи записи не создаёт — событие молчит.
    expect(published).toEqual([]);

    const { state } = (await start.json()) as { state: string };
    const done = await postJson(app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      code: 'auth-code',
      state,
    });

    expect(done.status).toBe(201);
    const { credential } = (await done.json()) as { credential: { id: string } };
    expect(published).toEqual([
      {
        type: 'credentials.updated',
        data: { action: 'save', credentialId: credential.id, provider: 'demo' },
      },
    ]);
  });

  it('POST /credentials (завершение device flow) публикует { action: save }', async () => {
    const { app } = makeApp(published, {
      stub: {
        token: { status: 200, body: { access_token: ACCESS_TOKEN, expires_in: 60 } },
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
      },
    });

    const start = await postJson(app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      flow: 'device',
    });
    expect(start.status).toBe(201);
    expect(published).toEqual([]);

    const { state } = (await start.json()) as { state: string };
    const done = await postJson(app, '/api/v2/oauth/credentials', {
      provider: 'demo',
      flow: 'device',
      state,
    });

    expect(done.status).toBe(201);
    const { credential } = (await done.json()) as { credential: { id: string } };
    expect(published).toEqual([
      {
        type: 'credentials.updated',
        data: { action: 'save', credentialId: credential.id, provider: 'demo' },
      },
    ]);
  });

  it('POST /credentials/:id/refresh публикует { action: refresh }', async () => {
    const { app } = makeApp(published);
    const credential = await issueCredential(app);
    published.length = 0;

    const res = await postJson(app, `/api/v2/oauth/credentials/${credential.id}/refresh`, {});

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        type: 'credentials.updated',
        data: { action: 'refresh', credentialId: credential.id, provider: 'demo' },
      },
    ]);
  });

  it('DELETE /credentials/:id публикует { action: delete }', async () => {
    const { app } = makeApp(published);
    const credential = await issueCredential(app);
    published.length = 0;

    const res = await app.request(`/api/v2/oauth/credentials/${credential.id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        type: 'credentials.updated',
        data: { action: 'delete', credentialId: credential.id, provider: 'demo' },
      },
    ]);
  });

  it('POST /credentials/:id/bind публикует { action: bind }', async () => {
    const registry = new FakeRegistry();
    seedConnector(registry);
    const { app } = makeApp(published, { registry });
    const credential = await issueCredential(app);
    published.length = 0;

    const res = await postJson(app, `/api/v2/oauth/credentials/${credential.id}/bind`, {
      connectorId: 'conn-1',
    });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        type: 'credentials.updated',
        data: { action: 'bind', credentialId: credential.id, provider: 'demo' },
      },
    ]);
  });

  it('ошибки молчат: 400 (невалидное тело), 404 (нет записи/коннектора)', async () => {
    const { app } = makeApp(published);
    const credential = await issueCredential(app);
    published.length = 0;

    // 400: пустой провайдер и неизвестный провайдер.
    expect((await postJson(app, '/api/v2/oauth/credentials', { provider: '' })).status).toBe(400);
    expect((await postJson(app, '/api/v2/oauth/credentials', { provider: 'nope' })).status).toBe(400);
    // 400: привязка без обязательного `connectorId`.
    expect((await postJson(app, `/api/v2/oauth/credentials/${credential.id}/bind`, {}))
      .status).toBe(400);
    // 404: несуществующая запись доступа (refresh и отзыв).
    expect((await postJson(app, '/api/v2/oauth/credentials/extc_missing/refresh', {})).status)
      .toBe(404);
    expect((await app.request('/api/v2/oauth/credentials/extc_missing', { method: 'DELETE' }))
      .status).toBe(404);
    // 404: нет коннектора (bind).
    expect((await postJson(app, `/api/v2/oauth/credentials/${credential.id}/bind`, {
      connectorId: 'nope',
    })).status).toBe(404);

    expect(published).toEqual([]);

    // Контроль: после ошибок исправная мутация событие всё же публикует.
    expect((await postJson(app, `/api/v2/oauth/credentials/${credential.id}/refresh`, {}))
      .status).toBe(200);
    expect(published).toHaveLength(1);
  });

  it('409 (привязка не поддержана точкой сборки) молчит', async () => {
    const { app } = makeApp(published, { bindConnector: false });
    const credential = await issueCredential(app);
    published.length = 0;

    expect((await postJson(app, `/api/v2/oauth/credentials/${credential.id}/bind`, {
      connectorId: 'conn-1',
    })).status).toBe(409);

    expect(published).toEqual([]);
  });

  it('403 (чужая запись) молчит', async () => {
    const repo = new MemoryExternalCredentialRepository();
    const owner = makeApp(published, { userId: 'u-1', repo });
    const credential = await issueCredential(owner.app);
    published.length = 0;

    const stranger = makeApp(published, { userId: 'u-2', repo });
    expect((await postJson(stranger.app, `/api/v2/oauth/credentials/${credential.id}/refresh`, {}))
      .status).toBe(403);
    expect((await stranger.app.request(`/api/v2/oauth/credentials/${credential.id}`, {
      method: 'DELETE',
    })).status).toBe(403);

    expect(published).toEqual([]);
  });

  it('в payload нет токенов и маски секрета', async () => {
    const { app } = makeApp(published);

    const credential = await issueCredential(app);
    await postJson(app, `/api/v2/oauth/credentials/${credential.id}/refresh`, {});
    await app.request(`/api/v2/oauth/credentials/${credential.id}`, { method: 'DELETE' });

    expect(published.map((e) => e.data.action)).toEqual(['save', 'refresh', 'delete']);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('secretMask');
    // Ключи payload'а — только вид мутации, id записи и провайдер.
    for (const event of published) {
      expect(Object.keys(event.data).sort()).toEqual(['action', 'credentialId', 'provider']);
    }
  });
});
