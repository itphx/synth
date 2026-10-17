/**
 * PROP-100 / ADR-071 §2.3.1: единый SSRF/egress-guard исходящих запросов.
 *
 * **Одна** реализация проверки «URL/адрес допустим для исходящего запроса»:
 * схема `http(s)` → hostname-исключения → нормализация и DNS-резолв **всех**
 * A/AAAA-записей → адресные исключения → CIDR-сверка **каждого** адреса
 * (`evaluateMcpNetworkAccess`/`isIpInCidr`); редиректы проходятся вручную
 * (`redirect: 'manual'`) с проверкой каждого хопа. Fail-closed: отсутствие
 * политики/ошибка/пустой резолв/невалидный адрес → запрет.
 *
 * Политика приходит **resolved** от вызывающего (per-request; см.
 * `egress-policy.ts`); `undefined` больше не означает «разрешено всё».
 * Потребители: `engine/net/fetch.ts`, `engine/tools/web.ts`,
 * `engine/webhooks/*`, `engine/skills/remote.ts`, `engine/context/instructions.ts`,
 * backend `routes/providers.ts`.
 */

import { isIP } from 'node:net';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
import type { EgressPolicy, EgressRequestScope, EgressRequestStatus } from '@itphx/synth-shared';
import {
  evaluateMcpNetworkAccess,
  findHostException,
  hostFromUrl,
  isLocalHostname,
  isIpInCidr,
  normalizeIp,
} from '../mcp/network-policy.js';
import type { HostResolver } from '../mcp/network-policy.js';
import { egressFetch } from '../../security/tls.js';

/** Подменяемая реализация `fetch` (тесты/инъекция транспорта). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Запрещённые IPv4-диапазоны по умолчанию (SSRF): loopback/private/link-local/
 * CGNAT/спец. Экспорт — для обратной совместимости/тестов.
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
 * Встроенный дефолт политики «запрет приватных/локальных адресов»
 * (deny по `DEFAULT_MCP_PRIVATE_CIDRS`). Потребители **не** передают её
 * «вслепую»: источник истины — resolved-политика (`egress-policy.ts`).
 */
export const PRIVATE_EGRESS_POLICY: EgressPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
  exceptions: [],
};

/** Максимум редиректов по умолчанию при ручном следовании. */
export const DEFAULT_EGRESS_MAX_HOPS = 5;

/**
 * `true`, если IP-литерал входит в приватный/локальный диапазон.
 * Без политики — прежнее поведение (встроенный список); с политикой —
 * учитываются `exceptions` и список политики (deny/allow).
 */
export function isBlockedIp(ip: string, policy?: EgressPolicy): boolean {
  const normalized = normalizeIp(ip);
  if (normalized === null) return false; // не IP-литерал — прежнее поведение
  if (!policy) {
    return isIP(normalized) === 4
      ? BLOCKED_V4_CIDRS.some((cidr) => isIpInCidr(normalized, cidr))
      : BLOCKED_V6_CIDRS.some((cidr) => isIpInCidr(normalized, cidr));
  }
  if (policy.exceptions?.some((rule) => isIpInCidr(normalized, rule))) return false;
  if (policy.mode === 'deny') {
    if (policy.list.length === 0) return false;
    return policy.list.some((cidr) => isIpInCidr(normalized, cidr));
  }
  return !policy.list.some((cidr) => isIpInCidr(normalized, cidr));
}

/**
 * `true`, если hostname запрещён.
 * Без политики — прежнее поведение (localhost/*.local/*.internal/приватный IP);
 * с политикой — exceptions проверяются первыми, локальные имена запрещены
 * (если не разрешены exception), IP-литералы — по списку политики.
 */
export function isBlockedHost(rawHost: string, policy?: EgressPolicy): boolean {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (!policy) {
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (isIP(bare) !== 0) return isBlockedIp(bare);
    return false;
  }
  if (findHostException(host, policy.exceptions)) return false;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return isBlockedIp(bare, policy);
  if (isLocalHostname(host)) return true;
  return false;
}

export interface EgressCheckOptions {
  /** Инъекция DNS-резолвера (тесты). По умолчанию — системный `dns.lookup({all:true})`. */
  resolveHost?: HostResolver;
  /** Требовать `https` (webhooks; `false` при `egress.webhooks.mode='off'`). */
  requireHttps?: boolean;
}

export type EgressCheckResult =
  | { allowed: true; url: URL; addresses?: string[]; matchedRule?: string }
  | { allowed: false; reason: string; matchedRule?: string; addresses?: string[] };

/**
 * Единая проверка «URL допустим для исходящего запроса»: схема + hostname/
 * адресные исключения + DNS-резолв **всех** A/AAAA + CIDR-сверка каждого адреса.
 * Fail-closed: `policy === undefined` → запрет.
 */
export async function checkEgressUrl(
  raw: string,
  policy: EgressPolicy | undefined,
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
  if (!policy) {
    return { allowed: false, reason: 'egress-политика не задана (fail-closed)' };
  }

  const host = hostFromUrl(parsed.toString());
  if (!host) return { allowed: false, reason: `не удалось выделить хост: ${raw}` };

  const result = await evaluateMcpNetworkAccess(parsed.toString(), policy, {
    resolveHost: options.resolveHost,
  });
  if (!result.allowed) {
    return {
      allowed: false,
      reason: result.reason ?? `адрес запрещён сетевой политикой: ${raw}`,
      ...(result.matchedRule ? { matchedRule: result.matchedRule } : {}),
      ...(result.addresses ? { addresses: result.addresses } : {}),
    };
  }
  return { allowed: true, url: parsed, addresses: result.addresses, matchedRule: result.matchedRule };
}

