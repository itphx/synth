/**
 * PROP-107 §7: host-binding секретных заголовков при редиректах.
 *
 * Инвариант: заголовки-секреты (`authorization`, `proxy-authorization`,
 * `x-api-key`, `cookie`) не пересылаются на хоп с **другим origin**
 * (сравнение scheme+host+port); остальные заголовки пересылаются как раньше.
 * Без редиректов поведение не меняется.
 */
import { describe, it, expect, vi } from 'vitest';
import { PRIVATE_EGRESS_POLICY, fetchWithEgressGuard } from './egress-guard.js';
import type { FetchLike } from './egress-guard.js';

/** Резолвер: все тестовые хосты → публичный адрес (SSRF-проверка проходит). */
const resolve = async (): Promise<string[]> => ['93.184.216.34'];

/** Заголовки конкретного хопа — в объекте (регистр заголовка нормализован). */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers as Array<[string, string]>);
  return { ...(headers as Record<string, string>) };
}

/** Заголовки, которые клиент отправил на каждый хоп (по URL). */
interface Hop {
  url: string;
  headers: Record<string, string>;
}

/**
 * Мок-транспорт: на `redirects[url]` отвечает 302 на указанный адрес,
 * иначе 200. Каждый хоп фиксируется (URL + заголовки).
 */
function mockTransport(redirects: Record<string, string>): { hops: Hop[]; fetchImpl: FetchLike } {
  const hops: Hop[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    hops.push({ url: input, headers: headersOf(init) });
    const location = redirects[input];
    if (location) {
      return new Response(null, { status: 302, headers: { location } });
    }
    return new Response('ok', { status: 200 });
  };
  return { hops, fetchImpl };
}

const SECRET_HEADERS: Record<string, string> = {
  authorization: 'Bearer secret-token',
  'proxy-authorization': 'Basic c2VjcmV0',
  'x-api-key': 'api-key-value',
  cookie: 'session=abc',
  'content-type': 'application/json',
  'x-trace': 'trace-1',
};

describe('egress-guard: host-binding секретных заголовков (PROP-107 §7)', () => {
  it('редирект на другой хост: секретные заголовки не уходят, остальные — уходят', async () => {
    const { hops, fetchImpl } = mockTransport({
      'https://auth.example/start': 'https://other.example/next',
    });

    const response = await fetchWithEgressGuard(
      'https://auth.example/start',
      { method: 'GET', headers: { ...SECRET_HEADERS } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(response.status).toBe(200);
    expect(hops).toHaveLength(2);

    // Первый хоп — исходный origin: все заголовки на месте.
    expect(hops[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(hops[0]?.headers['x-api-key']).toBe('api-key-value');
    expect(hops[0]?.headers.cookie).toBe('session=abc');
    expect(hops[0]?.headers['proxy-authorization']).toBe('Basic c2VjcmV0');

    // Второй хоп — чужой origin: секретные сняты, обычные сохранены.
    expect(hops[1]?.url).toBe('https://other.example/next');
    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(hops[1]?.headers['proxy-authorization']).toBeUndefined();
    expect(hops[1]?.headers['x-api-key']).toBeUndefined();
    expect(hops[1]?.headers.cookie).toBeUndefined();
    expect(hops[1]?.headers['content-type']).toBe('application/json');
    expect(hops[1]?.headers['x-trace']).toBe('trace-1');
  });

  it('редирект на тот же origin: секретные заголовки сохраняются', async () => {
    const { hops, fetchImpl } = mockTransport({
      'https://auth.example/start': 'https://auth.example/next',
    });

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { ...SECRET_HEADERS } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(hops).toHaveLength(2);
    expect(hops[1]?.headers.authorization).toBe('Bearer secret-token');
    expect(hops[1]?.headers.cookie).toBe('session=abc');
    expect(hops[1]?.headers['x-api-key']).toBe('api-key-value');
  });

  it('тот же хост, но другой порт или схема — origin другой, секретные снимаются', async () => {
    const { hops, fetchImpl } = mockTransport({
      'https://auth.example/start': 'https://auth.example:8443/next',
    });
    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { authorization: 'Bearer t' } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );
    expect(hops[1]?.headers.authorization).toBeUndefined();

    const scheme = mockTransport({
      'https://auth.example/start': 'http://auth.example/next',
    });
    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { authorization: 'Bearer t' } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl: scheme.fetchImpl, bindSecretHeaders: true },
    );
    expect(scheme.hops[1]?.headers.authorization).toBeUndefined();
  });

  it('без редиректов заголовки не меняются', async () => {
    const { hops, fetchImpl } = mockTransport({});

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { ...SECRET_HEADERS } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(hops).toHaveLength(1);
    expect(hops[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(hops[0]?.headers.cookie).toBe('session=abc');
    expect(hops[0]?.headers['content-type']).toBe('application/json');
  });

  it('режим выключен (по умолчанию) — поведение прежнее: заголовки спредятся как раньше', async () => {
    const { hops, fetchImpl } = mockTransport({
      'https://auth.example/start': 'https://other.example/next',
    });

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { ...SECRET_HEADERS } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl },
    );

    expect(hops).toHaveLength(2);
    expect(hops[1]?.headers.authorization).toBe('Bearer secret-token');
    expect(hops[1]?.headers.cookie).toBe('session=abc');
  });

  it('редирект на чужой origin без обычных заголовков — запрос уходит вообще без заголовков', async () => {
    const { hops, fetchImpl } = mockTransport({
      'https://auth.example/start': 'https://other.example/next',
    });

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { authorization: 'Bearer t' } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(hops).toHaveLength(2);
    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(Object.keys(hops[1]?.headers ?? {})).toHaveLength(0);
  });

  it('редирект обратно на исходный origin — секретные заголовки восстанавливаются', async () => {
    const hops: Hop[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      hops.push({ url: input, headers: headersOf(init) });
      if (input === 'https://auth.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://other.example/next' } });
      }
      if (input === 'https://other.example/next') {
        return new Response(null, { status: 302, headers: { location: 'https://auth.example/back' } });
      }
      return new Response('ok', { status: 200 });
    };

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { authorization: 'Bearer t', 'x-trace': 'trace-1' } },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(hops).toHaveLength(3);
    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(hops[2]?.headers.authorization).toBe('Bearer t');
    expect(hops[2]?.headers['x-trace']).toBe('trace-1');
  });

  it('заголовки как Headers-инстанс и как массив пар — нормализуются одинаково', async () => {
    const hops: Hop[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      hops.push({ url: input, headers: headersOf(init) });
      if (input === 'https://auth.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://other.example/next' } });
      }
      return new Response('ok', { status: 200 });
    };

    await fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: new Headers({ Authorization: 'Bearer t', 'Content-Type': 'application/json' }) },
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolve, fetchImpl, bindSecretHeaders: true },
    );

    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(hops[1]?.headers['content-type']).toBe('application/json');
  });

  it('политика по-прежнему проверяется на каждом хопе (редирект на запрещённый адрес — отказ)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (input === 'https://auth.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } });
      }
      return new Response('nope', { status: 200 });
    });

    await expect(fetchWithEgressGuard(
      'https://auth.example/start',
      { headers: { authorization: 'Bearer t' } },
      {
        policy: PRIVATE_EGRESS_POLICY,
        resolveHost: async (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']),
        fetchImpl,
        bindSecretHeaders: true,
      },
    )).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
