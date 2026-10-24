/**
 * ADR-105 (Ф4): append-only журнал операций со слоем доступов.
 *
 * Проверяется:
 * - каждая операция (`issue`/`refresh`/`revoke`/`bind`/`use`) пишет запись;
 * - в записи есть id доступа, провайдер, операция, исход и время;
 * - **значения токенов в журнале нет** — ни в файле на диске, ни в памяти;
 * - ошибки операций журналируются как `outcome:'error'` с кодом ошибки;
 * - сбой записи в журнал не ломает саму операцию (best-effort).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { OAuthCredentialService } from './service.js';
import { OAuthError } from './types.js';
import { createOAuthRoutes } from '../../server/routes/oauth.js';
import { CredentialConnectorBindError } from './bind-connector.js';
import { createRepositoryCredentialSource } from '../mcp/credential-auth.js';
import { MemoryCredentialAuditRepository } from '../../storage/memory/credential-audit.js';
import { MemoryExternalCredentialRepository } from '../../storage/memory/external-credentials.js';
import { FileCredentialAuditStore } from '../../storage/file-credential-audit-store.js';
import { ExternalCredentialStore } from '../../storage/external-credential-store.js';
import type { OAuthClient } from './client.js';
import type { OAuthTokenSet } from './types.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ACCESS_TOKEN = 'plaintoken-access-AAAABBBBCCCC';
const REFRESH_TOKEN = 'plaintoken-refresh-DDDDEEEEFFFF';
const NEW_ACCESS_TOKEN = 'plaintoken-access-new-GGGGHHHH';

/** Клиент-провайдер: сеть не нужна — ответы задаются тестом. */
class StubClient {
  public exchangeError: Error | null = null;
  public refreshError: Error | null = null;
  public revokeError: Error | null = null;
  public revoked = true;

  readonly clientId = 'cid-demo';
  readonly defaultScopes = ['scope-a'];

  async exchangeCode(): Promise<OAuthTokenSet> {
    if (this.exchangeError) throw this.exchangeError;
    return {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresIn: 3600,
      scope: 'scope-a',
    };
  }

  async refresh(): Promise<OAuthTokenSet> {
    if (this.refreshError) throw this.refreshError;
    return { accessToken: NEW_ACCESS_TOKEN, expiresIn: 3600 };
  }

  async revoke(): Promise<{ revoked: boolean }> {
    if (this.revokeError) throw this.revokeError;
    return { revoked: this.revoked };
  }
}

/** Клиент-провайдер в форме, которую ждёт сервис. */
function asClient(stub: StubClient): OAuthClient {
  return stub as unknown as OAuthClient;
}

