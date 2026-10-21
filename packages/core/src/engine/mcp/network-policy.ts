import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { matchTlsHostPattern } from '@itphx/synth-shared';
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
  /** Сработавшее правило политики (exception/CIDR из list/`local-hostname`). */
  matchedRule?: string;
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
 * Разбор адресного правила в диапазон: CIDR (`10.0.0.0/8`) **или** одиночный
 * IP-литерал (`10.0.0.5` → /32, `::1` → /128). `null` — не адресное правило.
 *
 * Одиночный IP равнозначен CIDR с полной маской. Раньше такой литерал проходил
 * валидатор (`isValidEgressRule`), но не срабатывал никогда (`parseCidr`
 * требовал `/`): deny-список не блокировал адрес (fail-open), а exception
 * молча игнорировался. Здесь литерал приводится к тому же диапазону, что и CIDR.
 */
export function parseAddressRule(rule: string): CidrRange | null {
  const trimmed = rule.trim();
  if (trimmed.includes('/')) return parseCidr(trimmed);
  // `normalizeIp` снимает zone-id и приводит IPv4-mapped (`::ffff:a.b.c.d`) к
  // вложенному IPv4 — правило и проверяемый адрес нормализуются одинаково.
  const literal = normalizeIp(trimmed);
  if (literal === null) return null;
  const v4 = isIP(literal) === 4;
  const ipInt = v4 ? ipv4ToBigInt(literal) : ipv6ToBigInt(literal);
  if (ipInt === null) return null;
  const mask = v4 ? 0xffffffffn : (1n << 128n) - 1n;
  return { v4, base: ipInt, mask };
}

/**
 * Входит ли IP в адресное правило (CIDR или одиночный IP-литерал).
 *
 * Версии сравниваются в своём семействе, но IPv4-mapped IPv6 проверяется в
 * **обоих**: `::ffff:127.0.0.1` матчится и с `127.0.0.0/8` (по вложенному IPv4),
 * и с `::ffff:0:0/96` (по полной v6-форме). Обычный (не mapped) IPv4 в v6-диапазоны
 * не попадает — семейства по-прежнему не смешиваются.
 */
export function isIpInCidr(ip: string, rule: string): boolean {
  const range = parseAddressRule(rule);
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

/** Локальные hostname-суффиксы: блокируются политикой (exception может разрешить). */
const LOCAL_HOSTNAMES = ['localhost'];
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

/** `true`, если hostname — локальное имя (`localhost`/`*.localhost`/`*.local`/`*.internal`). */
export function isLocalHostname(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (LOCAL_HOSTNAMES.includes(host)) return true;
  if (host.endsWith('.localhost')) return true;
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Правило-исключение задаёт CIDR/IP (а не hostname). */
export function isAddressRule(rule: string): boolean {
  const trimmed = rule.trim();
  return trimmed.includes('/') || isIP(trimmed) !== 0;
}

/**
 * Матчинг hostname-правила: точный hostname, `*.suffix` (только поддомены —
 * сам suffix требует отдельного правила) или CIDR/IP-литерал хоста.
 *
 * Семантика шаблона — общая с host-паттернами `security.tls` (ADR-099,
 * `matchTlsHostPattern`): дублирующая логика не разводится по подсистемам.
 * Паттерн `*` («любой хост») намеренно **не** поддерживается — fail-closed:
 * иначе исключение (`exceptions`) разрешило бы любой адрес.
 */
export function hostMatchesRule(rawHost: string, rawRule: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  const rule = rawRule.trim().toLowerCase().replace(/\.$/, '');
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) {
    // `*.example.com` — поддомены, но не сам `example.com`.
    return matchTlsHostPattern(rule, host);
  }
  if (isAddressRule(rule)) {
    if (isIP(host) !== 0) return isIpInCidr(host, rule);
    // CIDR-правило не разрешает hostname «сразу» — только по резолву.
    return false;
  }
  if (rule === '*') return false;
  return matchTlsHostPattern(rule, host);
}

/** Первое hostname-исключение, матчащее хост (без DNS). */
export function findHostException(host: string, exceptions: readonly string[] | undefined): string | undefined {
  if (!exceptions) return undefined;
  return exceptions.find((rule) => !isAddressRule(rule) && hostMatchesRule(host, rule));
}

/** Первое адресное (CIDR/IP) исключение, покрывающее хотя бы один resolved-адрес. */
export function findAddressException(
  addresses: readonly string[],
  exceptions: readonly string[] | undefined,
): string | undefined {
  if (!exceptions) return undefined;
  return exceptions.find(
    (rule) => isAddressRule(rule) && addresses.some((address) => isIpInCidr(address, rule)),
  );
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
 * Проверяет доступность URL по политике (fail-closed).
 *
 * Порядок: схемный хост → hostname-исключения (без DNS) → DNS-резолв всех
 * A/AAAA → адресные (CIDR/IP) исключения → локальные имена → основной список:
 * - `deny`: запрещён, если хотя бы один resolved IP попадает в `list`;
 * - `allow`: разрешён, только если **все** resolved IP входят в `list`
 *   (или сработало exception).
 *
 * `policy === undefined` — ошибка конфигурации (fail-closed), а не «разрешено всё»:
 * вызывающий обязан передать resolved-политику (конфиг-дефолт → встроенный дефолт).
 */
export async function evaluateMcpNetworkAccess(
  url: string,
  policy: McpNetworkPolicy | undefined,
  options?: { resolveHost?: HostResolver },
): Promise<McpNetworkCheckResult> {
  if (!policy) {
    return { allowed: false, reason: 'egress-политика не задана (fail-closed)' };
  }

  const host = hostFromUrl(url);
  if (!host) {
    return { allowed: false, reason: `Некорректный URL MCP-сервера: ${url}` };
  }
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, '');
  const exceptions = policy.exceptions ?? [];

  // Hostname-exception разрешает сразу, без DNS.
  const hostException = findHostException(normalizedHost, exceptions);
  if (hostException) {
    return { allowed: true, matchedRule: hostException };
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

  // Адресные исключения — после резолва (в т.ч. разрешают localhost/приватные).
  const addressException = findAddressException(addresses, exceptions);
  if (addressException) {
    return { allowed: true, addresses, matchedRule: addressException };
  }

  if (isLocalHostname(normalizedHost)) {
    return {
      allowed: false,
      reason: `Хост "${host}" запрещён (loopback/private/link-local/local)`,
      addresses,
      matchedRule: 'local-hostname',
    };
  }

  if (policy.mode === 'deny') {
    for (const address of addresses) {
      for (const cidr of policy.list) {
        if (isIpInCidr(address, cidr)) {
          return {
            allowed: false,
            reason: `Адрес "${host}" (${address}) запрещён сетевой политикой (${cidr})`,
            addresses,
            matchedRule: cidr,
          };
        }
      }
    }
    return { allowed: true, addresses };
  }

  // allow с пустым списком: разрешать нечего (fail-closed).
  for (const address of addresses) {
    const matched = policy.list.find((cidr) => isIpInCidr(address, cidr));
    if (!matched) {
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
