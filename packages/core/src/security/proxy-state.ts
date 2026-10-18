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
  type ResolvedProxyProfile,
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

/** Хеши TLS-материалов профиля (PEM/ключи не раскрываются). */
function tlsFingerprint(tls: ResolvedProxyProfile['tls']): unknown {
  if (!tls) return null;
  return {
    ca: tls.ca !== undefined ? sha256(tls.ca) : null,
    cert: tls.cert !== undefined ? sha256(tls.cert) : null,
    key: tls.key !== undefined ? sha256(tls.key) : null,
    rejectUnauthorized: tls.rejectUnauthorized,
  };
}

/** Метаданные TLS-файлов (пути/флаг `caPem`; содержимого нет). */
function tlsMetaFingerprint(meta: ResolvedProxyProfile['tlsMeta']): unknown {
  if (!meta) return null;
  return {
    caFile: meta.caFile ?? null,
    certFile: meta.certFile ?? null,
    keyFile: meta.keyFile ?? null,
    hasCaPem: meta.hasCaPem,
  };
}

/** Креды профиля: имена полей/username + хеш пароля (сам пароль не попадает). */
function credentialsFingerprint(
  credentials: ResolvedProxyProfile['credentials'],
): Array<[string, string, string]> {
  if (!credentials) return [];
  return Object.entries(credentials)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, value]) => [
      field,
      value?.username ?? '',
      value?.password !== undefined ? sha256(value.password) : '',
    ]);
}

/**
 * Нормализованный отпечаток конфигурации прокси для `restartRequired`:
 * `mode`/`defaultProfile`/профили (URL, auth, TLS, креды — только хеши) и
 * правила (id/label/hosts/action/profile, порядок = приоритет). Секреты/PEM не
 * раскрываются. Выключенный прокси и отсутствие инициализации дают одинаковый
 * `disabled` (рестарт не нужен).
 */
