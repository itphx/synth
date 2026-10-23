import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteConnection } from './connection.js';
import { saveCredentials, loadCredentials } from './credentials.js';
import { RemoteError } from './types.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BACKEND = 'https://backend.test';
const ISSUER = 'https://kc.test/realms/synth';
const CLIENT_ID = 'synth-cli';

const OIDC_DISCOVERY = {
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth/device`,
};

const SERVER_USER = { id: 'u-1', username: 'lucky', roles: ['ADMIN', 'USER'] };

/**
 * fetch-мок успешного ROPC-входа: дискавери OIDC-меты на backend, token-грант
 * (grant_type=password) на Keycloak, /auth/status с серверным пользователем.
 */
function passwordFlowFetchMock(overrides: { tokenStatus?: number; tokenBody?: Record<string, unknown> } = {}) {
  const { tokenStatus = 200, tokenBody } = overrides;
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
      return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  });
}

/** fetch-мок для connectFromSaved по протухшим credentials: oidc-meta + refresh-грант + status. */
function refreshFlowFetchMock() {
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/auth/oidc-meta')) {
      return Promise.resolve(jsonResponse({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID }));
    }
    if (u.includes('.well-known/openid-configuration')) {
      return Promise.resolve(jsonResponse(OIDC_DISCOVERY));
    }
    if (u.includes('/protocol/openid-connect/token')) {
      const body = init?.body instanceof URLSearchParams ? init.body : null;
      if (body?.get('grant_type') === 'refresh_token') {
        return Promise.resolve(jsonResponse({
          access_token: 'at-refreshed',
          refresh_token: 'rt-refreshed',
          expires_in: 3600,
        }));
      }
    }
    if (u.includes('/auth/status')) {
      return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteConnection.discoverOidc', () => {
  it('сервер вернул {enabled:true, issuer, clientId} → возвращает их; адрес без завершающего /', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const conn = new RemoteConnection({});
    const meta = await conn.discoverOidc('https://backend.test/');

    expect(meta).toEqual({ issuer: ISSUER, clientId: CLIENT_ID });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/auth/oidc-meta',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('enabled:false → RemoteError(AUTH) с русским сообщением', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ enabled: false })));

    const conn = new RemoteConnection({ defaultIssuer: ISSUER, defaultClientId: CLIENT_ID });
    const err = await conn.discoverOidc(BACKEND).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect((err as RemoteError).message).toContain('не поддерживает вход по логину/паролю');
  });

  it('404 + deps.defaultIssuer/defaultClientId → fallback на дефолты', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not_found' }, 404)));

    const conn = new RemoteConnection({ defaultIssuer: ISSUER, defaultClientId: CLIENT_ID });
    const meta = await conn.discoverOidc(BACKEND);

    expect(meta).toEqual({ issuer: ISSUER, clientId: CLIENT_ID });
  });

  it('404 без fallback → RemoteError(AUTH)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not_found' }, 404)));

    const conn = new RemoteConnection({});
    const err = await conn.discoverOidc(BACKEND).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
  });

  it('сеть недоступна + fallback есть → возвращает дефолты', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const conn = new RemoteConnection({ defaultIssuer: ISSUER, defaultClientId: CLIENT_ID });
    const meta = await conn.discoverOidc(BACKEND);

    expect(meta).toEqual({ issuer: ISSUER, clientId: CLIENT_ID });
  });

  it('сеть недоступна без fallback → RemoteError(OFFLINE)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const conn = new RemoteConnection({});
    const err = await conn.discoverOidc(BACKEND).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('OFFLINE');
  });
});

describe('RemoteConnection.connectByPassword', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-conn-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function credsPath(): string {
    return join(dir, 'credentials.json');
  }

  it('успех: connected, user из /auth/status, client не null, backendUrl без завершающего /', async () => {
    vi.stubGlobal('fetch', passwordFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectByPassword('https://backend.test/', 'lucky', 'secret');

    expect(user).toEqual(SERVER_USER);
    expect(conn.connected).toBe(true);
    expect(conn.backendUrl).toBe(BACKEND);
    expect(conn.client).not.toBeNull();
    expect(conn.user?.username).toBe('lucky');
    expect(conn.issuer).toBe(ISSUER);
    expect(conn.getToken).not.toBeNull();
    expect(await conn.getToken?.()).toBe('at-ropc');

    const saved = await loadCredentials(BACKEND, credsPath());
    expect(saved?.accessToken).toBe('at-ropc');
    expect(saved?.user?.username).toBe('lucky');
  });

  it('неверный пароль → RemoteError(AUTH), connected:false, состояние не фиксируется', async () => {
    vi.stubGlobal('fetch', passwordFlowFetchMock({
      tokenStatus: 401,
      tokenBody: { error: 'invalid_grant', error_description: 'Invalid user credentials' },
    }));

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const err = await conn.connectByPassword(BACKEND, 'lucky', 'wrong').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect((err as RemoteError).message).toContain('Неверный логин или пароль');
    expect(conn.connected).toBe(false);
    expect(conn.user).toBeNull();
    expect(conn.backendUrl).toBeNull();
    expect(conn.client).toBeNull();
    // credentials не сохраняются при ошибке
    expect(await loadCredentials(BACKEND, credsPath())).toBeNull();
  });
});

describe('RemoteConnection.connectWithApiKey', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-conn-apikey-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('успех: connected, user из /auth/status, issuer null (без дискавери)', async () => {
    vi.stubGlobal('fetch', passwordFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    const user = await conn.connectWithApiKey('https://backend.test/', 'api-key-1');

    expect(user).toEqual(SERVER_USER);
    expect(conn.connected).toBe(true);
    expect(conn.backendUrl).toBe(BACKEND);
    expect(conn.client).not.toBeNull();
    expect(conn.user?.username).toBe('lucky');
    expect(conn.issuer).toBeNull();
    expect(await conn.getToken?.()).toBe('api-key-1');
    // api_key-сессия ничего не пишет в credentials (это не OAuth-токен)
    expect(await loadCredentials(BACKEND, join(dir, 'credentials.json'))).toBeNull();
  });

  it('пустой ключ → RemoteError(AUTH)', async () => {
    const conn = new RemoteConnection({});
    const err = await conn.connectWithApiKey(BACKEND, '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect(conn.connected).toBe(false);
  });

  it('backend не отдаёт профиль (/auth/status без user) → RemoteError(AUTH), состояние не фиксируется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ authenticated: true, oidc_enabled: true, user: null }),
    ));

    const conn = new RemoteConnection({});
    const err = await conn.connectWithApiKey(BACKEND, 'api-key-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect(conn.connected).toBe(false);
    expect(conn.backendUrl).toBeNull();
  });

  it('backend недоступен (сеть) → RemoteError(AUTH), состояние не фиксируется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const conn = new RemoteConnection({});
    const err = await conn.connectWithApiKey(BACKEND, 'api-key-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect(conn.connected).toBe(false);
    expect(conn.client).toBeNull();
  });
});

describe('RemoteConnection.connectFromSaved', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-conn-saved-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function credsPath(): string {
    return join(dir, 'credentials.json');
  }

  function validCreds(overrides: Partial<Parameters<typeof saveCredentials>[0]> = {}) {
    return {
      backendUrl: BACKEND,
      accessToken: 'at-valid',
      refreshToken: 'rt-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { id: 'u-saved', username: 'admin', roles: ['ADMIN'] },
      ...overrides,
    };
  }

  it('без credentials → null, connected:false, fetch не вызывался (нет device flow)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectFromSaved(BACKEND);

    expect(user).toBeNull();
    expect(conn.connected).toBe(false);
    expect(conn.user).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('валидный accessToken в credentials → connected, user обновлён с /auth/status', async () => {
    await saveCredentials(validCreds(), credsPath());
    vi.stubGlobal('fetch', passwordFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectFromSaved(BACKEND);

    expect(user?.username).toBe('lucky');
    expect(conn.connected).toBe(true);
    expect(conn.backendUrl).toBe(BACKEND);
    expect(conn.client).not.toBeNull();
    expect(conn.issuer).toBe(ISSUER);
    // токен не обновлялся — в файле остался исходный
    const saved = await loadCredentials(BACKEND, credsPath());
    expect(saved?.accessToken).toBe('at-valid');
  });

  it('протухший accessToken + refreshToken → дискавери + refresh, connected, credentials обновлены', async () => {
    await saveCredentials(validCreds({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: '2020-01-01T00:00:00.000Z',
      user: { id: 'u-saved', username: 'admin', roles: ['ADMIN'] },
    }), credsPath());
    vi.stubGlobal('fetch', refreshFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectFromSaved(BACKEND);

    expect(user?.username).toBe('lucky');
    expect(conn.connected).toBe(true);
    expect(conn.issuer).toBe(ISSUER);

    const saved = await loadCredentials(BACKEND, credsPath());
    expect(saved?.accessToken).toBe('at-refreshed');
    expect(saved?.refreshToken).toBe('rt-refreshed');
  });

  it('backendUrl не передан → берёт сохранённые credentials из файла', async () => {
    await saveCredentials(validCreds(), credsPath());
    vi.stubGlobal('fetch', passwordFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectFromSaved();

    expect(user?.username).toBe('lucky');
    expect(conn.connected).toBe(true);
    expect(conn.backendUrl).toBe(BACKEND);
  });

  it('протух без refreshToken → null, connected:false', async () => {
    await saveCredentials(validCreds({
      accessToken: 'at-old',
      expiresAt: '2020-01-01T00:00:00.000Z',
      refreshToken: undefined,
    }), credsPath());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const conn = new RemoteConnection({ credentialsPath: credsPath() });
    const user = await conn.connectFromSaved(BACKEND);

    expect(user).toBeNull();
    expect(conn.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * ADR-090 Ф7: дискавери серверной политики плагинов.
 *
 * Публичный сигнал (`GET /auth/oidc-meta`) содержит только `{enabled, mode}` —
 * список имён не публичен; полный allow-list клиент берёт из
 * аутентифицированного роута `GET /api/v2/settings/plugins`.
 */
describe('RemoteConnection — политика плагинов сервера (Ф7)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-conn-plugins-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** fetch-мок с сигналом плагинов в `/auth/oidc-meta` и полной политикой. */
  function pluginFlowFetchMock(opts: {
    signal?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    settingsStatus?: number;
  }) {
    return vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/auth/oidc-meta')) {
        return Promise.resolve(jsonResponse({
          enabled: true,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          ...(opts.signal ? { plugins: opts.signal } : {}),
        }));
      }
      if (u.includes('/protocol/openid-connect/token')) {
        return Promise.resolve(jsonResponse({
          access_token: 'at-ropc',
          refresh_token: 'rt-ropc',
          expires_in: 300,
        }));
      }
      if (u.includes('/auth/status')) {
        return Promise.resolve(jsonResponse({ authenticated: true, oidc_enabled: true, user: SERVER_USER }));
      }
      if (u.includes('/api/v2/settings/plugins')) {
        return Promise.resolve(
          jsonResponse(opts.settings ?? {}, opts.settingsStatus ?? 200),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
  }

  it('сигнал plugins из /auth/oidc-meta принимается и сохраняется', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({
      signal: { enabled: true, mode: 'allowlist' },
    }));

    const conn = new RemoteConnection({});
    const meta = await conn.discoverOidc(BACKEND);

    expect(meta.plugins).toEqual({ enabled: true, mode: 'allowlist' });
    expect(conn.pluginSignal).toEqual({ enabled: true, mode: 'allowlist' });
  });

  it('старый сервер без поля plugins → сигнала нет, без падения', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({}));

    const conn = new RemoteConnection({});
    const meta = await conn.discoverOidc(BACKEND);

    expect(meta.plugins).toBeUndefined();
    expect(conn.pluginSignal).toBeUndefined();
  });

  it('мусор в поле plugins → сигнал не принимается (политика неизвестна)', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({ signal: { enabled: true, mode: 'weird' } }));

    const conn = new RemoteConnection({});
    const meta = await conn.discoverOidc(BACKEND);

    expect(meta.plugins).toBeUndefined();
    expect(conn.pluginSignal).toBeUndefined();
  });

  it('refreshPluginPolicy: полный allow-list из /api/v2/settings/plugins', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({
      signal: { enabled: true, mode: 'allowlist' },
      settings: { hybrid: { mode: 'allowlist', allow: ['demo-plugin'] } },
    }));

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    await conn.connectByPassword(BACKEND, 'lucky', 'secret');

    const policy = await conn.refreshPluginPolicy();
    expect(policy).toEqual({ mode: 'allowlist', allow: ['demo-plugin'] });
    expect(conn.pluginPolicy).toEqual({ mode: 'allowlist', allow: ['demo-plugin'] });
  });

  it('refreshPluginPolicy: сервер без блока hybrid → политика неизвестна (undefined)', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({ settings: {} }));

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    await conn.connectByPassword(BACKEND, 'lucky', 'secret');

    expect(await conn.refreshPluginPolicy()).toBeUndefined();
    expect(conn.pluginPolicy).toBeUndefined();
  });

  it('refreshPluginPolicy: сервер недоступен (403) → политика неизвестна, без падения', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({ settingsStatus: 403 }));

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    await conn.connectByPassword(BACKEND, 'lucky', 'secret');

    expect(await conn.refreshPluginPolicy()).toBeUndefined();
  });

  it('disconnect сбрасывает кэш политики', async () => {
    vi.stubGlobal('fetch', pluginFlowFetchMock({
      settings: { hybrid: { mode: 'allowlist', allow: ['demo-plugin'] } },
    }));

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    await conn.connectByPassword(BACKEND, 'lucky', 'secret');
    await conn.refreshPluginPolicy();
    expect(conn.pluginPolicy).not.toBeUndefined();

    conn.disconnect();
    expect(conn.pluginPolicy).toBeUndefined();
    expect(conn.pluginSignal).toBeUndefined();
  });
});

describe('RemoteConnection.disconnect', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-conn-disc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('сбрасывает состояние: connected:false, client null, user null, backendUrl null', async () => {
    vi.stubGlobal('fetch', passwordFlowFetchMock());

    const conn = new RemoteConnection({ credentialsPath: join(dir, 'credentials.json') });
    await conn.connectByPassword(BACKEND, 'lucky', 'secret');
    expect(conn.connected).toBe(true);

    conn.disconnect();

    expect(conn.connected).toBe(false);
    expect(conn.client).toBeNull();
    expect(conn.getToken).toBeNull();
    expect(conn.user).toBeNull();
    expect(conn.backendUrl).toBeNull();
    expect(conn.issuer).toBeNull();
  });
});
