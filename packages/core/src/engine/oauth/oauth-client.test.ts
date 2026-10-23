/**
 * ADR-105 (Ф2): OAuth-клиент — PKCE, обмен кода, refresh (в т.ч. параллельный),
 * `invalid_grant`, revoke при 5xx.
 *
 * Провайдер — локальный `node:http`-сервер (реальный транспорт: `egressFetch`,
 * ADR-099), хранилище — in-memory порт (`ExternalCredentialRepository`).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryExternalCredentialRepository } from '../../storage/memory/external-credentials.js';
import { OAuthClient } from './client.js';
import { OAuthCredentialService } from './service.js';
import { OAuthError } from './types.js';
import type { OAuthProviderDescription } from './types.js';
import {
  buildAuthorizationUrl,
  computeCodeChallenge,
  createPkcePair,
  createState,
} from './pkce.js';

/** Тело запроса (form-urlencoded) в виде объекта. */
async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
  return Object.fromEntries(params.entries());
}

/** Поведение локального провайдера (переключается в тестах). */
interface ProviderBehaviour {
  /** Ответ token-endpoint (по умолчанию — для любого grant_type). */
  token: { status: number; body: Record<string, unknown> };
  /** Ответ token-endpoint по типу grant (`authorization_code`/`refresh_token`). */
  tokenByGrant?: Record<string, { status: number; body: Record<string, unknown> }>;
  /** Ответ revoke-endpoint. */
  revoke?: { status: number; body: Record<string, unknown> };
}

interface TestServer {
  server: Server;
  baseUrl: string;
  /** Запросы к token-endpoint (тела). */
  tokenRequests: Array<Record<string, string>>;
  /** Запросы к revoke-endpoint (тела). */
  revokeRequests: Array<Record<string, string>>;
  behaviour: ProviderBehaviour;
  close: () => Promise<void>;
}

