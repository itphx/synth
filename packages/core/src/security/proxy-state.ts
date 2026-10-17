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
import { createHash } from 'node:crypto';
import {
  NoProxyMatcher,
  emptyResolvedProxyConfig,
  proxyStatus,
  proxyUrlFor,
  shouldProxyUrl as shouldProxyUrlFor,
  type EgressProxyStatus,
  type ProxyCredentials,
  type ProxyUrlField,
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

/** Хеш секрета для fingerprint (сравнение running/saved без раскрытия значения). */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Нормализованный отпечаток конфигурации прокси для `restartRequired`:
 * маршрут/URL/noProxy/timeout/TLS/креды (пароль — только хеш). Выключенный
 * прокси и отсутствие инициализации дают одинаковый `disabled` (рестарт не нужен).
 */
export function proxyConfigFingerprint(config: ResolvedProxyConfig | null | undefined): string {
  if (!config || !config.enabled) return 'disabled';
  const credentials = config.credentials
    ? Object.entries(config.credentials)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([field, value]) => [
          field,
          value?.username ?? '',
          value?.password !== undefined ? sha256(value.password) : '',
        ])
    : [];
  return JSON.stringify({
    enabled: true,
    url: config.url ?? null,
    httpProxy: config.httpProxy ?? null,
    httpsProxy: config.httpsProxy ?? null,
    allProxy: config.allProxy ?? null,
    noProxy: [...config.noProxy].map((item) => item.toLowerCase()).sort(),
    fallbackDirect: config.fallbackDirect,
    connectTimeoutMs: config.connectTimeoutMs,
    tls: config.tls
      ? {
          ca: config.tls.ca !== undefined ? sha256(config.tls.ca) : null,
          cert: config.tls.cert !== undefined ? sha256(config.tls.cert) : null,
          key: config.tls.key !== undefined ? sha256(config.tls.key) : null,
          rejectUnauthorized: config.tls.rejectUnauthorized,
        }
      : null,
    credentials,
  });
}

/**
 * Прокси-URL для git (`-c http.proxy=<url>`) — **legacy D1**, без кред и без
 * `no_proxy`. Начиная с D2b `GitService` использует child-env (`gitProxyEnv`),
 * где libcurl сам применяет `no_proxy` и Basic-креды из userinfo. Функция
 * оставлена для диагностики/совместимости и в argv больше не попадает.
 */
export function gitProxyConfig(): string[] {
  const config = _config;
  if (!config?.enabled) return [];
  const url = config.httpsProxy ?? config.allProxy ?? config.url ?? config.httpProxy;
  return url ? [`http.proxy=${url}`] : [];
}

/** URL с Basic-кредами в userinfo (percent-encoded); пароль не логируется. */
function withCredentials(url: string, credentials: ProxyCredentials | undefined): string {
  if (!credentials) return url;
  const match = /^([a-z0-9]+:\/\/)(.*)$/i.exec(url);
  if (!match) return url;
  const user = encodeURIComponent(credentials.username);
  const pass = encodeURIComponent(credentials.password);
  return `${match[1]}${user}:${pass}@${match[2]}`;
}

/** Выбор URL+кред по приоритету полей (для `*_proxy` env). */
function pickProxyField(
  config: ResolvedProxyConfig,
  fields: ProxyUrlField[],
): { url: string; credentials?: ProxyCredentials } | undefined {
  for (const field of fields) {
    const url = config[field];
    if (url !== undefined) {
      const credentials = config.credentials?.[field];
      return credentials ? { url, credentials } : { url };
    }
  }
  return undefined;
}

/**
 * Env-переменные прокси для **дочернего git** (D2b): `http_proxy`/`https_proxy`/
 * `all_proxy`/`no_proxy` (lowercase — libcurl их понимает, включая применение
 * `no_proxy`). Basic-креды — в userinfo URL; в argv/`-c` пароль не попадает.
 * Пусто — прокси выключен (env не меняется).
 */
export function gitProxyEnv(): Record<string, string> {
  const config = _config;
  if (!config?.enabled) return {};
  const env: Record<string, string> = {};
  const http = pickProxyField(config, ['httpProxy', 'allProxy', 'url']);
  const https = pickProxyField(config, ['httpsProxy', 'allProxy', 'url']);
  const all = pickProxyField(config, ['allProxy', 'url']);
  if (http) env.http_proxy = withCredentials(http.url, http.credentials);
  if (https) env.https_proxy = withCredentials(https.url, https.credentials);
  if (all) env.all_proxy = withCredentials(all.url, all.credentials);
  if (config.noProxy.length > 0) env.no_proxy = config.noProxy.join(',');
  return env;
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
