import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { McpNetworkPolicy, McpServerConfig } from '@itphx/synth-shared';

/**
 * ADR-071 §2.3.1: проверка сетевого доступа MCP-серверов (защита от SSRF/egress).
 *
 * Политика применяется к HTTP-транспортам (`sse`/`http`) при добавлении записи в
 * реестр и при подключении. `stdio` не проверяется (это RCE-риск, регулируется
 * отдельно — только ADMIN).
 */

export interface McpNetworkCheckResult {
  allowed: boolean;
  /** Человекочитаемая причина запрета (для API/логов). */
  reason?: string;
  /** Разрешённые/запрещённые IP, по которым принималось решение. */
  addresses?: string[];
}

export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolve: HostResolver = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

/** IPv4-строку в 32-битное число, либо null. */
export function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/** IPv6-строку в 128-битное число, либо null. Поддерживает `::` и встроенный IPv4. */
export function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip.split('%')[0] ?? ''; // отбросить zone-id (fe80::1%eth0)

  // Встроенный IPv4 в конце (например ::ffff:10.0.0.1).
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToBigInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const high = (v4 >> 16n).toString(16);
    const low = (v4 & 0xffffn).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): string[] => (s ? s.split(':') : []);

  let groups: string[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0] ?? '');
    const right = parseGroups(halves[1] ?? '');
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groups = parseGroups(addr);
  }

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Снимает zone-id (`fe80::1%eth0` → `fe80::1`) и обрезает пробелы. */
function stripZone(ip: string): string {
  return ip.trim().split('%')[0] ?? '';
}

/**
 * Встроенный IPv4 адреса вида `::ffff:a.b.c.d` (диапазон `::ffff:0:0/96`),
 * включая hex-запись `::ffff:7f00:1`; `null` — адрес не mapped.
 *
 * IPv4-mapped — это тот же IPv4-хост в v6-обёртке: `::ffff:127.0.0.1`
 * подключается к `127.0.0.1`, `::ffff:169.254.169.254` — к метаданным облака.
 */
export function mappedIpv4(ip: string): string | null {
  const bare = stripZone(ip);
  if (isIP(bare) !== 6) return null;
  const value = ipv6ToBigInt(bare);
  if (value === null || value >> 32n !== 0xffffn) return null;
  const v4 = value & 0xffffffffn;
  return `${(v4 >> 24n) & 0xffn}.${(v4 >> 16n) & 0xffn}.${(v4 >> 8n) & 0xffn}.${v4 & 0xffn}`;
}

/**
 * Канонизация IP перед проверкой политики: снимает zone-id, приводит
 * IPv4-mapped IPv6 (`::ffff:0:0/96`, в т.ч. hex-форму) к вложенному IPv4.
 * `null` — не IP-литерал. Единая точка нормализации для всех SSRF-проверок.
 */
export function normalizeIp(ip: string): string | null {
  const bare = stripZone(ip);
  const version = isIP(bare);
  if (version === 4) return bare;
  if (version !== 6) return null;
  return mappedIpv4(bare) ?? bare;
}

interface CidrRange {
  v4: boolean;
  base: bigint;
  mask: bigint;
}

/** Разбор CIDR в диапазон; null — некорректный CIDR. */
export function parseCidr(cidr: string): CidrRange | null {
  const slash = cidr.lastIndexOf('/');
  if (slash <= 0) return null;
  const addr = cidr.slice(0, slash).trim();
  const bitsRaw = cidr.slice(slash + 1).trim();
  if (!/^\d+$/.test(bitsRaw)) return null;

  const version = isIP(addr);
  if (version === 0) return null;
  const v4 = version === 4;
  const total = v4 ? 32 : 128;
  const bits = Number(bitsRaw);
  if (bits < 0 || bits > total) return null;

  const ipInt = v4 ? ipv4ToBigInt(addr) : ipv6ToBigInt(addr);
  if (ipInt === null) return null;

  const mask = bits === 0 ? 0n : (((1n << BigInt(bits)) - 1n) << BigInt(total - bits));
  return { v4, base: ipInt & mask, mask };
}

/**
 * Входит ли IP в CIDR.
 *
 * Версии сравниваются в своём семействе, но IPv4-mapped IPv6 проверяется в
 * **обоих**: `::ffff:127.0.0.1` матчится и с `127.0.0.0/8` (по вложенному IPv4),
 * и с `::ffff:0:0/96` (по полной v6-форме). Обычный (не mapped) IPv4 в v6-диапазоны
 * не попадает — семейства по-прежнему не смешиваются.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const range = parseCidr(cidr);
  if (!range) return false;

  const normalized = normalizeIp(ip);
  if (normalized === null) return false;

  // Кандидаты: канонический адрес и (для mapped) исходная v6-форма.
  const candidates = new Set<string>([normalized]);
  const bare = stripZone(ip);
  if (bare !== normalized && isIP(bare) === 6) candidates.add(bare);

  for (const candidate of candidates) {
    const isV4 = isIP(candidate) === 4;
    if (isV4 !== range.v4) continue;
    const ipInt = isV4 ? ipv4ToBigInt(candidate) : ipv6ToBigInt(candidate);
    if (ipInt !== null && (ipInt & range.mask) === range.base) return true;
  }
  return false;
}

/** Извлекает hostname из URL; null — некорректный URL. Скобки IPv6 снимаются. */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (!host) return null;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/**
 * Проверяет доступность URL по политике.
 * - `deny`: запрещён, если хотя бы один resolved IP попадает в список;
 * - `allow`: запрещён, если хотя бы один resolved IP НЕ входит в список.
 * Хост-литерал IP не резолвится. Ошибка резолва → запрет.
 */
export async function evaluateMcpNetworkAccess(
  url: string,
  policy: McpNetworkPolicy | undefined,
  options?: { resolveHost?: HostResolver },
): Promise<McpNetworkCheckResult> {
  if (!policy) return { allowed: true };
  if (policy.mode === 'deny' && policy.list.length === 0) return { allowed: true };

  const host = hostFromUrl(url);
  if (!host) {
    return { allowed: false, reason: `Некорректный URL MCP-сервера: ${url}` };
  }

  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await (options?.resolveHost ?? defaultResolve)(host);
    } catch {
      return { allowed: false, reason: `Не удалось определить IP хоста "${host}"` };
    }
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `Не удалось определить IP хоста "${host}"` };
  }

  if (policy.mode === 'deny') {
    for (const address of addresses) {
      for (const cidr of policy.list) {
        if (isIpInCidr(address, cidr)) {
          return {
            allowed: false,
            reason: `Адрес "${host}" (${address}) запрещён сетевой политикой (${cidr})`,
            addresses,
          };
        }
      }
    }
    return { allowed: true, addresses };
  }

  for (const address of addresses) {
    if (!policy.list.some((cidr) => isIpInCidr(address, cidr))) {
      return {
        allowed: false,
        reason: `Адрес "${host}" (${address}) не входит в разрешённый список сетевой политики`,
        addresses,
      };
    }
  }
  return { allowed: true, addresses };
}

/** HTTP-ли сервер (политика применяется только к HTTP-транспортам). */
export function isHttpMcpConfig(config: McpServerConfig): boolean {
  return config.type !== 'stdio';
}