/** Поднимает локальный провайдер на случайном порту. */
async function startProvider(behaviour: ProviderBehaviour): Promise<TestServer> {
  const tokenRequests: Array<Record<string, string>> = [];
  const revokeRequests: Array<Record<string, string>> = [];
  const state: TestServer = {
    server: undefined as unknown as Server,
    baseUrl: '',
    tokenRequests,
    revokeRequests,
    behaviour,
    close: async () => {},
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const form = await readForm(req);
      if (req.url?.startsWith('/revoke')) {
        revokeRequests.push(form);
        const answer = state.behaviour.revoke ?? { status: 200, body: {} };
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
        return;
      }
      tokenRequests.push(form);
      const grant = form.grant_type ?? '';
      const answer = state.behaviour.tokenByGrant?.[grant] ?? state.behaviour.token;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

/** Описание провайдера для локального сервера. */
function providerFor(baseUrl: string): OAuthProviderDescription {
  return {
    provider: 'local',
    authorizeUrl: `${baseUrl}/authorize`,
    tokenUrl: `${baseUrl}/token`,
    revokeUrl: `${baseUrl}/revoke`,
    clientId: 'client-1',
    scopes: ['read', 'write'],
  };
}

/** Сервис доступа поверх in-memory порта и локального провайдера. */
function makeService(baseUrl: string): {
  service: OAuthCredentialService;
  repo: MemoryExternalCredentialRepository;
} {
  const repo = new MemoryExternalCredentialRepository();
  const service = new OAuthCredentialService({
    repo,
    clientFor: () => new OAuthClient({ provider: providerFor(baseUrl) }),
  });
  return { service, repo };
}

describe('oauth: PKCE (RFC 7636)', () => {
  it('верификатор и challenge корректны (S256)', () => {
    const pair = createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    // RFC 7636 §4.1: 43–128 символов unreserved-алфавита.
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    const expected = createHash('sha256').update(pair.codeVerifier, 'ascii').digest('base64url');
    expect(pair.codeChallenge).toBe(expected);
    expect(computeCodeChallenge(pair.codeVerifier)).toBe(pair.codeChallenge);
  });

  it('URL выдачи кода содержит обязательные параметры и PKCE', () => {
    const pair = createPkcePair();
    const state = createState();
    const url = new URL(
      buildAuthorizationUrl(providerFor('http://127.0.0.1:1'), {
        pkce: pair,
        state,
        redirectUri: 'http://localhost:5002/callback',
        extraParams: { access_type: 'offline' },
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5002/callback');
    expect(url.searchParams.get('code_challenge')).toBe(pair.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });
});

describe('oauth: обмен кода и refresh', () => {
  it('обмен кода: провайдер получает grant_type/code/code_verifier, токены сохраняются', async () => {
    const server = await startProvider({
      token: {
        status: 200,
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'read write',
          token_type: 'Bearer',
        },
      },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const pair = createPkcePair();
    const meta = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      codeVerifier: pair.codeVerifier,
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    expect(server.tokenRequests).toHaveLength(1);
    const form = server.tokenRequests[0] ?? {};
    expect(form.grant_type).toBe('authorization_code');
    expect(form.code).toBe('auth-code');
    expect(form.code_verifier).toBe(pair.codeVerifier);
    expect(form.client_id).toBe('client-1');

    // Наружу — только метаданные: токен не отдаётся, есть маска.
    expect(meta.status).toBe('active');
    expect(meta.hasRefreshToken).toBe(true);
    expect(meta.secretMask.startsWith('mask:')).toBe(true);
    expect(JSON.stringify(meta)).not.toContain('access-1');
    expect(JSON.stringify(meta)).not.toContain('refresh-1');

    // В хранилище — расшифрованные значения (reveal — путь подстановки в транспорт).
    const revealed = await repo.reveal(meta.id);
    expect(revealed?.accessToken).toBe('access-1');
    expect(revealed?.refreshToken).toBe('refresh-1');
  });

  it('refresh (RFC 6749 §6): новые токены записываются, статус остаётся активным', async () => {
    const server = await startProvider({
      token: {
        status: 200,
        body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 },
      },
      tokenByGrant: {
        authorization_code: {
          status: 200,
          body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
        },
      },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });
    server.tokenRequests.length = 0;

    const meta = await service.refresh(created.id);
    expect(server.tokenRequests).toHaveLength(1);
    const form = server.tokenRequests[0] ?? {};
    expect(form.grant_type).toBe('refresh_token');
    expect(form.refresh_token).toBe('refresh-1');
    expect(meta.status).toBe('active');

    const revealed = await repo.reveal(created.id);
    expect(revealed?.accessToken).toBe('access-2');
    expect(revealed?.refreshToken).toBe('refresh-2');
  });

  it('параллельный refresh: ровно один сетевой вызов', async () => {
    const server = await startProvider({
      token: {
        status: 200,
        body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 },
      },
      tokenByGrant: {
        authorization_code: {
          status: 200,
          body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
        },
      },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });
    server.tokenRequests.length = 0;

    const [first, second] = await Promise.all([
      service.refresh(created.id),
      service.refresh(created.id),
    ]);

    expect(server.tokenRequests).toHaveLength(1);
    expect(first.status).toBe('active');
    expect(second.status).toBe('active');
    const revealed = await repo.reveal(created.id);
    expect(revealed?.accessToken).toBe('access-2');
  });

  it('invalid_grant: доступ переводится в status:error (через порт)', async () => {
    const server = await startProvider({
      token: {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'refresh token revoked' },
      },
      tokenByGrant: {
        authorization_code: {
          status: 200,
          body: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
        },
      },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    await expect(service.refresh(created.id)).rejects.toBeInstanceOf(OAuthError);
    const meta = await repo.get(created.id);
    expect(meta?.status).toBe('error');
    // Токен при этом не перезаписывается и не утекает в текст ошибки.
    const revealed = await repo.reveal(created.id);
    expect(revealed?.accessToken).toBe('access-1');
  });
});

describe('oauth: revoke (RFC 7009, best-effort)', () => {
  it('отзыв у провайдера: локальный отзыв всегда, ответ провайдера — best-effort', async () => {
    const server = await startProvider({
      token: { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1' } },
      revoke: { status: 200, body: {} },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const result = await service.revoke(created.id);
    expect(result.providerRevoked).toBe(true);
    expect(result.meta.status).toBe('revoked');
    expect(result.meta.revokedAt).toBeTruthy();
    expect(server.revokeRequests).toHaveLength(1);
    expect(server.revokeRequests[0]?.token).toBe('refresh-1');
    expect(server.revokeRequests[0]?.token_type_hint).toBe('refresh_token');
    expect((await repo.get(created.id))?.status).toBe('revoked');
  });

  it('провайдер ответил 5xx: локальный отзыв состоялся, ошибки не бросаем', async () => {
    const server = await startProvider({
      token: { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1' } },
      revoke: { status: 500, body: { error: 'server_error' } },
    });
    servers.push(server);

    const { service, repo } = makeService(server.baseUrl);
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const result = await service.revoke(created.id);
    expect(result.providerRevoked).toBe(false);
    expect(result.meta.status).toBe('revoked');
    expect((await repo.get(created.id))?.status).toBe('revoked');
  });

  it('провайдер без revoke-endpoint: локальный отзыв без сетевого вызова', async () => {
    const server = await startProvider({
      token: { status: 200, body: { access_token: 'access-1', refresh_token: 'refresh-1' } },
    });
    servers.push(server);

    const repo = new MemoryExternalCredentialRepository();
    const provider = providerFor(server.baseUrl);
    const service = new OAuthCredentialService({
      repo,
      clientFor: () => new OAuthClient({ provider: { ...provider, revokeUrl: undefined } }),
    });
    const created = await service.exchangeAndStore({
      provider: 'local',
      code: 'auth-code',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const result = await service.revoke(created.id);
    expect(result.providerRevoked).toBe(false);
    expect(result.meta.status).toBe('revoked');
    expect(server.revokeRequests).toHaveLength(0);
  });
});