export function proxyConfigFingerprint(config: ResolvedProxyConfig | null | undefined): string {
  if (!config || !config.enabled) return 'disabled';
  const profiles = Object.keys(config.profiles ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const profile = config.profiles[name]!;
      return {
        name,
        label: profile.label ?? null,
        url: profile.url ?? null,
        httpProxy: profile.httpProxy ?? null,
        httpsProxy: profile.httpsProxy ?? null,
        allProxy: profile.allProxy ?? null,
        auth: profile.auth ? { type: profile.auth.type, username: profile.auth.username } : null,
        tlsMeta: tlsMetaFingerprint(profile.tlsMeta),
        tls: tlsFingerprint(profile.tls),
        credentials: credentialsFingerprint(profile.credentials),
      };
    });
  const rules = (config.rules ?? []).map((rule) => ({
    id: rule.id,
    label: rule.label ?? null,
    hosts: [...rule.hosts].map((host) => host.toLowerCase()),
    action: rule.action,
    profile: rule.profile ?? null,
  }));
  return JSON.stringify({
    enabled: true,
    mode: config.mode ?? 'all',
    defaultProfile: config.defaultProfile ?? null,
    profiles,
    rules,
    url: config.url ?? null,
    httpProxy: config.httpProxy ?? null,
    httpsProxy: config.httpsProxy ?? null,
    allProxy: config.allProxy ?? null,
    noProxy: [...config.noProxy].map((item) => item.toLowerCase()).sort(),
    fromEnv: config.fromEnv,
    fallbackDirect: config.fallbackDirect,
    connectTimeoutMs: config.connectTimeoutMs,
    auth: config.auth ? { type: config.auth.type, username: config.auth.username } : null,
    tlsMeta: tlsMetaFingerprint(config.tlsMeta),
    tls: tlsFingerprint(config.tls),
    credentials: credentialsFingerprint(config.credentials),
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

/** Synthetic legacy-default профиль из flat-полей конфигурации. */
function legacyProxyProfileOf(config: ResolvedProxyConfig): ResolvedProxyProfile | undefined {
  if (
    config.url === undefined &&
    config.httpProxy === undefined &&
    config.httpsProxy === undefined &&
    config.allProxy === undefined
  ) {
    return undefined;
  }
  const profile: ResolvedProxyProfile = {
    name: 'default',
    source: config.source === 'none' ? 'config' : config.source,
    legacy: true,
  };
  if (config.url !== undefined) profile.url = config.url;
  if (config.httpProxy !== undefined) profile.httpProxy = config.httpProxy;
  if (config.httpsProxy !== undefined) profile.httpsProxy = config.httpsProxy;
  if (config.allProxy !== undefined) profile.allProxy = config.allProxy;
  if (config.credentials !== undefined) profile.credentials = config.credentials;
  if (config.auth !== undefined) profile.auth = config.auth;
  if (config.tls !== undefined) profile.tls = config.tls;
  if (config.tlsMeta !== undefined) profile.tlsMeta = config.tlsMeta;
  return profile;
}

/**
 * Профиль прокси по имени (единая точка для dispatcher/дочерних env). Legacy-
 * профиль (`legacy:true`) выводится из flat-полей — они остаются авторитетными
 * (совместимость с кодом, который патчит `url`/`httpProxy`/`tls` напрямую),
 * как в shared-резолвере маршрута.
 */
export function proxyProfileOf(
  config: ResolvedProxyConfig,
  name: string | undefined,
): ResolvedProxyProfile | undefined {
  if (name === undefined) return undefined;
  const profile = config.profiles?.[name];
  if (profile?.legacy === true) {
    const legacy = legacyProxyProfileOf(config);
    if (legacy !== undefined) return legacy;
  }
  if (profile !== undefined) return profile;
  if (name === 'default') return legacyProxyProfileOf(config);
  return undefined;
}

/** Профиль по умолчанию (`mode: all` / env дочерних процессов). */
function defaultProxyProfileOf(config: ResolvedProxyConfig): ResolvedProxyProfile | undefined {
  return proxyProfileOf(config, config.defaultProfile ?? 'default');
}

/** Выбор URL+кред профиля по приоритету полей (для `*_proxy` env). */
function pickProxyField(
  profile: ResolvedProxyProfile,
  fields: ProxyUrlField[],
): { url: string; credentials?: ProxyCredentials } | undefined {
  for (const field of fields) {
    const url = profile[field];
    if (url !== undefined) {
      const credentials = profile.credentials?.[field];
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
 *
 * **Ограничение:** дочерний процесс (git) не умеет per-host маршрут прокси.
 * Поэтому прокси-env ставится только для `mode: 'all'` (default-профиль); в
 * `mode: 'selected'` прокси-env не выставляется вовсе — иначе git ходил бы через
 * прокси для **всех** хостов (включая direct-правила). `no_proxy` остаётся.
 */
export function gitProxyEnv(): Record<string, string> {
  const config = _config;
  if (!config?.enabled) return {};
  const env: Record<string, string> = {};
  if (config.mode !== 'selected') {
    const profile = defaultProxyProfileOf(config);
    const http = profile ? pickProxyField(profile, ['httpProxy', 'allProxy', 'url']) : undefined;
    const https = profile ? pickProxyField(profile, ['httpsProxy', 'allProxy', 'url']) : undefined;
    const all = profile ? pickProxyField(profile, ['allProxy', 'url']) : undefined;
    if (http) env.http_proxy = withCredentials(http.url, http.credentials);
    if (https) env.https_proxy = withCredentials(https.url, https.credentials);
    if (all) env.all_proxy = withCredentials(all.url, all.credentials);
  }
  if (config.noProxy.length > 0) env.no_proxy = config.noProxy.join(',');
  return env;
}

/**
 * Env-переменные прокси для дочернего процесса MCP stdio (поверх `config.env`).
 * Учитывается whitelist SDK `getDefaultEnvironment()`: он не фильтрует
 * переданный `env` (мержит `{...defaultEnv, ...env}`), поэтому эти переменные
 * реально доезжают до сервера.
 *
 * **Ограничение:** как и git, MCP-сервер не умеет per-host маршрут — в
 * `mode: 'selected'` прокси-env не выставляется (иначе все хосты пошли бы через
 * прокси); `NO_PROXY` остаётся.
 */
export function mcpProxyEnv(): Record<string, string> {
  const config = _config;
  if (!config?.enabled) return {};
  const env: Record<string, string> = {};
  if (config.mode !== 'selected') {
    const profile = defaultProxyProfileOf(config);
    if (profile) {
      const http = profile.httpProxy ?? profile.allProxy ?? profile.url;
      const https = profile.httpsProxy ?? profile.allProxy ?? profile.url;
      const all = profile.allProxy ?? profile.url;
      if (http) env.HTTP_PROXY = http;
      if (https) env.HTTPS_PROXY = https;
      if (all) env.ALL_PROXY = all;
    }
  }
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
