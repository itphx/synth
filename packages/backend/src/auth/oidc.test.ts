import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { extractGroups, extractUser, extractUserFromTokens, oidcUserToUser, OidcClient } from './oidc.js';
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

/**
 * ADR-140 Ф2: источник групп — claim `groups` из IdP + allowlist имён.
 * Пустой allowlist — групп нет (fail-closed), «принять все» невозможно.
 */
describe('oidc extractGroups', () => {
  const CFG = { claim: 'groups', allow: ['team-a', 'team-b'] };

  it('берёт группы из claim и фильтрует по allowlist', () => {
    const groups = extractGroups({ groups: ['team-a', 'team-c', 'team-b'] }, CFG);
    expect(groups).toEqual(['team-a', 'team-b']);
  });

  it('claim отсутствует → пустой список', () => {
    expect(extractGroups({}, CFG)).toEqual([]);
  });

  it('claim не массив → пустой список (без throw)', () => {
    expect(extractGroups({ groups: 'team-a' }, CFG)).toEqual([]);
    expect(extractGroups({ groups: { '0': 'team-a' } }, CFG)).toEqual([]);
  });

  it('пустой allowlist → пустой список (fail-closed, не «принять все»)', () => {
    expect(extractGroups({ groups: ['team-a'] }, { claim: 'groups', allow: [] })).toEqual([]);
    expect(extractGroups({ groups: ['team-a'] }, undefined)).toEqual([]);
    expect(extractGroups({ groups: ['team-a'] }, {})).toEqual([]);
  });

  it('нормализация: trim, дедуп, только строки, порядок claim', () => {
    const groups = extractGroups(
      { groups: [' team-a ', 'team-a', 42, null, 'team-b', '  '] },
      CFG,
    );
    expect(groups).toEqual(['team-a', 'team-b']);
  });

  it('сравнение с allowlist — точное (регистрозависимо)', () => {
    const groups = extractGroups({ groups: ['Team-A', 'TEAM-A', 'team-a'] }, CFG);
    expect(groups).toEqual(['team-a']);
  });

  it('неизвестный claim → пустой список; кастомное имя claim поддерживается', () => {
    expect(extractGroups({ groups: ['team-a'] }, { claim: 'other', allow: ['team-a'] })).toEqual([]);
    expect(
      extractGroups({ other: ['team-a'] }, { claim: 'other', allow: ['team-a'] }),
    ).toEqual(['team-a']);
  });

  it('пустое имя claim → дефолтное имя groups', () => {
    expect(extractGroups({ groups: ['team-a'] }, { claim: '  ', allow: ['team-a'] }))
      .toEqual(['team-a']);
  });
});

describe('oidc extractUser/extractUserFromTokens — группы', () => {
  const CFG = { claim: 'groups', allow: ['team-a'] };

  it('extractUser кладёт группы из claim', () => {
    const user = extractUser({ sub: 'x', groups: ['team-a', 'other'] }, undefined, CFG);
    expect(user.groups).toEqual(['team-a']);
  });

  it('extractUser без групп → пустой список', () => {
    const user = extractUser({ sub: 'x' }, undefined, CFG);
    expect(user.groups).toEqual([]);
  });

  it('extractUserFromTokens: fallback на access_token, если в id_token групп нет', () => {
    const user = extractUserFromTokens(
      { sub: 'x' },
      { groups: ['team-a'] },
      undefined,
      CFG,
    );
    expect(user.groups).toEqual(['team-a']);
  });

  it('extractUserFromTokens: приоритет отдаёт группам из id_token', () => {
    const user = extractUserFromTokens(
      { groups: ['team-a'] },
      { groups: ['team-b'] },
      undefined,
      { claim: 'groups', allow: ['team-a', 'team-b'] },
    );
    expect(user.groups).toEqual(['team-a']);
  });

  it('extractUserFromTokens: групп нет ни там, ни там → пустой список', () => {
    const user = extractUserFromTokens({}, {}, undefined, CFG);
    expect(user.groups).toEqual([]);
  });
});

describe('oidc oidcUserToUser — перенос групп', () => {
  it('непустой список групп попадает в User.groups', () => {
    const user = oidcUserToUser({
      id: 'u1',
      username: 'ivan',
      roles: ['USER'],
      groups: ['team-a'],
    });
    expect(user.groups).toEqual(['team-a']);
  });

  it('пустой список / отсутствие поля → groups в User нет', () => {
    expect(oidcUserToUser({ id: 'u1', username: 'ivan', roles: ['USER'] }).groups)
      .toBeUndefined();
    expect(oidcUserToUser({ id: 'u1', username: 'ivan', roles: ['USER'], groups: [] }).groups)
      .toBeUndefined();
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
  const mint = (opts: {
    audience: string | string[];
    issuer?: string;
    claims?: Record<string, unknown>;
  }): Promise<string> =>
    new SignJWT({
      preferred_username: 'ivan',
      realm_access: { roles: ['admin'] },
      ...(opts.claims ?? {}),
    })
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

  /**
   * ADR-140 Ф2: клиент с настроенным источником групп читает claim `groups`
   * и отдаёт только allowlist-группы.
   */
  it('verifyToken: claim groups фильтруется allowlist', async () => {
    const groupsClient = new OidcClient({
      issuer,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5002/auth/callback',
      groups: { claim: 'groups', allow: ['team-a'] },
    });
    const token = await mint({
      audience: CLIENT_ID,
      claims: { groups: ['team-a', 'team-b'] },
    });
    const user = await groupsClient.verifyToken(token);
    expect(user.groups).toEqual(['team-a']);
  });

  it('verifyToken: без настроенного allowlist групп нет (fail-closed)', async () => {
    const token = await mint({ audience: CLIENT_ID, claims: { groups: ['team-a'] } });
    const user = await client.verifyToken(token);
    expect(user.groups).toEqual([]);
  });

  it('verifyTokens: группы из access_token, если в id_token их нет', async () => {
    const groupsClient = new OidcClient({
      issuer,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5002/auth/callback',
      groups: { claim: 'groups', allow: ['team-a'] },
    });
    const idToken = await mint({ audience: CLIENT_ID });
    const accessToken = await mint({ audience: 'account', claims: { groups: ['team-a'] } });
    const user = await groupsClient.verifyTokens(idToken, accessToken);
    expect(user.groups).toEqual(['team-a']);
  });
});
