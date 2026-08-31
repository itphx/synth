import { describe, it, expect, afterEach, vi } from 'vitest';
import { refreshAccessToken } from './device-flow.js';
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

  it('сервер авторизации недоступен → RemoteError(AUTH)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const err = await refreshAccessToken('https://issuer.test', 'client-1', 'rt-old').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('AUTH');
  });
});
