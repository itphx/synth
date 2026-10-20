import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { extractUser, extractUserFromTokens, OidcClient } from './oidc.js';
import { closeTestServer } from '../test-helpers/close-server.js';

describe('oidc extractUser', () => {
  it('берёт роли из realm_access id_token (ADMIN)', () => {
    const user = extractUser({ realm_access: { roles: ['admin'] } });
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('нормализует регистр и отбрасывает неизвестные роли', () => {
    const user = extractUser({ realm_access: { roles: ['Admin', 'superadmin', 'user'] } });
    expect(user.roles).toEqual(['ADMIN', 'USER']);
  });

  it('учитывает client roles из resource_access.<clientId>.roles', () => {
    const user = extractUser(
      { resource_access: { synth: { roles: ['lead'] } } },
      'synth',
    );
    expect(user.roles).toEqual(['LEAD']);
  });

  it('объединяет realm и client роли без дубликатов', () => {
    const user = extractUser(
      { realm_access: { roles: ['admin'] }, resource_access: { synth: { roles: ['admin', 'user'] } } },
      'synth',
    );
    expect(user.roles).toEqual(['ADMIN', 'USER']);
  });

  it('возвращает дефолт USER при отсутствии известных ролей', () => {
    const user = extractUser({ sub: 'x', preferred_username: 'ivan' });
    expect(user.roles).toEqual(['USER']);
  });
});

describe('oidc extractUserFromTokens', () => {
  it('берёт роли из access_token, если в id_token их нет', () => {
    const user = extractUserFromTokens(
      { sub: 'x', preferred_username: 'ivan' },
      { realm_access: { roles: ['admin'] } },
    );
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('приоритет отдаёт ролям из id_token', () => {
    const user = extractUserFromTokens(
      { realm_access: { roles: ['user'] } },
      { realm_access: { roles: ['admin'] } },
    );
    expect(user.roles).toEqual(['USER']);
  });

  it('возвращает дефолт USER, когда ролей нет ни в одном токене', () => {
    const user = extractUserFromTokens({}, {});
    expect(user.roles).toEqual(['USER']);
  });
});

// AD-OIDC: проверка issuer/audience (ранее jwtVerify(token, jwks) без опций).
// Реальный OIDC-провайдер поднимается локально (discovery + JWKS), токены
// подписываются сгенерированным ключом — проверяется вся цепочка jose.
describe('OidcClient: проверка issuer и audience', () => {
  let server: Server;
  let issuer: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let client: OidcClient;

  const CLIENT_ID = 'synth-web';

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    const jwks = { keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] };

    server = createServer((req, res) => {
      if (req.url?.startsWith('/.well-known/openid-configuration')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }));
        return;
      }
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(jwks));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    issuer = `http://127.0.0.1:${port}`;
    client = new OidcClient({
      issuer,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5002/auth/callback',
    });
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  /** Подписать JWT с заданными issuer/audience (роль admin в realm_access). */
  const mint = (opts: { audience: string | string[]; issuer?: string }): Promise<string> =>
    new SignJWT({ preferred_username: 'ivan', realm_access: { roles: ['admin'] } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  it('корректный id_token (iss + aud=clientId) → пользователь', async () => {
    const token = await mint({ audience: CLIENT_ID });
    const user = await client.verifyToken(token);
    expect(user.username).toBe('ivan');
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('неверный issuer → отказ', async () => {
    const token = await mint({ audience: CLIENT_ID, issuer: 'https://evil.example/realms/x' });
    await expect(client.verifyToken(token)).rejects.toThrow();
  });

  it('неверный audience (чужой клиент) → отказ', async () => {
    const token = await mint({ audience: 'other-app' });
    await expect(client.verifyToken(token)).rejects.toThrow();
  });

  it('access_token Keycloak (aud=account) через verifyToken → ok', async () => {
    const token = await mint({ audience: 'account' });
    const user = await client.verifyToken(token);
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('verifyTokens: id_token (aud=clientId) + access_token (aud=account) → ok', async () => {
    const idToken = await mint({ audience: CLIENT_ID });
    const accessToken = await mint({ audience: 'account' });
    const user = await client.verifyTokens(idToken, accessToken);
    expect(user.username).toBe('ivan');
    expect(user.roles).toEqual(['ADMIN']);
  });

  it('verifyTokens: чужой audience access_token → отказ', async () => {
    const idToken = await mint({ audience: CLIENT_ID });
    const accessToken = await mint({ audience: 'other-app' });
    await expect(client.verifyTokens(idToken, accessToken)).rejects.toThrow();
  });

  it('verifyTokens: неверный issuer id_token → отказ', async () => {
    const idToken = await mint({ audience: CLIENT_ID, issuer: 'https://evil.example/realms/x' });
    const accessToken = await mint({ audience: 'account' });
    await expect(client.verifyTokens(idToken, accessToken)).rejects.toThrow();
  });
});
