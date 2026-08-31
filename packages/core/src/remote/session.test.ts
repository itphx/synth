import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteSession } from './session.js';
import type { RemoteSessionOptions } from './session.js';
import { loadCredentials, saveCredentials } from './credentials.js';
import { RemoteError } from './types.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DISCOVERY = {
  issuer: 'https://issuer.test',
  token_endpoint: 'https://issuer.test/token',
  device_authorization_endpoint: 'https://issuer.test/device',
};

/**
 * fetch-мок, выполняющий весь device flow: discovery → device-authorization → token.
 * На token_endpoint сразу возвращает access token (без pending-петель — «фейковый poll»).
 * Для refresh-гранта (grant_type=refresh_token) возвращает at-refreshed/rt-refreshed.
 */
function deviceFlowFetchMock() {
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('.well-known/openid-configuration')) {
      return Promise.resolve(jsonResponse(DISCOVERY));
    }
    if (u.includes('/device')) {
      return Promise.resolve(jsonResponse({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://issuer.test/device',
        expires_in: 600,
        interval: 1,
      }));
    }
    if (u.includes('/token')) {
      const body = init?.body instanceof URLSearchParams ? init.body : null;
      if (body?.get('grant_type') === 'refresh_token') {
        return Promise.resolve(jsonResponse({
          access_token: 'at-refreshed',
          refresh_token: 'rt-refreshed',
          expires_in: 3600,
        }));
      }
      return Promise.resolve(jsonResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
      }));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteSession.ensureAuthenticated', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-session-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function credsPath(name = 'credentials.json'): string {
    return join(dir, name);
  }

  function deviceOpts(overrides: Partial<RemoteSessionOptions> = {}): RemoteSessionOptions {
    return {
      backendUrl: 'https://backend.test',
      authType: 'device',
      issuer: 'https://issuer.test',
      clientId: 'client-1',
      credentialsPath: credsPath(),
      ...overrides,
    };
  }

  it('успешный device flow: вызывает onDeviceCode, сохраняет credentials, клиент ходит с токеном', async () => {
    vi.stubGlobal('fetch', deviceFlowFetchMock());
    const onDeviceCode = vi.fn();

    const session = await RemoteSession.ensureAuthenticated(deviceOpts(), onDeviceCode);

    expect(onDeviceCode).toHaveBeenCalledWith({
      verificationUri: 'https://issuer.test/device',
      userCode: 'ABCD-EFGH',
    });
    expect(session.backendUrl).toBe('https://backend.test');
    expect(session.authType).toBe('device');

    const saved = await loadCredentials('https://backend.test', credsPath());
    expect(saved?.accessToken).toBe('at-1');
    expect(saved?.refreshToken).toBe('rt-1');

    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, oidc_enabled: true }));
    vi.stubGlobal('fetch', authFetch);
    await session.getClient().getAuthStatus();
    expect(authFetch).toHaveBeenCalledWith(
      'https://backend.test/auth/status',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer at-1' }),
      }),
    );
  });

  it('сохранённый accessToken действителен → используется без запросов к OIDC', async () => {
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-valid',
      refreshToken: 'rt-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, credsPath());

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const session = await RemoteSession.ensureAuthenticated(deviceOpts());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.getClient()).toBeDefined();
    const saved = await loadCredentials('https://backend.test', credsPath());
    expect(saved?.accessToken).toBe('at-valid');
  });

  it('просроченный accessToken + refreshToken → refresh и сохранение обновлённых credentials', async () => {
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: '2020-01-01T00:00:00.000Z',
      user: { id: 'u1', username: 'admin', roles: ['ADMIN'] },
    }, credsPath());

    vi.stubGlobal('fetch', deviceFlowFetchMock());

    const session = await RemoteSession.ensureAuthenticated(deviceOpts());

    const saved = await loadCredentials('https://backend.test', credsPath());
    expect(saved?.accessToken).toBe('at-refreshed');
    expect(saved?.refreshToken).toBe('rt-refreshed');
    expect(saved?.user?.username).toBe('admin'); // user сохраняется при refresh

    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, oidc_enabled: true }));
    vi.stubGlobal('fetch', authFetch);
    await session.getClient().getAuthStatus();
    expect(authFetch).toHaveBeenCalledWith(
      'https://backend.test/auth/status',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer at-refreshed' }),
      }),
    );
  });

  it('api_key: токен = apiKey, credentials не сохраняются', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const session = await RemoteSession.ensureAuthenticated({
      backendUrl: 'https://backend.test',
      authType: 'api_key',
      apiKey: 'key-1',
      credentialsPath: credsPath(),
    });

    expect(session.authType).toBe('api_key');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await loadCredentials('https://backend.test', credsPath())).toBeNull();

    const authFetch = vi.fn().mockResolvedValue(jsonResponse({ authenticated: true, oidc_enabled: true }));
    vi.stubGlobal('fetch', authFetch);
    await session.getClient().getAuthStatus();
    expect(authFetch).toHaveBeenCalledWith(
      'https://backend.test/auth/status',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key-1' }),
      }),
    );
  });

  it('api_key без ключа → RemoteError(AUTH)', async () => {
    const err = await RemoteSession.ensureAuthenticated({
      backendUrl: 'https://backend.test',
      authType: 'api_key',
      credentialsPath: credsPath(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
  });

  it('нет issuer/clientId и нет credentials → RemoteError(AUTH) с понятным сообщением', async () => {
    const err = await RemoteSession.ensureAuthenticated({
      backendUrl: 'https://backend.test',
      authType: 'device',
      credentialsPath: credsPath(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect((err as RemoteError).message).toContain('issuer/clientId');
  });

  it('просрочен + refreshToken, но нет issuer/clientId → RemoteError(AUTH)', async () => {
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }, credsPath());

    const err = await RemoteSession.ensureAuthenticated({
      backendUrl: 'https://backend.test',
      authType: 'device',
      credentialsPath: credsPath(),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
  });

  it('refresh не удался (invalid_grant) → повторный device flow и пересохранение credentials', async () => {
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-old',
      refreshToken: 'rt-dead',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }, credsPath());

    // token_endpoint для refresh-гранта отвечает invalid_grant, для device-гранта — валидным токеном
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      if (u.includes('/device')) {
        return Promise.resolve(jsonResponse({
          device_code: 'dc-2',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://issuer.test/device',
          expires_in: 600,
          interval: 1,
        }));
      }
      if (u.includes('/token')) {
        const body = init?.body instanceof URLSearchParams ? init.body : null;
        if (body?.get('grant_type') === 'refresh_token') {
          return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400));
        }
        return Promise.resolve(jsonResponse({ access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 }));
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDeviceCode = vi.fn();

    await RemoteSession.ensureAuthenticated(deviceOpts(), onDeviceCode);

    expect(onDeviceCode).toHaveBeenCalledTimes(1);
    const saved = await loadCredentials('https://backend.test', credsPath());
    expect(saved?.accessToken).toBe('at-fresh');
    expect(saved?.refreshToken).toBe('rt-fresh');
  });

  it('getAuthStatus: OFFLINE → connected:false', async () => {
    vi.stubGlobal('fetch', deviceFlowFetchMock());
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const status = await session.getAuthStatus();
    expect(status).toEqual({ connected: false, backendUrl: 'https://backend.test' });
  });

  it('getAuthStatus: авторизован → connected:true + user', async () => {
    vi.stubGlobal('fetch', deviceFlowFetchMock());
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      authenticated: true,
      oidc_enabled: true,
      user: { id: 'u1', username: 'admin', roles: ['ADMIN'] },
    })));
    const status = await session.getAuthStatus();
    expect(status.connected).toBe(true);
    expect(status.user?.username).toBe('admin');
  });

  it('disconnect удаляет сохранённые credentials', async () => {
    vi.stubGlobal('fetch', deviceFlowFetchMock());
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());
    expect(await loadCredentials('https://backend.test', credsPath())).not.toBeNull();

    await session.disconnect();
    expect(await loadCredentials('https://backend.test', credsPath())).toBeNull();
  });
});

