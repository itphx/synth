import { describe, it, expect } from 'vitest';
import {
  ipv4ToBigInt,
  ipv6ToBigInt,
  parseCidr,
  parseAddressRule,
  isIpInCidr,
  hostFromUrl,
  normalizeIp,
  mappedIpv4,
  evaluateMcpNetworkAccess,
  hostMatchesRule,
  isHttpMcpConfig,
} from './network-policy.js';
import { DEFAULT_MCP_NETWORK_POLICY } from '@itphx/synth-shared';
import type { McpNetworkPolicy } from '@itphx/synth-shared';

describe('network-policy: IP/CIDR (ADR-071 §2.3.1)', () => {
  it('ipv4ToBigInt', () => {
    expect(ipv4ToBigInt('0.0.0.0')).toBe(0n);
    expect(ipv4ToBigInt('255.255.255.255')).toBe(4294967295n);
    expect(ipv4ToBigInt('10.0.0.1')).toBe(167772161n);
    expect(ipv4ToBigInt('not-an-ip')).toBeNull();
    expect(ipv4ToBigInt('256.0.0.1')).toBeNull();
  });

  it('ipv6ToBigInt: loopback, сжатие, встроенный IPv4', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('fe80::1')).not.toBeNull();
    expect(ipv6ToBigInt('::ffff:10.0.0.1')).not.toBeNull();
    expect(ipv6ToBigInt('gggg::1')).toBeNull();
  });

  it('parseCidr отвергает мусор', () => {
    expect(parseCidr('10.0.0.0/8')).not.toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('::1/128')).not.toBeNull();
    expect(parseCidr('::1/129')).toBeNull();
    expect(parseCidr('nonsense')).toBeNull();
  });

  it('isIpInCidr: приватные и публичные адреса', () => {
    expect(isIpInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('172.20.0.1', '172.16.0.0/12')).toBe(true);
    expect(isIpInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(isIpInCidr('127.0.0.1', '127.0.0.0/8')).toBe(true);
    expect(isIpInCidr('169.254.1.1', '169.254.0.0/16')).toBe(true);
    expect(isIpInCidr('::1', '::1/128')).toBe(true);
    expect(isIpInCidr('fc00::1', 'fc00::/7')).toBe(true);
    expect(isIpInCidr('fe80::1', 'fe80::/10')).toBe(true);
    // Смешение версий — не совпадает.
    expect(isIpInCidr('::1', '127.0.0.0/8')).toBe(false);
    expect(isIpInCidr('127.0.0.1', '::1/128')).toBe(false);
  });

  it('hostFromUrl', () => {
    expect(hostFromUrl('http://localhost:8080/mcp')).toBe('localhost');
    expect(hostFromUrl('https://[::1]:9000/mcp')).toBe('::1');
    expect(hostFromUrl('not a url')).toBeNull();
  });

  it('mappedIpv4: IPv4-mapped формы → вложенный IPv4, иначе null', () => {
    expect(mappedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(mappedIpv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(mappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(mappedIpv4('0:0:0:0:0:ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(mappedIpv4('fe80::1%eth0')).toBeNull();
    expect(mappedIpv4('127.0.0.1')).toBeNull();
    expect(mappedIpv4('::1')).toBeNull();
  });

  it('normalizeIp: zone-id снимается, mapped → IPv4, публичные не меняются', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('93.184.216.34')).toBe('93.184.216.34');
    expect(normalizeIp('2606:4700:4700::1111')).toBe('2606:4700:4700::1111');
    expect(normalizeIp('not-an-ip')).toBeNull();
  });

  it('isIpInCidr: IPv4-mapped матчится и с v4-, и с v6-диапазоном', () => {
    // Закрытый обход: mapped-loopback/metadata раньше не попадали в v4-диапазоны.
    expect(isIpInCidr('::ffff:127.0.0.1', '127.0.0.0/8')).toBe(true);
    expect(isIpInCidr('::ffff:7f00:1', '127.0.0.0/8')).toBe(true);
    expect(isIpInCidr('::ffff:169.254.169.254', '169.254.0.0/16')).toBe(true);
    expect(isIpInCidr('::ffff:10.0.0.5', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('::ffff:8.8.8.8', '::ffff:0:0/96')).toBe(true);
    // Обычный v4 в v6-диапазон и mapped-диапазон не попадает (семейства не смешиваются).
    expect(isIpInCidr('8.8.8.8', '::ffff:0:0/96')).toBe(false);
    expect(isIpInCidr('127.0.0.1', '::ffff:0:0/96')).toBe(false);
    expect(isIpInCidr('::ffff:8.8.8.8', '8.8.8.0/24')).toBe(true);
  });

  it('isIpInCidr: zone-id и новые служебные диапазоны', () => {
    expect(isIpInCidr('fe80::1%eth0', 'fe80::/10')).toBe(true);
    expect(isIpInCidr('0.0.0.0', '0.0.0.0/8')).toBe(true);
    expect(isIpInCidr('0.1.2.3', '0.0.0.0/8')).toBe(true);
    expect(isIpInCidr('100.100.100.200', '100.64.0.0/10')).toBe(true);
    expect(isIpInCidr('100.128.0.1', '100.64.0.0/10')).toBe(false);
    expect(isIpInCidr('::', '::/128')).toBe(true);
  });
});

describe('evaluateMcpNetworkAccess (ADR-071 §2.3.1)', () => {
  const resolveTo = (address: string) => async () => [address];

  it('deny по умолчанию блокирует приватные IP', async () => {
    const result = await evaluateMcpNetworkAccess('http://10.0.0.5/mcp', DEFAULT_MCP_NETWORK_POLICY);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('10.0.0.5');
  });

  it('deny блокирует localhost (127.0.0.1/8)', async () => {
    const result = await evaluateMcpNetworkAccess(
      'http://localhost:8080/mcp',
      DEFAULT_MCP_NETWORK_POLICY,
      { resolveHost: resolveTo('127.0.0.1') },
    );
    expect(result.allowed).toBe(false);
  });

  it('deny разрешает публичный адрес', async () => {
    const result = await evaluateMcpNetworkAccess(
      'https://mcp.example.com/mcp',
      DEFAULT_MCP_NETWORK_POLICY,
      { resolveHost: resolveTo('93.184.216.34') },
    );
    expect(result.allowed).toBe(true);
  });

  it('allow разрешает только перечисленные диапазоны', async () => {
    const policy: McpNetworkPolicy = { mode: 'allow', list: ['127.0.0.0/8'] };
    // Литеральный IP (localhost — локальное имя, блокируется политикой, если не exception).
    expect((await evaluateMcpNetworkAccess('http://127.0.0.5/mcp', policy)).allowed).toBe(true);
    expect((await evaluateMcpNetworkAccess('http://10.0.0.5/mcp', policy)).allowed).toBe(false);
  });

  it('пустой deny-список разрешает всё', async () => {
    const result = await evaluateMcpNetworkAccess('http://10.0.0.5/mcp', { mode: 'deny', list: [] });
    expect(result.allowed).toBe(true);
  });

  it('ошибка резолва хоста → запрет', async () => {
    const result = await evaluateMcpNetworkAccess('http://unknown.invalid/mcp', DEFAULT_MCP_NETWORK_POLICY, {
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result.allowed).toBe(false);
  });

  it('undefined-политика — fail-closed', async () => {
    expect((await evaluateMcpNetworkAccess('http://10.0.0.5/mcp', undefined)).allowed).toBe(false);
  });

  it('deny блокирует IPv4-mapped loopback/link-local/metadata (обход через v6)', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]:8080/mcp',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:a9fe:a9fe]/',
    ]) {
      const result = await evaluateMcpNetworkAccess(url, DEFAULT_MCP_NETWORK_POLICY);
      expect(result.allowed, url).toBe(false);
    }
  });

  it('deny блокирует mapped-адрес, пришедший из DNS-резолва', async () => {
    const result = await evaluateMcpNetworkAccess('http://evil.example/mcp', DEFAULT_MCP_NETWORK_POLICY, {
      resolveHost: resolveTo('::ffff:169.254.169.254'),
    });
    expect(result.allowed).toBe(false);
  });

  it('публичные адреса не ломаются: v4 и v6 разрешены, mapped-форма — ужесточение', async () => {
    expect((await evaluateMcpNetworkAccess('https://v4.example/mcp', DEFAULT_MCP_NETWORK_POLICY, { resolveHost: resolveTo('93.184.216.34') })).allowed).toBe(true);
    expect((await evaluateMcpNetworkAccess('https://v6.example/mcp', DEFAULT_MCP_NETWORK_POLICY, { resolveHost: resolveTo('2606:4700:4700::1111') })).allowed).toBe(true);
    // mapped-запись публичного IPv4 блокируется целиком (`::ffff:0:0/96`):
    // легитимные адреса приходят обычным v4/v6, mapped — типичный обход.
    expect((await evaluateMcpNetworkAccess('https://mapped.example/mcp', DEFAULT_MCP_NETWORK_POLICY, { resolveHost: resolveTo('::ffff:8.8.8.8') })).allowed).toBe(false);
  });

  it('allow-режим: mapped-адрес матчится v4-диапазоном', async () => {
    const policy: McpNetworkPolicy = { mode: 'allow', list: ['169.254.0.0/16'] };
    const result = await evaluateMcpNetworkAccess('http://meta.example/mcp', policy, {
      resolveHost: resolveTo('::ffff:169.254.169.254'),
    });
    expect(result.allowed).toBe(true);
  });

  it('isHttpMcpConfig: stdio не HTTP', () => {
    expect(isHttpMcpConfig({ type: 'stdio', command: 'node' })).toBe(false);
    expect(isHttpMcpConfig({ type: 'sse', url: 'http://x' })).toBe(true);
    expect(isHttpMcpConfig({ type: 'http', url: 'http://x' })).toBe(true);
  });
});