describe('ADR-105 Ф4: журнал операций со слоем доступов', () => {
  let audit: MemoryCredentialAuditRepository;
  let repo: MemoryExternalCredentialRepository;
  let stub: StubClient;
  let service: OAuthCredentialService;

  beforeEach(() => {
    audit = new MemoryCredentialAuditRepository();
    repo = new MemoryExternalCredentialRepository();
    stub = new StubClient();
    service = new OAuthCredentialService({
      repo,
      clientFor: () => asClient(stub),
      audit,
    });
  });

  it('issue (обмен кода) пишет запись с id доступа, провайдером и исходом', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const list = await audit.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.op).toBe('issue');
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.provider).toBe('demo');
    expect(list[0]!.outcome).toBe('ok');
    expect(list[0]!.id).toMatch(/^ca_/);
    expect(Date.parse(list[0]!.ts)).not.toBeNaN();
  });

  it('issue (device flow) пишет запись', async () => {
    const meta = await service.storeTokens({
      provider: 'demo',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const list = await audit.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.op).toBe('issue');
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.outcome).toBe('ok');
  });

  it('неуспешная выдача пишет запись с исходом error и кодом ошибки', async () => {
    stub.exchangeError = new OAuthError('invalid_grant', 'отказ провайдера');

    await expect(
      service.exchangeAndStore({
        provider: 'demo',
        code: 'bad',
        owner: { kind: 'local', id: 'local' },
        createdBy: 'local',
      }),
    ).rejects.toBeInstanceOf(OAuthError);

    const list = await audit.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.op).toBe('issue');
    expect(list[0]!.outcome).toBe('error');
    expect(list[0]!.errorCode).toBe('invalid_grant');
    expect(list[0]!.provider).toBe('demo');
  });

  it('refresh пишет запись', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    await service.refresh(meta.id);

    const list = await audit.list({ op: 'refresh' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.provider).toBe('demo');
    expect(list[0]!.outcome).toBe('ok');
  });

  it('неуспешный refresh пишет запись с кодом ошибки', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });
    stub.refreshError = new OAuthError('invalid_grant', 'refresh отозван');

    await expect(service.refresh(meta.id)).rejects.toBeInstanceOf(OAuthError);

    const list = await audit.list({ op: 'refresh' });
    expect(list).toHaveLength(1);
    expect(list[0]!.outcome).toBe('error');
    expect(list[0]!.errorCode).toBe('invalid_grant');
  });

  it('revoke пишет запись', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    await service.revoke(meta.id);

    const list = await audit.list({ op: 'revoke' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.provider).toBe('demo');
    expect(list[0]!.outcome).toBe('ok');
  });

  it('отзыв несуществующего доступа пишет запись с кодом not_found', async () => {
    await expect(service.revoke('extc_missing')).rejects.toBeInstanceOf(OAuthError);

    const list = await audit.list({ op: 'revoke' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe('extc_missing');
    expect(list[0]!.outcome).toBe('error');
    expect(list[0]!.errorCode).toBe('not_found');
  });

  it('use (подстановка токена в транспорт) пишет запись', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
      connectorId: 'mcp-1',
    });

    const source = createRepositoryCredentialSource({ repo, audit });
    const token = await source.getAccessToken(meta.id);
    expect(token).toBe(ACCESS_TOKEN);

    const list = await audit.list({ op: 'use' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.provider).toBe('demo');
    expect(list[0]!.outcome).toBe('ok');
    expect(list[0]!.connectorId).toBe('mcp-1');
  });

  it('use отозванного доступа пишет запись с исходом error', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });
    await service.revoke(meta.id);

    const source = createRepositoryCredentialSource({ repo, audit });
    await expect(source.getAccessToken(meta.id)).rejects.toThrow();

    const list = await audit.list({ op: 'use' });
    expect(list).toHaveLength(1);
    expect(list[0]!.outcome).toBe('error');
    expect(list[0]!.errorCode).toBe('revoked');
  });

  it('bind (привязка к коннектору) пишет запись', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const app = new Hono();
    const pass: MiddlewareHandler = async (_c: Context, next) => {
      await next();
    };
    app.route(
      '/api/v2/oauth',
      createOAuthRoutes(
        { requireAuth: pass },
        {
          credentials: repo,
          service,
          providers: {
            get: () => undefined,
            clientFor: () => asClient(stub),
          } as never,
          audit,
          ownerKind: 'local',
          resolveActor: () => ({ userId: 'local', roles: ['ADMIN'] }),
          bindConnector: async () => {},
        },
      ),
    );

    const response = await app.request(`/api/v2/oauth/credentials/${meta.id}/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'mcp-1' }),
    });
    expect(response.status).toBe(200);

    const list = await audit.list({ op: 'bind' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.provider).toBe('demo');
    expect(list[0]!.connectorId).toBe('mcp-1');
    expect(list[0]!.outcome).toBe('ok');
  });

  it('неуспешная привязка пишет запись с исходом error и кодом ошибки', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });

    const app = new Hono();
    const pass: MiddlewareHandler = async (_c: Context, next) => {
      await next();
    };
    app.route(
      '/api/v2/oauth',
      createOAuthRoutes(
        { requireAuth: pass },
        {
          credentials: repo,
          service,
          providers: {
            get: () => undefined,
            clientFor: () => asClient(stub),
          } as never,
          audit,
          ownerKind: 'local',
          resolveActor: () => ({ userId: 'local', roles: ['ADMIN'] }),
          bindConnector: async () => {
            throw new CredentialConnectorBindError('not_found', 'коннектора нет');
          },
        },
      ),
    );

    const response = await app.request(`/api/v2/oauth/credentials/${meta.id}/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectorId: 'mcp-1' }),
    });
    expect(response.status).toBe(404);

    const list = await audit.list({ op: 'bind' });
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialId).toBe(meta.id);
    expect(list[0]!.connectorId).toBe('mcp-1');
    expect(list[0]!.outcome).toBe('error');
    expect(list[0]!.errorCode).toBe('not_found');
  });

  it('в журнале нет значения токена, secretEnc и id пользователя', async () => {
    const meta = await service.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'user-secret-42',
    });
    await service.refresh(meta.id);
    await service.revoke(meta.id);

    const source = createRepositoryCredentialSource({ repo, audit });
    await source.getAccessToken(meta.id).catch(() => undefined);

    const raw = JSON.stringify(await audit.list());
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(REFRESH_TOKEN);
    expect(raw).not.toContain(NEW_ACCESS_TOKEN);
    expect(raw).not.toContain('enc:v1:');
    expect(raw).not.toContain('user-secret-42');
  });

  it('сбой записи в журнал не ломает саму операцию', async () => {
    const broken = {
      append: async () => {
        throw new Error('journal down');
      },
      list: async () => [],
      clear: async () => 0,
    };
    const serviceWithBrokenAudit = new OAuthCredentialService({
      repo,
      clientFor: () => asClient(stub),
      audit: broken,
    });

    const meta = await serviceWithBrokenAudit.exchangeAndStore({
      provider: 'demo',
      code: 'code-1',
      owner: { kind: 'local', id: 'local' },
      createdBy: 'local',
    });
    expect(meta.id).toMatch(/^extc_/);
    await expect(serviceWithBrokenAudit.refresh(meta.id)).resolves.toBeTruthy();
  });

  it('в файле на диске нет plaintext-токена (append-only JSONL)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-credential-audit-'));
    try {
      const fileRepo = new ExternalCredentialStore({
        dataDir: dir,
        secretKey: MASTER_KEY,
      });
      const fileAudit = new FileCredentialAuditStore({ dataDir: dir });
      const fileService = new OAuthCredentialService({
        repo: fileRepo,
        clientFor: () => asClient(stub),
        audit: fileAudit,
      });

      const meta = await fileService.exchangeAndStore({
        provider: 'demo',
        code: 'code-1',
        owner: { kind: 'local', id: 'local' },
        createdBy: 'local',
      });
      await fileService.refresh(meta.id);
      await fileService.revoke(meta.id);

      const raw = await readFile(join(dir, 'audit', 'credentials.jsonl'), 'utf-8');
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).not.toContain(ACCESS_TOKEN);
      expect(raw).not.toContain(REFRESH_TOKEN);
      expect(raw).not.toContain(NEW_ACCESS_TOKEN);
      expect(raw).not.toContain('enc:v1:');

      // Записи читаются обратно портом (append-only, порядок «свежие первыми»).
      const entries = await fileAudit.list();
      expect(entries.map((e) => e.op)).toEqual(['revoke', 'refresh', 'issue']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
