import { describe, it, expect } from 'vitest';
import {
  ipv4ToBigInt,
  ipv6ToBigInt,
  parseCidr,
  isIpInCidr,
  hostFromUrl,
  evaluateMcpNetworkAccess,
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
    expect((await evaluateMcpNetworkAccess('http://localhost/mcp', policy, { resolveHost: resolveTo('127.0.0.1') })).allowed).toBe(true);
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

  it('undefined-политика не блокирует', async () => {
    expect((await evaluateMcpNetworkAccess('http://10.0.0.5/mcp', undefined)).allowed).toBe(true);
  });

  it('isHttpMcpConfig: stdio не HTTP', () => {
    expect(isHttpMcpConfig({ type: 'stdio', command: 'node' })).toBe(false);
    expect(isHttpMcpConfig({ type: 'sse', url: 'http://x' })).toBe(true);
    expect(isHttpMcpConfig({ type: 'http', url: 'http://x' })).toBe(true);
  });
});
