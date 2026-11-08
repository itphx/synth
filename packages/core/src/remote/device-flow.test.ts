import { describe, it, expect, afterEach, vi } from 'vitest';
import { passwordGrant, refreshAccessToken, startDeviceFlow, postFormDetailed } from './device-flow.js';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDeviceFlow', () => {
  it('просит offline_access, а при invalid_scope повторяет без него', async () => {
    const scopes: Array<string | null> = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      if (u.includes('/device')) {
        const body = init?.body instanceof URLSearchParams ? init.body : null;
        const scope = body?.get('scope') ?? null;
        scopes.push(scope);
        if (scope?.includes('offline_access')) {
          return Promise.resolve(jsonResponse({ error: 'invalid_scope' }, 400));
        }
        return Promise.resolve(jsonResponse({
          device_code: 'dc-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://issuer.test/device',
          expires_in: 600,
          interval: 1,
        }));
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await startDeviceFlow('https://issuer.test', 'client-1');

    expect(scopes).toEqual(['openid profile offline_access', 'openid profile']);
    expect(session.deviceCode).toBe('dc-1');
  });

  it('unauthorized_client на device endpoint → RemoteError(AUTH) с текстом ошибки сервера', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      if (u.includes('/device')) {
        return Promise.resolve(jsonResponse({
          error: 'unauthorized_client',
          error_description: 'Invalid client or Invalid client credentials',
        }, 400));
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await startDeviceFlow('https://issuer.test', 'bad-client').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect((err as RemoteError).message).toContain('unauthorized_client');
    expect((err as RemoteError).message).not.toContain('нет device_code');
  });
});

describe('refreshAccessToken', () => {
  it('успешный refresh: возвращает новый access token и шлёт refresh-грант на token_endpoint', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      if (u.includes('/token')) {
        return Promise.resolve(jsonResponse({
          access_token: 'at-new',
          refresh_token: 'rt-new',
          expires_in: 3600,
        }));
      }
      return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-old');

    expect(result).toEqual({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600 });

    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/token'));
    expect(tokenCall).toBeDefined();
    const [, init] = tokenCall!;
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-old');
    expect(params.get('client_id')).toBe('client-1');
  });

  it('refresh без нового refresh_token: возвращает только access token', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      return Promise.resolve(jsonResponse({ access_token: 'at-new', expires_in: 300 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-old');
    expect(result).toEqual({ accessToken: 'at-new', refreshToken: undefined, expiresIn: 300 });
  });

  it('invalid_grant → RemoteError(AUTH)', async () => {
    const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, 400));
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-dead').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
  });

  it('сервер авторизации недоступен (сеть) → RemoteError(OFFLINE), не AUTH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const err = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-old').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    // Сетевой сбой — recoverable network_error, а не «сессия истекла».
    expect((err as RemoteError).code).toBe('OFFLINE');
  });

  it('сеть падает только на token_endpoint (дискавери ок) → RemoteError(OFFLINE)', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('.well-known/openid-configuration')) {
        return Promise.resolve(jsonResponse(DISCOVERY));
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-old').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('OFFLINE');
  });
});

describe('passwordGrant (ROPC) — offline-токен', () => {
  it('по умолчанию шлёт scope=openid offline_access и возвращает refreshExpiresIn', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(
      jsonResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 300,
        refresh_expires_in: 0,
      }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await passwordGrant('https://issuer.test/', 'synth-cli', 'user', 'pass');

    expect(result).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 300,
      refreshExpiresIn: 0,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = (init as RequestInit).body as URLSearchParams;
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('scope')).toBe('openid offline_access');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://issuer.test/protocol/openid-connect/token');
  });

  it('invalid_scope → повтор без offline_access (scope=openid), логин успешен', async () => {
    const scopes: Array<string | null> = [];
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body instanceof URLSearchParams ? init.body : null;
      const scope = body?.get('scope') ?? null;
      scopes.push(scope);
      if (scope?.includes('offline_access')) {
        return Promise.resolve(jsonResponse({ error: 'invalid_scope' }, 400));
      }
      return Promise.resolve(jsonResponse({
        access_token: 'at-plain',
        refresh_token: 'rt-plain',
        expires_in: 300,
        refresh_expires_in: 1800,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await passwordGrant('https://issuer.test', 'synth-cli', 'user', 'pass');

    expect(scopes).toEqual(['openid offline_access', 'openid']);
    expect(result.accessToken).toBe('at-plain');
    expect(result.refreshExpiresIn).toBe(1800);
  });

  it('неверные учётные данные (invalid_grant) → RemoteError(AUTH)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', error_description: 'Invalid user credentials' }, 401),
    ));

    const err = await passwordGrant('https://issuer.test', 'synth-cli', 'user', 'bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
    expect((err as RemoteError).message).toContain('Неверный логин или пароль');
  });
});

describe('postFormDetailed: причина сетевой ошибки', () => {
  it('таймаут → «Сервер авторизации недоступен» с причиной, код не меняется', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const err = await postFormDetailed('https://issuer.test/token', new URLSearchParams(), {
      fetchImpl: vi.fn().mockRejectedValue(timeout),
      timeoutMs: 15_000,
      networkErrorCode: 'OFFLINE',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('OFFLINE');
    expect((err as RemoteError).message).toContain('Сервер авторизации недоступен');
    expect((err as RemoteError).message).toContain('за 15 с');
    // Сырой текст AbortSignal больше не единственное объяснение.
    expect((err as RemoteError).message).not.toContain('The operation was aborted');
  });
});
