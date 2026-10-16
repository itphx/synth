/**
 * PROP-100 / ADR-071 §2.3.1: единый SSRF/egress-guard исходящих запросов.
 *
 * **Одна** реализация проверки «URL/адрес допустим для исходящего запроса»:
 * схема `http(s)` → нормализация и DNS-резолв **всех** A/AAAA-записей →
 * CIDR-сверка **каждого** адреса (`evaluateMcpNetworkAccess`/`isIpInCidr`);
 * редиректы проходятся вручную (`redirect: 'manual'`) с проверкой каждого хопа.
 * Fail-closed: ошибка/пустой резолв/невалидный адрес → запрет.
 *
 * Потребители: `engine/net/fetch.ts` (`validateRemoteUrl`/`fetchText`),
 * `engine/tools/web.ts` (`web_fetch`), `engine/webhooks/*`, backend
 * `routes/providers.ts` (`fetch-icon`). Поведение для IP-литералов не меняется
 * (литерал проверяется политикой без DNS), обход через IPv4-mapped закрыт
 * единой нормализацией `normalizeIp`.
 */

import { isIP } from 'node:net';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
import type { McpNetworkPolicy } from '@itphx/synth-shared';
import {
  evaluateMcpNetworkAccess,
  hostFromUrl,
  isIpInCidr,
  normalizeIp,
} from '../mcp/network-policy.js';
import type { HostResolver } from '../mcp/network-policy.js';
import { egressFetch } from '../../security/tls.js';

/** Подменяемая реализация `fetch` (тесты/инъекция транспорта). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Запрещённые IPv4-диапазоны (SSRF): loopback/private/link-local/CGNAT/спец.
 * `0.0.0.0/8` и `100.64.0.0/10` — усиление (не указаны явно в ADR-046).
 */
const BLOCKED_V4_CIDRS: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

/** Запрещённые IPv6-диапазоны: unspecified, loopback, ULA, link-local, multicast. */
const BLOCKED_V6_CIDRS: readonly string[] = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

/**
 * Единая политика «запрет приватных/локальных адресов» (deny по
 * `DEFAULT_MCP_PRIVATE_CIDRS`) — общая для web/webhooks/net/providers.
 */
export const PRIVATE_EGRESS_POLICY: McpNetworkPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
};

/** Максимум редиректов по умолчанию при ручном следовании. */
export const DEFAULT_EGRESS_MAX_HOPS = 5;

/**
 * `true`, если IP-литерал входит в приватный/локальный диапазон.
 * `normalizeIp` приводит IPv4-mapped IPv6 (`::ffff:a.b.c.d`) к вложенному IPv4
 * и снимает zone-id — проверка единообразна с `isIpInCidr` (ADR-071).
 */
export function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (normalized === null) return false; // не IP-литерал — прежнее поведение
  return isIP(normalized) === 4
    ? BLOCKED_V4_CIDRS.some((cidr) => isIpInCidr(normalized, cidr))
    : BLOCKED_V6_CIDRS.some((cidr) => isIpInCidr(normalized, cidr));
}

/** `true`, если hostname запрещён: `localhost`/`*.localhost`/`*.local`/`*.internal`/приватный IP. */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return isBlockedIp(bare);
  return false;
}

export interface EgressCheckOptions {
  /** Инъекция DNS-резолвера (тесты). По умолчанию — системный `dns.lookup({all:true})`. */
  resolveHost?: HostResolver;
  /** Требовать `https` (webhooks). */
  requireHttps?: boolean;
}

export type EgressCheckResult =
  | { allowed: true; url: URL; addresses?: string[] }
  | { allowed: false; reason: string };

/** Активна ли политика (undefined и `deny` с пустым списком — «разрешено всё»). */
function isPolicyActive(policy: McpNetworkPolicy | undefined): boolean {
  if (!policy) return false;
  return !(policy.mode === 'deny' && policy.list.length === 0);
}

/**
 * Единая проверка «URL допустим для исходящего запроса»: схема + литеральный
 * хост + DNS-резолв **всех** A/AAAA + CIDR-сверка каждого адреса. Fail-closed.
 */
export async function checkEgressUrl(
  raw: string,
  policy: McpNetworkPolicy | undefined,
  options: EgressCheckOptions = {},
): Promise<EgressCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, reason: `некорректный URL: ${raw}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `протокол ${parsed.protocol || '(пустой)'} не поддерживается (только http/https): ${raw}`,
    };
  }
  if (options.requireHttps && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `требуется https: ${raw}` };
  }

  const host = hostFromUrl(parsed.toString());
  if (!host) return { allowed: false, reason: `не удалось выделить хост: ${raw}` };

  // Быстрый литеральный отказ (localhost/.local/.internal/приватный IP) — только
  // при активной политике, чтобы совпадать с семантикой `evaluateMcpNetworkAccess`
  // (undefined / пустой deny-список = без ограничений).
  if (isPolicyActive(policy) && isBlockedHost(host)) {
    return { allowed: false, reason: `хост "${host}" запрещён (loopback/private/link-local/local): ${raw}` };
  }

  const result = await evaluateMcpNetworkAccess(parsed.toString(), policy, {
    resolveHost: options.resolveHost,
  });
  if (!result.allowed) {
    return { allowed: false, reason: result.reason ?? `адрес запрещён сетевой политикой: ${raw}` };
  }
  return { allowed: true, url: parsed, addresses: result.addresses };
}

/** Ошибка сетевой политики egress: URL/адрес/хоп запрещён либо превышен лимит редиректов. */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

export interface EgressFetchOptions {
  /** Политика egress; `undefined`/пустой deny-список — без ограничений (dev). */
  policy?: McpNetworkPolicy;
  /** Инъекция DNS-резолвера (тесты). */
  resolveHost?: HostResolver;
  /** Требовать `https` (webhooks). */
  requireHttps?: boolean;
  /** Максимум редиректов (по умолчанию `DEFAULT_EGRESS_MAX_HOPS`). */
  maxHops?: number;
  /** Транспорт; по умолчанию — глобальный `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * `fetch` с отключёнными автопереходами: **каждый** хоп редиректа проверяется
 * политикой (`checkEgressUrl`); первый запрещённый хоп → `EgressBlockedError`.
 * Гарантирует, что ни один запрос не уйдёт на непроверенный адрес.
 */
export async function fetchWithEgressGuard(
  rawUrl: string,
  init: RequestInit,
  options: EgressFetchOptions = {},
): Promise<Response> {
  const maxHops = options.maxHops ?? DEFAULT_EGRESS_MAX_HOPS;
  // ADR-099: транспорт по умолчанию — `egressFetch` (единое доверие TLS/CA),
  // а не «сырой» глобальный `fetch`.
  const fetchImpl: FetchLike = options.fetchImpl ?? egressFetch;
  let current = rawUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    const check = await checkEgressUrl(current, options.policy, {
      resolveHost: options.resolveHost,
      requireHttps: options.requireHttps,
    });
    if (!check.allowed) throw new EgressBlockedError(check.reason);

    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      try {
        current = new URL(location, check.url).toString();
      } catch {
        throw new EgressBlockedError(`некорректный Location: ${location}`);
      }
      continue;
    }
    return response;
  }
  throw new EgressBlockedError(`превышено число редиректов (${maxHops})`);
}