/** Ошибка сетевой политики egress: URL/адрес/хоп запрещён либо превышен лимит редиректов. */
export class EgressBlockedError extends Error {
  /** Сработавшее правило политики (для журнала/аудита). */
  readonly matchedRule?: string;

  constructor(message: string, matchedRule?: string) {
    super(message);
    this.name = 'EgressBlockedError';
    this.matchedRule = matchedRule;
  }
}

/** Событие журнала внешних запросов (без тел/заголовков). */
export interface EgressLogEvent {
  scope: EgressRequestScope;
  host: string;
  url: string;
  method?: string;
  status: EgressRequestStatus;
  httpStatus?: number;
  bytes?: number;
  durationMs?: number;
  reason?: string;
  matchedRule?: string;
  sessionId?: string;
  projectId?: string;
  actor?: string;
}

/** Приёмник журнала внешних запросов (best-effort; ошибки глотаются guard'ом). */
export type EgressLogSink = (event: EgressLogEvent) => void | Promise<void>;

export interface EgressFetchOptions {
  /** Resolved-политика egress (обязательна по смыслу; `undefined` → запрет). */
  policy?: EgressPolicy;
  /**
   * Полностью отключить проверку (только `egress.webhooks.mode='off'`, dev).
   * Fail-closed по умолчанию: не задано — проверка выполняется.
   */
  skipPolicy?: boolean;
  /** Инъекция DNS-резолвера (тесты). */
  resolveHost?: HostResolver;
  /** Требовать `https` (webhooks). */
  requireHttps?: boolean;
  /** Максимум редиректов (по умолчанию `DEFAULT_EGRESS_MAX_HOPS`). */
  maxHops?: number;
  /** Транспорт; по умолчанию — `egressFetch` (единое доверие TLS/CA). */
  fetchImpl?: FetchLike;
  /** Источник запроса для журнала; без `scope` журнал не пишется. */
  scope?: EgressRequestScope;
  sessionId?: string;
  projectId?: string;
  actor?: string;
  /** Приёмник журнала (см. `createEgressLogSink`). */
  log?: EgressLogSink;
  /** Источник времени (тесты). */
  now?: () => number;
}

/** Безопасное извлечение host/url без query/userinfo (тела/заголовки не пишутся). */
export function sanitizeEgressTarget(rawUrl: string): { host: string; url: string } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const url = parsed.toString();
    return { host, url: url.length > 2048 ? url.slice(0, 2048) : url };
  } catch {
    return { host: '', url: rawUrl.slice(0, 2048) };
  }
}

async function recordEgress(options: EgressFetchOptions, event: Omit<EgressLogEvent, 'scope'>): Promise<void> {
  if (!options.scope || !options.log) return;
  try {
    await options.log({
      scope: options.scope,
      sessionId: options.sessionId,
      projectId: options.projectId,
      actor: options.actor,
      ...event,
    });
  } catch (err) {
    // Best-effort: журнал не должен ломать исходящий запрос.
    console.warn(`[egress] не удалось записать событие журнала: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  const now = options.now ?? Date.now;
  const method = init.method ?? 'GET';
  let current = rawUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    const started = now();
    const target = sanitizeEgressTarget(current);
    if (options.skipPolicy) {
      // `off` (dev): проверок нет, редиректы обрабатывает транспорт.
      const response = await fetchImpl(current, { ...init });
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'allowed',
        httpStatus: response.status,
        durationMs: Math.max(0, now() - started),
      });
      return response;
    }
    const check = await checkEgressUrl(current, options.policy, {
      resolveHost: options.resolveHost,
      requireHttps: options.requireHttps,
    });
    if (!check.allowed) {
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'blocked',
        reason: check.reason,
        matchedRule: check.matchedRule,
        durationMs: Math.max(0, now() - started),
      });
      throw new EgressBlockedError(check.reason, check.matchedRule);
    }

    let response: Response;
    try {
      response = await fetchImpl(current, { ...init, redirect: 'manual' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'error',
        reason,
        durationMs: Math.max(0, now() - started),
      });
      throw err;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        await recordEgress(options, {
          host: target.host,
          url: target.url,
          method,
          status: 'allowed',
          httpStatus: response.status,
          durationMs: Math.max(0, now() - started),
        });
        return response;
      }
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'allowed',
        httpStatus: response.status,
        durationMs: Math.max(0, now() - started),
      });
      try {
        current = new URL(location, check.url).toString();
      } catch {
        throw new EgressBlockedError(`некорректный Location: ${location}`);
      }
      continue;
    }

    const declared = response.headers.get('content-length');
    const bytes = declared && Number.isFinite(Number(declared)) ? Number(declared) : undefined;
    await recordEgress(options, {
      host: target.host,
      url: target.url,
      method,
      status: 'allowed',
      httpStatus: response.status,
      ...(bytes !== undefined ? { bytes } : {}),
      durationMs: Math.max(0, now() - started),
    });
    return response;
  }
  const target = sanitizeEgressTarget(rawUrl);
  await recordEgress(options, {
    host: target.host,
    url: target.url,
    method,
    status: 'blocked',
    reason: `превышено число редиректов (${maxHops})`,
    matchedRule: 'redirect-limit',
  });
  throw new EgressBlockedError(`превышено число редиректов (${maxHops})`, 'redirect-limit');
}
