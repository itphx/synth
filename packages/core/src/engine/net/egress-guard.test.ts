import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_EGRESS_TOOLS_POLICY, DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
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
import { parseCidr } from '../mcp/network-policy.js';

/** Детерминированный резолвер: hostname → адреса (без реального DNS). */
const resolve = (map: Record<string, string[]>) => async (host: string): Promise<string[]> => map[host] ?? [];

/** URL с IP-литералом в хосте (IPv6 — в квадратных скобках). */
const urlFor = (address: string): string =>
  address.includes(':') ? `http://[${address}]/` : `http://${address}/`;

/** Сетевой адрес диапазона (base) в виде IP-строки. */
function networkAddress(cidr: string): string {
  const range = parseCidr(cidr);
  if (!range) throw new Error(`некорректный CIDR: ${cidr}`);
  if (range.v4) {
    const v = range.base;
    return `${(v >> 24n) & 255n}.${(v >> 16n) & 255n}.${(v >> 8n) & 255n}.${v & 255n}`;
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((range.base >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  return groups.join(':');
}

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

  it('undefined-политика — fail-closed (не «разрешено всё»)', async () => {
    expect((await checkEgressUrl('http://127.0.0.1/x', undefined)).allowed).toBe(false);
  });

  it('exception-hostname разрешает адрес из 10.0.0.0/8', async () => {
    const policy = {
      mode: 'deny' as const,
      list: ['10.0.0.0/8'],
      exceptions: ['internal.example'],
    };
    const res = await checkEgressUrl('https://internal.example/x', policy, {
      resolveHost: resolve({ 'internal.example': ['10.0.0.5'] }),
    });
    expect(res.allowed).toBe(true);
    expect(res.matchedRule).toBe('internal.example');
  });

  it('exception *.suffix матчит поддомен, но не корень и не чужой суффикс', async () => {
    const policy = {
      mode: 'deny' as const,
      list: ['10.0.0.0/8'],
      exceptions: ['*.corp.example'],
    };
    const resolver = resolve({
      'a.corp.example': ['10.0.0.5'],
      'corp.example': ['10.0.0.6'],
      'badcorp.example': ['10.0.0.7'],
    });
    expect((await checkEgressUrl('https://a.corp.example/x', policy, { resolveHost: resolver })).allowed).toBe(true);
    expect((await checkEgressUrl('https://corp.example/x', policy, { resolveHost: resolver })).allowed).toBe(false);
    expect((await checkEgressUrl('https://badcorp.example/x', policy, { resolveHost: resolver })).allowed).toBe(false);
  });

  it('без exception тот же адрес блокируется', async () => {
    const res = await checkEgressUrl('https://internal.example/x', PRIVATE_EGRESS_POLICY, {
      resolveHost: resolve({ 'internal.example': ['10.0.0.5'] }),
    });
    expect(res.allowed).toBe(false);
    expect(res.matchedRule).toBe('10.0.0.0/8');
  });

  it('isBlockedHost/isBlockedIp: exception разрешает литеральный localhost/.local', () => {
    const policy = {
      mode: 'deny' as const,
      list: ['127.0.0.0/8'],
      exceptions: ['localhost', '*.local'],
    };
    expect(isBlockedHost('localhost', policy)).toBe(false);
    expect(isBlockedHost('printer.local', policy)).toBe(false);
    expect(isBlockedIp('127.0.0.1', { ...policy, exceptions: ['127.0.0.0/8'] })).toBe(false);
    // Без exception — блокируется.
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedIp('127.0.0.1')).toBe(true);
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

describe('egress-guard: единый список заблокированных диапазонов (ADR-099, аудит egress)', () => {
  /** Адреса, которые обязаны запрещаться дефолтной политикой `egress.tools`. */
  const DENIED_BY_DEFAULT = [
    '224.0.0.1', // IPv4 multicast
    '239.255.255.250', // IPv4 multicast (SSDP)
    'ff02::1', // IPv6 multicast
    'ff0e::1', // IPv6 multicast (site-local scope)
    '255.255.255.255', // limited broadcast
    '240.0.0.1', // reserved (RFC 1112)
    '192.0.0.8', // IETF protocol assignments (RFC 6890)
    '192.0.0.170', // NAT64 well-known prefix (RFC 6052)
    '192.0.0.171', // NAT64 well-known prefix (RFC 6052)
    '198.18.0.1', // benchmarking (RFC 2544)
    '192.0.2.1', // TEST-NET-1 (documentation)
    '198.51.100.1', // TEST-NET-2 (documentation)
    '203.0.113.1', // TEST-NET-3 (documentation)
    '::ffff:224.0.0.1', // IPv4-mapped multicast — обход v4-списка
    '::ffff:255.255.255.255', // IPv4-mapped limited broadcast
    '::ffff:192.0.0.170', // IPv4-mapped NAT64 WKP
  ];

  /** Публичные адреса — должны оставаться разрешёнными. */
  const ALLOWED_BY_DEFAULT = [
    '93.184.216.34',
    '8.8.8.8',
    '2606:2800:220:1:248:1893:25c8:1946',
  ];

  it('дефолтная политика egress.tools запрещает multicast/broadcast/reserved', async () => {
    for (const address of DENIED_BY_DEFAULT) {
      const res = await checkEgressUrl(urlFor(address), DEFAULT_EGRESS_TOOLS_POLICY);
      expect(res.allowed, address).toBe(false);
    }
  });

  it('дефолтная политика egress.tools разрешает публичные адреса', async () => {
    for (const address of ALLOWED_BY_DEFAULT) {
      const res = await checkEgressUrl(urlFor(address), DEFAULT_EGRESS_TOOLS_POLICY);
      expect(res.allowed, address).toBe(true);
    }
  });

  it('IPv4-mapped форма заблокированного адреса запрещается (обход v4-списка)', async () => {
    const res = await checkEgressUrl('http://[::ffff:224.0.0.1]/', DEFAULT_EGRESS_TOOLS_POLICY);
    expect(res.allowed).toBe(false);
    expect(res.matchedRule).toBe('224.0.0.0/4');
  });

  it('fallback без политики использует тот же канонический список (источник истины один)', () => {
    // Каждый диапазон общего списка обязан блокироваться и guard'ом без политики,
    // и дефолтной политикой — иначе в коде снова появится второй список.
    for (const cidr of DEFAULT_MCP_PRIVATE_CIDRS) {
      const address = networkAddress(cidr);
      expect(isBlockedIp(address), `fallback: ${cidr} (${address})`).toBe(true);
      expect(isBlockedIp(address, DEFAULT_EGRESS_TOOLS_POLICY), `policy: ${cidr} (${address})`).toBe(true);
      expect(isBlockedIp(address, PRIVATE_EGRESS_POLICY), `built-in policy: ${cidr}`).toBe(true);
    }
  });

  it('публичные адреса не блокируются ни fallback-ом, ни дефолтной политикой', () => {
    for (const address of ALLOWED_BY_DEFAULT) {
      expect(isBlockedIp(address), address).toBe(false);
      expect(isBlockedIp(address, DEFAULT_EGRESS_TOOLS_POLICY), address).toBe(false);
    }
  });

  it('fail-closed: без политики не разрешён ни один адрес (в т.ч. публичный)', async () => {
    expect((await checkEgressUrl('http://93.184.216.34/x', undefined)).allowed).toBe(false);
    expect((await checkEgressUrl('http://[2606:2800:220:1:248:1893:25c8:1946]/x', undefined)).allowed).toBe(false);
  });

  it('isBlockedHost: заблокированные литералы (multicast/broadcast/reserved) — без политики', () => {
    expect(isBlockedHost('224.0.0.1')).toBe(true);
    expect(isBlockedHost('255.255.255.255')).toBe(true);
    expect(isBlockedHost('240.0.0.1')).toBe(true);
    expect(isBlockedHost('192.0.0.170')).toBe(true);
    expect(isBlockedHost('ff02::1')).toBe(true);
    expect(isBlockedHost('::ffff:224.0.0.1')).toBe(true);
    expect(isBlockedHost('93.184.216.34')).toBe(false);
  });

  it('расширенный список остаётся настраиваемым: exception возвращает диапазон', async () => {
    const policy = {
      mode: 'deny' as const,
      list: [...DEFAULT_MCP_PRIVATE_CIDRS],
      exceptions: ['224.0.0.0/4'],
    };
    expect((await checkEgressUrl('http://224.0.0.1/', policy)).allowed).toBe(true);
    expect(isBlockedIp('224.0.0.1', policy)).toBe(false);
    // Соседние диапазоны остаются запрещёнными.
    expect((await checkEgressUrl('http://240.0.0.1/', policy)).allowed).toBe(false);
    expect((await checkEgressUrl('http://[ff02::1]/', policy)).allowed).toBe(false);
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
