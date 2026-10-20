import { describe, it, expect } from 'vitest';
import { DEFAULT_EGRESS_TOOLS_POLICY, DEFAULT_EGRESS_WEBHOOKS_POLICY } from './egress.js';
import { DEFAULT_MCP_PRIVATE_CIDRS } from './mcp.js';

/**
 * Дефолтные egress-политики (ADR-099) используют **общий канонический список**
 * заблокированных диапазонов — тот же, что и `mcp.networkPolicy` и встроенный
 * fallback guard'а (`engine/net/egress-guard.ts`). Расхождение списков = тихая
 * дыра в SSRF-защите (именно это нашёл аудит egress-слоя).
 */
describe('дефолтные egress-политики используют канонический список', () => {
  it('egress.tools: deny + общий список', () => {
    expect(DEFAULT_EGRESS_TOOLS_POLICY.mode).toBe('deny');
    expect(DEFAULT_EGRESS_TOOLS_POLICY.list).toEqual([...DEFAULT_MCP_PRIVATE_CIDRS]);
    expect(DEFAULT_EGRESS_TOOLS_POLICY.exceptions).toEqual([]);
  });

  it('egress.webhooks: deny + общий список', () => {
    expect(DEFAULT_EGRESS_WEBHOOKS_POLICY.mode).toBe('deny');
    expect(DEFAULT_EGRESS_WEBHOOKS_POLICY.list).toEqual([...DEFAULT_MCP_PRIVATE_CIDRS]);
    expect(DEFAULT_EGRESS_WEBHOOKS_POLICY.exceptions).toEqual([]);
  });

  it('списки дефолтов — независимые копии (правка одного не меняет другой)', () => {
    expect(DEFAULT_EGRESS_TOOLS_POLICY.list).not.toBe(DEFAULT_EGRESS_WEBHOOKS_POLICY.list);
    expect(DEFAULT_EGRESS_TOOLS_POLICY.list).not.toBe(DEFAULT_MCP_PRIVATE_CIDRS);
  });

  it('в дефолтах есть multicast/broadcast/reserved', () => {
    for (const policy of [DEFAULT_EGRESS_TOOLS_POLICY, DEFAULT_EGRESS_WEBHOOKS_POLICY]) {
      for (const cidr of ['224.0.0.0/4', 'ff00::/8', '255.255.255.255/32', '240.0.0.0/4', '192.0.0.0/24', '198.18.0.0/15']) {
        expect(policy.list, cidr).toContain(cidr);
      }
    }
  });
});
