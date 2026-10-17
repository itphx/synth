/**
 * ADR-099 (этап D1): активная конфигурация egress-прокси процесса.
 *
 * Модульное состояние без зависимости от `undici`: его читают точки, которым
 * прокси нужен как *политика* (egress-guard решает, выполнять ли DNS/CIDR;
 * MCP stdio/korotкие env для дочерних процессов; git `http.proxy`), а сам
 * dispatcher собирается отдельно (`proxy-dispatcher.ts`).
 *
 * Источник истины — `initTlsTrust` (`security/tls.ts`): резолвит `proxy` из
 * конфига/env (`resolveProxyConfig`, ADR-023) и кладёт сюда. До инициализации —
 * прокси выключен (поведение не меняется).
 */
import {
  NoProxyMatcher,
  emptyResolvedProxyConfig,
  proxyStatus,
  proxyUrlFor,
  shouldProxyUrl as shouldProxyUrlFor,
  type EgressProxyStatus,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';

/** Фактический маршрут запроса для журнала egress (согласовано с shared). */
export type EgressVia = 'proxy' | 'direct' | 'fallback';

/**
 * Символ-канал «куда фактически ушёл запрос» для dispatcher'а: fetch не умеет
 * возвращать эту информацию, поэтому `egressFetch` оборачивает dispatcher и
 * передаёт колбэк в `DispatchOptions` (нестандартное поле, undici игнорирует).
 */
export const EGRESS_VIA = Symbol.for('synth.egress.via');

export type EgressViaReporter = (via: EgressVia) => void;

let _config: ResolvedProxyConfig | null = null;

/** Установить активную конфигурацию прокси (вызывает `initTlsTrust`). */
export function setEgressProxyConfig(config: ResolvedProxyConfig | null): void {
  _config = config;
}

/** Текущая активная конфигурация прокси (`null` — не инициализирована/выключена). */
export function getEgressProxyConfig(): ResolvedProxyConfig | null {
  return _config;
}

/** Нужно ли направлять URL через прокси (host/noProxy; DNS не выполняется). */
export function shouldProxyUrl(rawUrl: string): boolean {
  return shouldProxyUrlFor(_config, rawUrl);
}

/** URL прокси для конкретного target URL (`undefined` — direct). */
export function proxyUrlForTarget(rawUrl: string): string | undefined {
  if (!_config?.enabled) return undefined;
  return proxyUrlFor(_config, rawUrl);
}

/** Read-only статус прокси для API (без секретов). */
export function getEgressProxyStatus(): EgressProxyStatus {
  return proxyStatus(_config);
}

/**
 * Прокси-URL для git (`-c http.proxy=<url>`): `httpsProxy` → `allProxy` → `url`
 * → `httpProxy`. Пусто — прокси выключен. Учётные данные не поддерживаются (D2).
 */
export function gitProxyConfig(): string[] {
  const config = _config;
  if (!config?.enabled) return [];
  const url = config.httpsProxy ?? config.allProxy ?? config.url ?? config.httpProxy;
  return url ? [`http.proxy=${url}`] : [];
}

/**
 * Env-переменные прокси для дочернего процесса MCP stdio (поверх `config.env`).
 * Учитывается whitelist SDK `getDefaultEnvironment()`: он не фильтрует
 * переданный `env` (мержит `{...defaultEnv, ...env}`), поэтому эти переменные
 * реально доезжают до сервера.
 */
export function mcpProxyEnv(): Record<string, string> {
  const config = _config;
  if (!config?.enabled) return {};
  const env: Record<string, string> = {};
  const http = config.httpProxy ?? config.allProxy ?? config.url;
  const https = config.httpsProxy ?? config.allProxy ?? config.url;
  const all = config.allProxy ?? config.url;
  if (http) env.HTTP_PROXY = http;
  if (https) env.HTTPS_PROXY = https;
  if (all) env.ALL_PROXY = all;
  if (config.noProxy.length > 0) env.NO_PROXY = config.noProxy.join(',');
  return env;
}

/**
 * Обёртка dispatcher'а, сообщающая фактический маршрут через `EGRESS_VIA`.
 * Возвращает объект с `dispatch` (контракт undici), не меняя исходный dispatcher.
 */
export function wrapDispatcherWithVia(
  dispatcher: unknown,
  onVia: EgressViaReporter,
): unknown {
  const target = dispatcher as { dispatch?: (opts: unknown, handler: unknown) => boolean };
  if (typeof target.dispatch !== 'function') return dispatcher;
  return {
    dispatch(opts: Record<string | symbol, unknown>, handler: unknown): boolean {
      return target.dispatch!({ ...opts, [EGRESS_VIA]: onVia }, handler) as boolean;
    },
  };
}

/** Сброс модульного состояния (изоляция тестов). */
export function resetEgressProxyState(): void {
  _config = null;
}

/** Конфигурация «прокси выключен» для мест без инициализации. */
export function disabledProxyConfig(): ResolvedProxyConfig {
  return emptyResolvedProxyConfig();
}

/** Матчер для произвольного списка (экспорт для переиспользования/тестов). */
export { NoProxyMatcher };
