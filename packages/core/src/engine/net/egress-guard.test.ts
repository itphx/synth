import { describe, it, expect, vi } from 'vitest';
import {
  PRIVATE_EGRESS_POLICY,
  DEFAULT_EGRESS_MAX_HOPS,
  checkEgressUrl,
  fetchWithEgressGuard,
  EgressBlockedError,
  isBlockedHost,
  isBlockedIp,
} from './egress-guard.js';
import type { FetchLike } from './egress-guard.js';

/** Детерминированный резолвер: hostname → адреса (без реального DNS). */
const resolve = (map: Record<string, string[]>) => async (host: string): Promise<string[]> => map[host] ?? [];

describe('egress-guard: checkEgressUrl (PROP-100 дефект 1 — DNS-резолв)', () => {
  it('hostname → 127.0.0.1 запрещён', async () => {
    const res = await checkEgressUrl('https://evil.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: resolve({ 'evil.example': ['127.0.0.1'] }),
    });
    expect(res.allowed).toBe(false);
  });

  it('hostname → 169.254.169.254 (metadata) запрещён', async () => {
    const res = await checkEgressUrl('https://meta.example/latest', PRIVATE_EGRESS_POLICY, {
      resolveHost: resolve({ 'meta.example': ['169.254.169.254'] }),
    });
    expect(res.allowed).toBe(false);
  });

  it('hostname → приватный диапазон запрещён', async () => {
    for (const address of ['10.0.0.5', '172.16.0.1', '192.168.1.1', 'fc00::1']) {
      const res = await checkEgressUrl(`https://lan.example/${address}`, PRIVATE_EGRESS_POLICY, {
        resolveHost: resolve({ 'lan.example': [address] }),
      });
      expect(res.allowed, address).toBe(false);
    }
  });

  it('hostname → публичный адрес разрешён (v4 и v6)', async () => {
    for (const address of ['93.184.216.34', '2606:4700:4700::1111']) {
      const res = await checkEgressUrl('https://public.example/x', PRIVATE_EGRESS_POLICY, {
        resolveHost: resolve({ 'public.example': [address] }),
      });
      expect(res.allowed, address).toBe(true);
    }
  });

  it('несколько A-записей, одна приватная → запрещено (проверка каждого адреса)', async () => {
    const res = await checkEgressUrl('https://mixed.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: resolve({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }),
    });
    expect(res.allowed).toBe(false);
  });

  it('ошибка/пустой резолв → запрет (fail-closed)', async () => {
    const thrown = await checkEgressUrl('https://unknown.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: async () => { throw new Error('ENOTFOUND'); },
    });
    expect(thrown.allowed).toBe(false);

    const empty = await checkEgressUrl('https://empty.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: async () => [],
    });
    expect(empty.allowed).toBe(false);
  });

  it('IPv4-mapped через DNS-резолв запрещён', async () => {
    const res = await checkEgressUrl('https://mapped.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: resolve({ 'mapped.example': ['::ffff:169.254.169.254'] }),
    });
    expect(res.allowed).toBe(false);
  });

  it('IP-литералы: поведение не меняется (публичный — ок, приватный — нет)', async () => {
    // Литерал не резолвится: DNS-резолвер не вызывается.
    const resolver = vi.fn(async () => ['93.184.216.34']);
    expect((await checkEgressUrl('https://93.184.216.34/x', PRIVATE_EGRESS_POLICY, { resolveHost: resolver })).allowed).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
    expect((await checkEgressUrl('https://127.0.0.1/x', PRIVATE_EGRESS_POLICY, { resolveHost: resolver })).allowed).toBe(false);
    expect((await checkEgressUrl('https://[::ffff:127.0.0.1]/x', PRIVATE_EGRESS_POLICY, { resolveHost: resolver })).allowed).toBe(false);
  });

  it('схема: только http/https', async () => {
    expect((await checkEgressUrl('ftp://example.com/x', PRIVATE_EGRESS_POLICY)).allowed).toBe(false);
    expect((await checkEgressUrl('not a url', PRIVATE_EGRESS_POLICY)).allowed).toBe(false);
  });

  it('requireHttps отклоняет http', async () => {
    const res = await checkEgressUrl('http://public.example/x', PRIVATE_EGRESS_POLICY, {
      requireHttps: true,
      resolveHost: resolve({ 'public.example': ['93.184.216.34'] }),
    });
    expect(res.allowed).toBe(false);
  });

  it('undefined-политика (dev) не блокирует приватные литералы', async () => {
    expect((await checkEgressUrl('http://127.0.0.1/x', undefined)).allowed).toBe(true);
  });

  it('isBlockedHost/isBlockedIp — приватные литералы и локальные имена', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('printer.local')).toBe(true);
    expect(isBlockedHost('metadata.google.internal')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
  });
});

describe('egress-guard: fetchWithEgressGuard (PROP-100 дефект 2 — каждый хоп редиректа)', () => {
  const publicResolver = resolve({ 'public.example': ['93.184.216.34'] });
  const resolver = async (host: string) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);

  it('редирект на приватный адрес → отказ, приватный хоп не выполняется', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (input === 'https://public.example/start') {
        return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } });
      }
      return new Response('should-not-be-fetched', { status: 200 });
    });

    await expect(fetchWithEgressGuard(
      'https://public.example/start',
      {},
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: resolver, fetchImpl },
    )).rejects.toBeInstanceOf(EgressBlockedError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('редирект на публичный адрес отслеживается (redirect: manual)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) => {
      if (input === 'https://public.example/start') {
        return new Response(null, { status: 301, headers: { location: 'https://public.example/final' } });
      }
      if (input === 'https://public.example/final') return new Response('ok', { status: 200 });
      throw new Error(`unexpected: ${input}`);
    });

    const response = await fetchWithEgressGuard(
      'https://public.example/start',
      {},
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: publicResolver, fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => (call[1] as RequestInit | undefined)?.redirect === 'manual')).toBe(true);
  });

  it('превышение лимита хопов → отказ', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      new Response(null, { status: 302, headers: { location: 'https://public.example/loop' } }));

    await expect(fetchWithEgressGuard(
      'https://public.example/start',
      {},
      { policy: PRIVATE_EGRESS_POLICY, resolveHost: publicResolver, fetchImpl, maxHops: 3 },
    )).rejects.toBeInstanceOf(EgressBlockedError);

    // maxHops + 1 запросов, дальше — отказ без нового запроса.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(DEFAULT_EGRESS_MAX_HOPS).toBe(5);
  });

  it('запрещённый стартовый URL → отказ без сетевого вызова', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('nope', { status: 200 }));
    await expect(fetchWithEgressGuard(
      'http://127.0.0.1/x',
      {},
      { policy: PRIVATE_EGRESS_POLICY, fetchImpl },
    )).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