describe('network-policy: исключения (ADR-071 §2.3.1)', () => {
  const resolveTo = (address: string) => async () => [address];
  const denyPolicy = (exceptions: string[]): McpNetworkPolicy => ({
    mode: 'deny',
    list: [...DEFAULT_MCP_NETWORK_POLICY.list],
    exceptions,
  });
  const CLUSTER_HOST = 'synth-gateway-telegram.synth.svc.cluster.local';

  it('hostname-исключение разрешает *.svc.cluster.local (аддон в кластере)', async () => {
    const result = await evaluateMcpNetworkAccess(
      `http://${CLUSTER_HOST}:7101/mcp`,
      denyPolicy(['*.svc.cluster.local']),
      { resolveHost: resolveTo('10.42.0.7') },
    );
    expect(result.allowed).toBe(true);
    // Правило-исключение попадает в журнал egress (matchedRule).
    expect(result.matchedRule).toBe('*.svc.cluster.local');
  });

  it('без исключения тот же хост блокируется (регрессия)', async () => {
    const result = await evaluateMcpNetworkAccess(
      `http://${CLUSTER_HOST}:7101/mcp`,
      denyPolicy([]),
      { resolveHost: resolveTo('10.42.0.7') },
    );
    expect(result.allowed).toBe(false);
    // Блок срабатывает раньше deny-списка: `*.cluster.local` — локальное имя
    // (mDNS-суффикс `.local`), поэтому первым срабатывает `isLocalHostname`.
    expect(result.matchedRule).toBe('local-hostname');
  });

  it('хост без локального суффикса блокируется deny-списком', async () => {
    const result = await evaluateMcpNetworkAccess(
      'http://gw.synth.svc.cluster.example/mcp',
      denyPolicy([]),
      { resolveHost: resolveTo('10.42.0.7') },
    );
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe('10.0.0.0/8');
  });

  it('исключение-адрес (CIDR) работает как раньше', async () => {
    const result = await evaluateMcpNetworkAccess(
      'http://gw.internal.example/mcp',
      denyPolicy(['10.42.0.0/24']),
      { resolveHost: resolveTo('10.42.0.7') },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe('10.42.0.0/24');
  });

  it('исключение-адрес (голый IP) разрешает ровно этот адрес', async () => {
    const result = await evaluateMcpNetworkAccess(
      'http://gw.internal.example/mcp',
      denyPolicy(['10.42.0.7']),
      { resolveHost: resolveTo('10.42.0.7') },
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe('10.42.0.7');

    // Соседний адрес под исключение не попадает.
    const other = await evaluateMcpNetworkAccess(
      'http://gw.internal.example/mcp',
      denyPolicy(['10.42.0.7']),
      { resolveHost: resolveTo('10.42.0.8') },
    );
    expect(other.allowed).toBe(false);
  });

  it('голый IP в deny-списке блокирует адрес (было fail-open)', async () => {
    const result = await evaluateMcpNetworkAccess(
      'http://169.254.169.254/latest/meta-data/',
      { mode: 'deny', list: ['169.254.169.254'], exceptions: [] },
    );
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe('169.254.169.254');
  });

  it('parseAddressRule: CIDR и одиночный IP → один диапазон', () => {
    expect(parseAddressRule('10.0.0.0/8')).not.toBeNull();
    expect(parseAddressRule('10.0.0.5')).not.toBeNull();
    expect(parseAddressRule('::1')).not.toBeNull();
    expect(parseAddressRule('::ffff:10.0.0.5')).not.toBeNull();
    expect(parseAddressRule('example.com')).toBeNull();
    expect(parseAddressRule('not-an-ip')).toBeNull();
  });

  it('isIpInCidr: одиночный IP — точный адрес, не сеть', () => {
    expect(isIpInCidr('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(isIpInCidr('10.0.0.6', '10.0.0.5')).toBe(false);
    expect(isIpInCidr('10.0.0.5', '10.0.0.0/8')).toBe(true);
    // IPv4-mapped форма — тот же адрес.
    expect(isIpInCidr('::ffff:10.0.0.5', '10.0.0.5')).toBe(true);
    expect(isIpInCidr('::1', '::1')).toBe(true);
    expect(isIpInCidr('::2', '::1')).toBe(false);
    // Семейства не смешиваются.
    expect(isIpInCidr('127.0.0.1', '::1')).toBe(false);
  });

  it('hostMatchesRule: точный хост, *.suffix и никакого «*»', () => {
    expect(hostMatchesRule('gw.example.com', 'gw.example.com')).toBe(true);
    expect(hostMatchesRule('gw.example.com', 'other.example.com')).toBe(false);
    expect(hostMatchesRule('a.svc.cluster.local', '*.svc.cluster.local')).toBe(true);
    expect(hostMatchesRule('svc.cluster.local', '*.svc.cluster.local')).toBe(false);
    // `*` не поддерживается (fail-closed): иначе исключение разрешило бы любой хост.
    expect(hostMatchesRule('evil.example', '*')).toBe(false);
  });
});