describe('RemoteSession.getToken (Часть 6)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-session-token-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function credsPath(name = 'credentials.json'): string {
    return join(dir, name);
  }

  function deviceOpts(overrides: Partial<RemoteSessionOptions> = {}): RemoteSessionOptions {
    return {
      backendUrl: 'https://backend.test',
      authType: 'device',
      issuer: 'https://issuer.test',
      clientId: 'client-1',
      credentialsPath: credsPath(),
      ...overrides,
    };
  }

  it('api_key → возвращает apiKey', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const session = await RemoteSession.ensureAuthenticated({
      backendUrl: 'https://backend.test',
      authType: 'api_key',
      apiKey: 'key-1',
      credentialsPath: credsPath(),
    });
    expect(await session.getToken()).toBe('key-1');
  });

  it('device с действительным accessToken → возвращает его без запросов к OIDC', async () => {
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-valid',
      refreshToken: 'rt-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, credsPath());

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());
    expect(await session.getToken()).toBe('at-valid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('протух + refreshToken → refresh в рантайме, возвращает новый токен, credentials пересохранены', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-soon-expired',
      refreshToken: 'rt-1',
      expiresAt: '2026-01-01T00:00:30.000Z',
    }, credsPath());

    vi.stubGlobal('fetch', deviceFlowFetchMock());
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());

    // Токен был действителен при создании сессии — «протухает» в рантайме.
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    expect(await session.getToken()).toBe('at-refreshed');

    const saved = await loadCredentials('https://backend.test', credsPath());
    expect(saved?.accessToken).toBe('at-refreshed');
    expect(saved?.refreshToken).toBe('rt-refreshed');
  });

  it('протух без refreshToken → null', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-soon-expired',
      // refreshToken отсутствует
      expiresAt: '2026-01-01T00:00:30.000Z',
    }, credsPath());

    vi.stubGlobal('fetch', vi.fn());
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    expect(await session.getToken()).toBeNull();
  });

  it('refresh недействителен (RemoteError AUTH) → null, без исключения', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-soon-expired',
      refreshToken: 'rt-dead',
      expiresAt: '2026-01-01T00:00:30.000Z',
    }, credsPath());

    // OIDC-провайдер отвечает на refresh-грант invalid_grant (400 + { error })
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      if (u.includes('/token')) {
        const body = init?.body instanceof URLSearchParams ? init.body : null;
        if (body?.get('grant_type') === 'refresh_token') {
          return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400));
        }
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = await RemoteSession.ensureAuthenticated(deviceOpts());
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    // getToken НЕ роняет поток — возвращает null (запрос уйдёт без токена → 401)
    expect(await session.getToken()).toBeNull();
  });

  it('сеть недоступна при refresh → null, без исключения', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await saveCredentials({
      backendUrl: 'https://backend.test',
      accessToken: 'at-soon-expired',
      refreshToken: 'rt-1',
      expiresAt: '2026-01-01T00:00:30.000Z',
    }, credsPath());

    const session = await RemoteSession.ensureAuthenticated(deviceOpts());
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));

    // Сеть падает во время refresh (и discovery, и token_endpoint)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    expect(await session.getToken()).toBeNull();
  });
});
