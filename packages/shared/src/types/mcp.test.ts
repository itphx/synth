import { describe, it, expect } from 'vitest';
import { DEFAULT_MCP_NETWORK_POLICY, DEFAULT_MCP_PRIVATE_CIDRS } from './mcp.js';

/**
 * Канонический список заблокированных диапазонов (ADR-099, аудит egress):
 * он же — дефолт `mcp.networkPolicy`, `egress.tools`, `egress.webhooks` и
 * встроенный fallback `engine/net/egress-guard.ts`. Списков «заблокированных
 * адресов» в коде больше быть не должно — этот тест фиксирует состав.
 */

/** Диапазоны, обязательные к блокировке (аудит egress/SSRF). */
const REQUIRED_CIDRS = [
  // IPv4: multicast, limited broadcast, reserved.
  '224.0.0.0/4',
  '255.255.255.255/32',
  '240.0.0.0/4',
  // IPv4: IETF protocol assignments (в т.ч. NAT64 WKP 192.0.0.170/171).
  '192.0.0.0/24',
  // IPv4: benchmarking.
  '198.18.0.0/15',
  // IPv6: multicast.
  'ff00::/8',
] as const;

/** Документационные диапазоны (TEST-NET-1/2/3) — тоже заблокированы. */
const DOCUMENTATION_CIDRS = ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'] as const;

/** Диапазоны, заблокированные до аудита — не должны выпасть из списка. */
const PREVIOUS_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  'fc00::/7',
  'fe80::/10',
] as const;

describe('DEFAULT_MCP_PRIVATE_CIDRS — канонический список служебных диапазонов', () => {
  it('содержит multicast/broadcast/reserved и IETF protocol assignments', () => {
    for (const cidr of REQUIRED_CIDRS) {
      expect(DEFAULT_MCP_PRIVATE_CIDRS, cidr).toContain(cidr);
    }
  });

  it('содержит документационные диапазоны (TEST-NET-1/2/3)', () => {
    for (const cidr of DOCUMENTATION_CIDRS) {
      expect(DEFAULT_MCP_PRIVATE_CIDRS, cidr).toContain(cidr);
    }
  });

  it('не теряет ранее заблокированные диапазоны', () => {
    for (const cidr of PREVIOUS_CIDRS) {
      expect(DEFAULT_MCP_PRIVATE_CIDRS, cidr).toContain(cidr);
    }
  });

  it('не содержит NAT64-префиксов (DNS64 на IPv6-only сетях отдаёт адреса из них)', () => {
    // Блокировка 64:ff9b::/96 или 64:ff9b:1::/48 сломала бы весь egress
    // на IPv6-only сетях с DNS64 — они исключены осознанно.
    expect(DEFAULT_MCP_PRIVATE_CIDRS).not.toContain('64:ff9b::/96');
    expect(DEFAULT_MCP_PRIVATE_CIDRS).not.toContain('64:ff9b:1::/48');
  });

  it('записи уникальны и имеют вид CIDR', () => {
    const seen = new Set<string>();
    for (const cidr of DEFAULT_MCP_PRIVATE_CIDRS) {
      expect(seen.has(cidr), `дубликат ${cidr}`).toBe(false);
      seen.add(cidr);
      expect(cidr, `не CIDR: ${cidr}`).toMatch(/^[0-9a-fA-F:.]+\/\d{1,3}$/);
    }
  });

  it('дефолтная политика MCP использует ровно этот список', () => {
    expect(DEFAULT_MCP_NETWORK_POLICY.mode).toBe('deny');
    expect(DEFAULT_MCP_NETWORK_POLICY.list).toEqual([...DEFAULT_MCP_PRIVATE_CIDRS]);
    expect(DEFAULT_MCP_NETWORK_POLICY.exceptions).toEqual([]);
  });
});
