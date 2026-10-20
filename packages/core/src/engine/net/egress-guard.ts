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
 *
 * Список заблокированных диапазонов — **один на весь проект**:
 * `DEFAULT_MCP_PRIVATE_CIDRS` (`@itphx/synth-shared`); он же — дефолт
 * `egress.tools`/`egress.webhooks`/`mcp.networkPolicy`. Локальных копий списка
 * в модуле нет: иначе политика и guard разойдутся.
 */

import { isIP } from 'node:net';
import { DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
import type {
  EgressPolicy,
  EgressRequestScope,
  EgressRequestStatus,
  EgressRequestVia,
} from '@itphx/synth-shared';
import {
  evaluateMcpNetworkAccess,
  findHostException,
  hostFromUrl,
  hostMatchesRule,
  isAddressRule,
  isLocalHostname,
  isIpInCidr,
  normalizeIp,
} from '../mcp/network-policy.js';
import type { HostResolver } from '../mcp/network-policy.js';
import { egressFetch } from '../../security/tls.js';
import { shouldProxyUrl } from '../../security/proxy-state.js';

/** Подменяемая реализация `fetch` (тесты/инъекция транспорта). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Встроенный дефолт политики «запрет служебных/приватных адресов»
 * (deny по `DEFAULT_MCP_PRIVATE_CIDRS` — общему каноническому списку из
 * `@itphx/synth-shared`). Потребители **не** передают её «вслепую»: источник
 * истины — resolved-политика (`egress-policy.ts`).
 */
export const PRIVATE_EGRESS_POLICY: EgressPolicy = {
  mode: 'deny',
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
  exceptions: [],
};

/** Максимум редиректов по умолчанию при ручном следовании. */
export const DEFAULT_EGRESS_MAX_HOPS = 5;

/**
 * `true`, если IP-литерал входит в запрещённый диапазон.
 *
 * **Единый источник истины** — `DEFAULT_MCP_PRIVATE_CIDRS` (`@itphx/synth-shared`):
 * тот же список, что и дефолты `egress.tools`/`egress.webhooks`/`mcp.networkPolicy`.
 * Локальных копий списка в модуле нет.
 *
 * - без политики — встроенный канонический список (fallback; в рантайме политика
 *   всегда передаётся, `checkEgressUrl` при `policy === undefined` fail-closed);
 * - с политикой — учитываются `exceptions` и список политики (deny/allow).
 */
export function isBlockedIp(ip: string, policy?: EgressPolicy): boolean {
  const normalized = normalizeIp(ip);
  if (normalized === null) return false; // не IP-литерал — прежнее поведение
  if (!policy) {
    return DEFAULT_MCP_PRIVATE_CIDRS.some((cidr) => isIpInCidr(normalized, cidr));
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
 * Без политики — встроенный канонический список (`localhost`/`*.local`/
 * `*.internal` + `DEFAULT_MCP_PRIVATE_CIDRS`); с политикой — exceptions
 * проверяются первыми, локальные имена запрещены (если не разрешены
 * exception), IP-литералы — по списку политики.
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
  /**
   * ADR-099 (D1): запрос идёт через прокси. Тогда проверяется только схема и
   * hostname-правила (`isBlockedHost`, `exceptions`/`list` по host/`*.suffix`);
   * DNS-резолв и CIDR-сверка **не выполняются** (адрес назначения известен
   * только прокси).
   */
  proxied?: boolean;
}

export type EgressCheckResult =
  | { allowed: true; url: URL; addresses?: string[]; matchedRule?: string; proxied?: boolean }
  | { allowed: false; reason: string; matchedRule?: string; addresses?: string[]; proxied?: boolean };

/**
 * Единая проверка «URL допустим для исходящего запроса»: схема + hostname/
 * адресные исключения + DNS-резолв **всех** A/AAAA + CIDR-сверка каждого адреса.
 * `proxied: true` — без DNS/CIDR (только hostname-правила, ADR-099 D1).
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

  // ADR-099 (D1): через прокси адрес назначения неизвестен — DNS/CIDR не
  // выполняем; проверяем хостнейм-правила политики (exceptions/list по hostname)
  // и литеральные локальные/IP-адреса. Fail-closed в allow-режиме, если
  // политика состоит только из CIDR (проверить её через прокси невозможно).
  if (options.proxied) {
    const exception = findHostException(host, policy.exceptions);
    if (exception) {
      return { allowed: true, url: parsed, matchedRule: exception, proxied: true };
    }
    if (isBlockedHost(host, policy)) {
      return {
        allowed: false,
        reason: `адрес запрещён сетевой политикой (proxied): ${raw}`,
        matchedRule: 'local-hostname',
        proxied: true,
      };
    }
    const hostRules = policy.list.filter((rule) => !isAddressRule(rule));
    if (policy.mode === 'deny') {
      const rule = hostRules.find((entry) => hostMatchesRule(host, entry));
      if (rule) {
        return {
          allowed: false,
          reason: `адрес запрещён сетевой политикой (proxied): ${raw}`,
          matchedRule: rule,
          proxied: true,
        };
      }
      return { allowed: true, url: parsed, proxied: true };
    }
    // allow: hostname должен входить в список; CIDR без DNS не проверяется.
    const rule = hostRules.find((entry) => hostMatchesRule(host, entry));
    if (!rule) {
      return {
        allowed: false,
        reason:
          `allow-политика не проверяема через прокси для "${host}" ` +
          '(нет hostname-правила; CIDR/DNS не выполняются)',
        matchedRule: 'proxied-allow-unverifiable',
        proxied: true,
      };
    }
    return { allowed: true, url: parsed, matchedRule: rule, proxied: true };
  }

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
  return {
    allowed: true,
    url: parsed,
    addresses: result.addresses,
    matchedRule: result.matchedRule,
    proxied: false,
  };
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
  /** ADR-099 (D1): фактический маршрут запроса (proxy/direct/fallback). */
  via?: EgressRequestVia;
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
  // а не «сырой» глобальный `fetch`. `onVia` сообщает фактический маршрут
  // (proxy/direct/fallback — ADR-099 D1) для журнала egress.
  let currentVia: EgressRequestVia = 'direct';
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    ((input, requestInit) =>
      egressFetch(input, requestInit, { onVia: (via) => { currentVia = via; } }));
  const now = options.now ?? Date.now;
  const method = init.method ?? 'GET';
  let current = rawUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    const started = now();
    const target = sanitizeEgressTarget(current);
    // ADR-099 (D1): маршрут определяется для **каждого** хопа: host из no_proxy
    // идёт напрямую (полная DNS/CIDR-проверка), проксируемый — только hostname.
    const proxied = shouldProxyUrl(current);
    currentVia = proxied ? 'proxy' : 'direct';
    if (options.skipPolicy) {
      // `off` (dev): проверок нет, редиректы обрабатывает транспорт.
      const response = await fetchImpl(current, { ...init });
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'allowed',
        via: currentVia,
        httpStatus: response.status,
        durationMs: Math.max(0, now() - started),
      });
      return response;
    }
    const check = await checkEgressUrl(current, options.policy, {
      resolveHost: options.resolveHost,
      requireHttps: options.requireHttps,
      proxied,
    });
    if (!check.allowed) {
      await recordEgress(options, {
        host: target.host,
        url: target.url,
        method,
        status: 'blocked',
        via: currentVia,
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
        via: currentVia,
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
          via: currentVia,
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
        via: currentVia,
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
      via: currentVia,
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
    via: currentVia,
    reason: `превышено число редиректов (${maxHops})`,
    matchedRule: 'redirect-limit',
  });
  throw new EgressBlockedError(`превышено число редиректов (${maxHops})`, 'redirect-limit');
}
