import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAuth } from '../../auth/local.js';
import { createAuthRoutes, type AuthRoutesRemoteDeps } from './auth.js';
import { RemoteConnection } from '../../remote/connection.js';
import { RemoteError } from '../../remote/types.js';

// Реестр профилей изолируем: даже если граф теста дотянется до app.ts (авто-логин
// → /auth/status → getHybridState), дефолтный путь ~/.config/synth/profiles.json
// не должен читаться. Мок = «реестр пуст».
vi.mock('../../profiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profiles.js')>();
  return {
    ...actual,
    listProfiles: async () => [],
    getLastProfile: async () => null,
  };
});

const COOKIE_NAME = 'synth_session';
const API_KEY = 'test-key';
const BACKEND = 'https://backend.test';
const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'synth-cli';
const SERVER_USER = { id: 'u-1', username: 'lucky', roles: ['ADMIN', 'USER'] };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractCookieValue(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

/** fetch-мок ROPC: oidc-meta → token_endpoint → backend /auth/status. */
function ropcFetchMock(opts: { tokenStatus?: number; tokenBody?: Record<string, unknown> } = {}) {
  const { tokenStatus = 200, tokenBody } = opts;
  return vi.fn((url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/auth/oidc-meta')) {
      return Promise.resolve(jsonResponse({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID }));
    }
    if (u.includes('/protocol/openid-connect/token')) {
      if (tokenStatus !== 200) {
        return Promise.resolve(jsonResponse(tokenBody ?? { error: 'invalid_grant' }, tokenStatus));
      }
      return Promise.resolve(jsonResponse(tokenBody ?? {
        access_token: 'at-ropc',
        refresh_token: 'rt-ropc',
        expires_in: 300,
      }));
    }
    if (u.includes('/auth/status')) {
      return Promise.resolve(jsonResponse({
        authenticated: true,
        oidc_enabled: true,
        user: SERVER_USER,
      }));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  });
}

/**
 * Собрать deps auth-роутов: реальный RemoteConnection (fallback issuer/clientId
 * из констант) + обёртки connect*, как их создаёт createStandaloneApp.
 * connectRemote ходит реальным ROPC через замоканный fetch.
 */
function makeDeps(
  overrides: Partial<AuthRoutesRemoteDeps> = {},
  opts: { tmpDir?: string } = {},
): AuthRoutesRemoteDeps {
  const connection = new RemoteConnection({
    credentialsPath: opts.tmpDir ? join(opts.tmpDir, 'credentials.json') : undefined,
    defaultIssuer: ISSUER,
    defaultClientId: CLIENT_ID,
    timeoutMs: 5000,
  });
  return {
    connection,
    connectRemote: async (serverUrl: string, username: string, password: string) =>
      connection.connectByPassword(serverUrl, username, password),
    connectRemoteFromSaved: async () => null,
    connectRemoteWithApiKey: async (serverUrl: string, apiKey: string) =>
      connection.connectWithApiKey(serverUrl, apiKey),
    disconnectRemote: async () => {
      connection.disconnect();
    },
    ...overrides,
  };
}

describe('auth routes (гибридная runtime-личность, RemoteConnection)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-auth-routes-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeApp(deps: AuthRoutesRemoteDeps) {
    const auth = createLocalAuth({ apiKey: API_KEY });
    return new Hono().route('/auth', createAuthRoutes(auth, deps));
  }

  describe('POST /auth/login (ROPC, runtime)', () => {
    it('ставит server-cookie и возвращает серверного юзера (defaultBackendUrl)', async () => {
      vi.stubGlobal('fetch', ropcFetchMock());
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { id: string; username: string; roles: string[] } };
      expect(body.user.username).toBe('lucky');
      expect(body.user.roles).toEqual(['ADMIN', 'USER']);

      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toBeDefined();
      expect(extractCookieValue(setCookie)).not.toBeNull();

      // с cookie /auth/me отдаёт серверного юзера
      const me = await app.request('/auth/me', {
        headers: { Cookie: `${COOKIE_NAME}=${extractCookieValue(setCookie)!}` },
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { username: string; roles: string[] };
      expect(meBody.username).toBe('lucky');
      expect(meBody.roles).toEqual(['ADMIN', 'USER']);
    });

    it('не подключено и server не задан → 400 «Не указан адрес сервера»', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toContain('Не указан адрес сервера');
    });

    it('server в body + правильный пароль → 200 + cookie', async () => {
      vi.stubGlobal('fetch', ropcFetchMock());
      const app = makeApp(makeDeps({}, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: `${BACKEND}/`, username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
      expect(extractCookieValue(res.headers.get('Set-Cookie'))).not.toBeNull();
    });

    it('неверный логин/пароль → 401 с русским сообщением, cookie не ставится', async () => {
      vi.stubGlobal('fetch', ropcFetchMock({ tokenStatus: 401, tokenBody: { error: 'invalid_grant' } }));
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lucky', password: 'wrong' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('Неверный логин или пароль');
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });

    it('пустые username/password → 400 VALIDATION_ERROR', async () => {
      vi.stubGlobal('fetch', ropcFetchMock());
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '', password: '' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('сервер недоступен (OFFLINE) → 502 { error: { code: OFFLINE } }', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lucky', password: 'secret' }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('OFFLINE');
    });
  });

  describe('POST /auth/login (runtime-вход, смена сервера на лету)', () => {
    const OTHER = 'https://other.test';

    it('нейтральный процесс + server в body → обычный runtime-вход (connectRemote) + rememberServer', async () => {
      const connectRemote = vi.fn().mockResolvedValue(SERVER_USER);
      const rememberServer = vi.fn().mockResolvedValue(undefined);
      const app = makeApp(makeDeps({
        connectRemote,
        rememberServer,
      }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: BACKEND, username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
      // Вход выполнен в runtime-состояние процесса (без 409/перезапуска).
      expect(connectRemote).toHaveBeenCalledWith(BACKEND, 'lucky', 'secret');
      // Мета-профиль обновлён в реестре (lastUsedAt/lastProfileId/username).
      expect(rememberServer).toHaveBeenCalledWith(BACKEND, 'lucky');
    });

    it('процесс привязан (defaultBackendUrl=A) + server=B → runtime-переключение на B (без 409)', async () => {
      const connectRemote = vi.fn().mockResolvedValue(SERVER_USER);
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND, connectRemote }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: OTHER, username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
      expect(connectRemote).toHaveBeenCalledWith(OTHER, 'lucky', 'secret');
    });

    it('процесс привязан (defaultBackendUrl=A) + server=A → обычный runtime-вход', async () => {
      const connectRemote = vi.fn().mockResolvedValue(SERVER_USER);
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND, connectRemote }, { tmpDir }));

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: BACKEND, username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
      expect(connectRemote).toHaveBeenCalledWith(BACKEND, 'lucky', 'secret');
    });

    it('rememberServer падает → вход всё равно успешен (best-effort, без 500)', async () => {
      const rememberServer = vi.fn().mockRejectedValue(new Error('registry write failed'));
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND, rememberServer }, { tmpDir }));
      vi.stubGlobal('fetch', ropcFetchMock());

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'lucky', password: 'secret' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
      expect(rememberServer).toHaveBeenCalled();
    });
  });

  describe('POST /auth/logout (runtime-выход)', () => {
    it('вызывает logoutRemote и очищает cookie', async () => {
      const logoutRemote = vi.fn().mockResolvedValue(undefined);
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND, logoutRemote }, { tmpDir }));

      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(204);
      expect(logoutRemote).toHaveBeenCalledTimes(1);
    });

    it('logoutRemote падает → всё равно 204 и cookie очищена (best-effort)', async () => {
      const logoutRemote = vi.fn().mockRejectedValue(new Error('revoke failed'));
      const app = makeApp(makeDeps({ defaultBackendUrl: BACKEND, logoutRemote }, { tmpDir }));

      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(204);
      expect(logoutRemote).toHaveBeenCalledTimes(1);
    });

    it('без logoutRemote (нет гибрида) → просто очистка cookie, 204', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));
      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(204);
    });
  });

  describe('GET /auth/status (авто-логин)', () => {
    it('не подключено + сохранённые credentials (connectRemoteFromSaved) → server-cookie и user', async () => {
      const connectRemoteFromSaved = vi.fn().mockResolvedValue(SERVER_USER);
      const app = makeApp(makeDeps({ connectRemoteFromSaved, defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean; user: { username: string; roles: string[] } };
      expect(body.authenticated).toBe(true);
      expect(body.user.username).toBe('lucky');
      expect(body.user.roles).toEqual(['ADMIN', 'USER']);
      expect(connectRemoteFromSaved).toHaveBeenCalledWith(BACKEND);
      expect(extractCookieValue(res.headers.get('Set-Cookie'))).not.toBeNull();
    });

    it('нет credentials (connectRemoteFromSaved → null) → authenticated:false, cookie не ставится', async () => {
      const connectRemoteFromSaved = vi.fn().mockResolvedValue(null);
      const app = makeApp(makeDeps({ connectRemoteFromSaved, defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/status');
      const body = (await res.json()) as { authenticated: boolean; user: null };
      expect(body.authenticated).toBe(false);
      expect(body.user).toBeNull();
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });

    it('без cookie, но connection уже подключён → user из runtime-сессии + cookie', async () => {
      vi.stubGlobal('fetch', ropcFetchMock());
      const deps = makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir });
      // Реальный ROPC-вход: connection.connected становится true.
      await deps.connectRemote(BACKEND, 'lucky', 'secret');
      expect(deps.connection.connected).toBe(true);

      const app = makeApp(deps);
      const res = await app.request('/auth/status');
      const body = (await res.json()) as { authenticated: boolean; user: { username: string } };
      expect(body.authenticated).toBe(true);
      expect(body.user.username).toBe('lucky');
      expect(extractCookieValue(res.headers.get('Set-Cookie'))).not.toBeNull();
    });

    it('connectRemoteFromSaved падает (OFFLINE) → authenticated:false, запрос не падает', async () => {
      const connectRemoteFromSaved = vi.fn().mockRejectedValue(new RemoteError('Сервер недоступен', 'OFFLINE'));
      const app = makeApp(makeDeps({ connectRemoteFromSaved, defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean };
      expect(body.authenticated).toBe(false);
    });

    it('oidc_enabled: true при defaultBackendUrl, false без гибрида', async () => {
      const withServer = makeApp(makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir }));
      const res1 = await withServer.request('/auth/status');
      expect(((await res1.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(true);

      const without = makeApp(makeDeps({}, { tmpDir }));
      const res2 = await without.request('/auth/status');
      expect(((await res2.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(false);
    });

    it('oidc_enabled: true при issuerAvailable (--oidc-issuer без --connect), false без него', async () => {
      // Запуск без адреса сервера, но с OIDC fallback-параметрами: UI показывает
      // серверную форму логина (с полем адреса), а не API-ключ.
      const withIssuer = makeApp(makeDeps({ issuerAvailable: true }, { tmpDir }));
      const res1 = await withIssuer.request('/auth/status');
      expect(((await res1.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(true);

      const without = makeApp(makeDeps({ issuerAvailable: false }, { tmpDir }));
      const res2 = await without.request('/auth/status');
      expect(((await res2.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(false);
    });

    it('oidc_enabled: true при hybridEnabled (remote.enabled без адреса), false без гибрида', async () => {
      // Гибрид включён (remote.enabled:true), но адрес/issuer/подключение не заданы:
      // UI должен показать форму входа с полем «Адрес сервера» (oidc_enabled=true),
      // а не API-ключ. Это и есть баг-кейс из LU-задачи (поле адреса скрыто).
      const withHybrid = makeApp(makeDeps({ hybridEnabled: true }, { tmpDir }));
      const res1 = await withHybrid.request('/auth/status');
      expect(((await res1.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(true);

      const without = makeApp(makeDeps({ hybridEnabled: false }, { tmpDir }));
      const res2 = await without.request('/auth/status');
      expect(((await res2.json()) as { oidc_enabled: boolean }).oidc_enabled).toBe(false);
    });
  });

  describe('GET /auth/session', () => {
    it('авто-логин из connectRemoteFromSaved → { user }', async () => {
      const connectRemoteFromSaved = vi.fn().mockResolvedValue(SERVER_USER);
      const app = makeApp(makeDeps({ connectRemoteFromSaved, defaultBackendUrl: BACKEND }, { tmpDir }));

      const res = await app.request('/auth/session');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe('lucky');
    });

    it('без возможности авто-логина → 401', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));
      const res = await app.request('/auth/session');
      expect(res.status).toBe(401);
      const body = (await res.json()) as { user: null };
      expect(body.user).toBeNull();
    });
  });

  /** fetch-мок device flow: oidc-meta/oidc-config → device endpoint → token endpoint → /auth/status. */
  function deviceFlowFetchMock(opts: { tokenAttemptsPending?: number; interval?: number } = {}) {
    const { tokenAttemptsPending = 0, interval = 1 } = opts;
    let tokenAttempts = 0;
    return vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/auth/oidc-meta') || u.includes('/.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse({
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/device`,
          issuer: ISSUER,
          enabled: true,
          clientId: CLIENT_ID,
        }));
      }
      if (u.includes('/protocol/openid-connect/device')) {
        return Promise.resolve(jsonResponse({
          device_code: 'dc-1',
          user_code: 'ABCD-EFGH',
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?code=ABCD-EFGH`,
          expires_in: 300,
          interval,
        }));
      }
      if (u.includes('/protocol/openid-connect/token')) {
        tokenAttempts += 1;
        if (tokenAttempts <= tokenAttemptsPending) {
          return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
        }
        return Promise.resolve(jsonResponse({
          access_token: 'at-device',
          refresh_token: 'rt-device',
          expires_in: 300,
        }));
      }
      if (u.includes('/auth/status')) {
        return Promise.resolve(jsonResponse({
          authenticated: true,
          oidc_enabled: true,
          user: SERVER_USER,
        }));
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
  }

  describe('POST /auth/device-start и /auth/device-check (OIDC device flow из UI)', () => {
    it('pending: device-start возвращает verification_uri + user_code, device-check — pending', async () => {
      // interval большой: фоновый poll не завершится до конца теста.
      vi.stubGlobal('fetch', deviceFlowFetchMock({ tokenAttemptsPending: 9999, interval: 300 }));
      const deps = makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir });
      const app = makeApp(deps);

      const start = await app.request('/auth/device-start', { method: 'POST' });
      expect(start.status).toBe(200);
      const startBody = (await start.json()) as {
        status: string;
        verification_uri: string;
        user_code: string;
        verification_uri_complete: string;
      };
      expect(startBody.status).toBe('pending');
      expect(startBody.verification_uri).toBe(`${ISSUER}/device`);
      expect(startBody.user_code).toBe('ABCD-EFGH');
      expect(startBody.verification_uri_complete).toBe(`${ISSUER}/device?code=ABCD-EFGH`);

      const check = await app.request('/auth/device-check', { method: 'POST' });
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ status: 'pending' });
      expect(check.headers.get('Set-Cookie')).toBeNull();
    });

    it('после успешного poll → authenticated: runtime-подключение активировано, server-cookie поставлена', async () => {
      vi.stubGlobal('fetch', deviceFlowFetchMock({ tokenAttemptsPending: 0, interval: 1 }));
      const connectRemoteFromSaved = vi.fn().mockResolvedValue(SERVER_USER);
      const deps = makeDeps({ connectRemoteFromSaved, defaultBackendUrl: BACKEND }, { tmpDir });
      const app = makeApp(deps);

      const start = await app.request('/auth/device-start', { method: 'POST' });
      expect((await start.json()) as { status: string }).toEqual(expect.objectContaining({ status: 'pending' }));

      // Фоновый poll завершается (первая попытка → access_token); ждём статус authenticated.
      let authenticatedCookie: string | null = null;
      await vi.waitFor(async () => {
        const check = await app.request('/auth/device-check', { method: 'POST' });
        const body = (await check.json()) as { status: string; user?: { username: string } };
        if (body.status === 'authenticated') {
          authenticatedCookie = extractCookieValue(check.headers.get('Set-Cookie'));
        }
        expect(body.status).toBe('authenticated');
      }, { timeout: 5000 });

      // Серверный пользователь + server-cookie работает (/auth/me с cookie).
      expect(authenticatedCookie).not.toBeNull();
      expect(connectRemoteFromSaved).toHaveBeenCalledWith(BACKEND);
      const me = await app.request('/auth/me', {
        headers: { Cookie: `${COOKIE_NAME}=${authenticatedCookie}` },
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { username: string; roles: string[] };
      expect(meBody.username).toBe('lucky');
      expect(meBody.roles).toEqual(['ADMIN', 'USER']);
    });

    it('already_authenticated: connection уже подключён — device flow не запускается', async () => {
      vi.stubGlobal('fetch', ropcFetchMock());
      const deps = makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir });
      await deps.connectRemote(BACKEND, 'lucky', 'secret');
      expect(deps.connection.connected).toBe(true);

      const app = makeApp(deps);
      const res = await app.request('/auth/device-start', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'already_authenticated' });
    });

    it('без сервера (нет defaultBackendUrl и подключения) → 400', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));
      const res = await app.request('/auth/device-start', { method: 'POST' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toContain('Гибридный режим не настроен');
    });

    it('сервер не отдаёт OIDC-мету без fallback → 400 AUTH_ERROR', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'server_error' }, 500)));
      // Connection без defaultIssuer/defaultClientId — fallback недоступен.
      const connection = new RemoteConnection({ credentialsPath: join(tmpDir, 'credentials.json'), timeoutMs: 5000 });
      const deps = makeDeps({}, {});
      deps.connection = connection;
      deps.defaultBackendUrl = BACKEND;
      const app = makeApp(deps);

      const res = await app.request('/auth/device-start', { method: 'POST' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_ERROR');
    });

    it('device-check без активного flow → error', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));
      const res = await app.request('/auth/device-check', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; message: string };
      expect(body.status).toBe('error');
      expect(body.message).toContain('Нет активного процесса');
    });
  });

  describe('GET/PUT /auth/profile (прокси на backend)', () => {
    it('в гибриде (подключено) проксирует на backend и возвращает серверный профиль', async () => {
      const profile = { username: 'lucky', roles: ['ADMIN'], preferences: { theme: 'dark' } };
      vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, _init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/auth/oidc-meta')) {
          return Promise.resolve(jsonResponse({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID }));
        }
        if (u.includes('/protocol/openid-connect/token')) {
          return Promise.resolve(jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 300 }));
        }
        if (u.includes('/auth/status')) {
          return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
        }
        if (u.includes('/auth/profile')) {
          return Promise.resolve(jsonResponse(profile));
        }
        return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      }));

      const deps = makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir });
      await deps.connectRemote(BACKEND, 'lucky', 'secret');
      const app = makeApp(deps);

      const res = await app.request('/auth/profile');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(profile);
    });

    it('в гибриде PUT /auth/profile проксирует тело на backend', async () => {
      vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/auth/oidc-meta')) {
          return Promise.resolve(jsonResponse({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID }));
        }
        if (u.includes('/protocol/openid-connect/token')) {
          return Promise.resolve(jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 300 }));
        }
        if (u.includes('/auth/status')) {
          return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
        }
        if (u.includes('/auth/profile')) {
          const method = init?.method ?? 'GET';
          return Promise.resolve(jsonResponse({ status: 'ok', method }));
        }
        return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      }));

      const deps = makeDeps({ defaultBackendUrl: BACKEND }, { tmpDir });
      await deps.connectRemote(BACKEND, 'lucky', 'secret');
      const app = makeApp(deps);

      const res = await app.request('/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { theme: 'dark' } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', method: 'PUT' });
    });

    it('в локальном режиме (без подключения) — минимальный профиль из локального юзера', async () => {
      const app = makeApp(makeDeps({}, { tmpDir }));

      const login = await app.request('/auth/spa-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: API_KEY }),
      });
      const cookie = extractCookieValue(login.headers.get('Set-Cookie'))!;

      const res = await app.request('/auth/profile', {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { username: string; roles: string[] };
      expect(body.username).toBe('local');
      expect(body.roles).toEqual(['USER']);
    });
  });
});
