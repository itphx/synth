/**
 * ADR-099 (этап D1): HTTP/HTTPS-прокси в едином egress-слое.
 *
 * Здесь только **чтение и валидация** конфигурации прокси (секция `proxy`,
 * ADR-023): приоритет `SYNTH_PROXY_*` > `config.proxy` > стандартные
 * `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` (если `fromEnv`) > defaults.
 * Построение undici-dispatcher'а и применение к исходящим запросам — в core
 * (`packages/core/src/security/proxy-dispatcher.ts`).
 *
 * Fail-closed: битый URL, неподдерживаемая схема (SOCKS5 — этап D2) и
 * userinfo-аутентификация (Basic/NTLM — этап D2) → ошибка на старте, как
 * `security.tls.caFile` → не-PEM. Пароли не логируются и не отдаются наружу
 * (`redactProxyUrl`).
 */
import { BlockList, isIP } from 'node:net';
import type { ProxyConfig } from './types.js';

/** Env-имена секции `proxy` (ADR-023). */
export const PROXY_ENV = {
  enabled: 'SYNTH_PROXY_ENABLED',
  url: 'SYNTH_PROXY_URL',
  httpProxy: 'SYNTH_PROXY_HTTP_PROXY',
  httpsProxy: 'SYNTH_PROXY_HTTPS_PROXY',
  allProxy: 'SYNTH_PROXY_ALL_PROXY',
  noProxy: 'SYNTH_PROXY_NO_PROXY',
  fallbackDirect: 'SYNTH_PROXY_FALLBACK_DIRECT',
  connectTimeoutMs: 'SYNTH_PROXY_CONNECT_TIMEOUT_MS',
} as const;

/** Стандартные env-имена прокси (учитываются только при `fromEnv`). */
export const STANDARD_PROXY_ENV = {
  httpProxy: ['HTTP_PROXY', 'http_proxy'],
  httpsProxy: ['HTTPS_PROXY', 'https_proxy'],
  allProxy: ['ALL_PROXY', 'all_proxy'],
  noProxy: ['NO_PROXY', 'no_proxy'],
} as const;

/** Ошибка конфигурации прокси (fail-closed, код для API/логов). */
export class ProxyConfigError extends Error {
  readonly code = 'EGRESS_PROXY_CONFIG_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

/** Минимальный срез конфига, достаточный резолверу (совместим с `SynthConfig`). */
export interface ProxyConfigSource {
  /** Частичная секция (совместима с `SynthConfig['proxy']`; литералы тестов — тоже). */
  proxy?: Partial<ProxyConfig> | undefined;
}

/** Откуда взято эффективное значение. */
export type ProxyConfigOrigin = 'env' | 'config';

/** Эффективная конфигурация прокси (после слияния env/config/defaults). */
export interface ResolvedProxyConfig {
  enabled: boolean;
  /** Источник эффективного прокси-URL: `env` | `config`; `none` — прокси выключен. */
  source: 'env' | 'config' | 'none';
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy: string[];
  fromEnv: boolean;
  /** Явный opt-in: при недоступном прокси идти напрямую (warn + via:'fallback'). */
  fallbackDirect: boolean;
  connectTimeoutMs: number;
}

/** Read-only статус прокси для `GET /api/v2/settings/proxy` (без секретов). */
export interface EgressProxyStatus {
  enabled: boolean;
  source: 'env' | 'config' | 'none';
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy: string[];
  fallbackDirect: boolean;
  connectTimeoutMs: number;
  /** Настройка применяется при старте процесса. */
  restartRequired: true;
}

/** Схема аутентификации, запрошенная прокси (D2 — Basic/NTLM/Negotiate). */
export type ProxyAuthChallenge = 'Basic' | 'NTLM' | 'Negotiate' | 'none';

/** Результат `POST /api/v2/settings/proxy/check` (проверка только коннекта к прокси). */
export interface ProxyCheckResult {
  reachable: boolean;
  latencyMs: number;
  error?: string;
  authChallenge: ProxyAuthChallenge;
}

/** Разобранный и нормализованный URL прокси (без userinfo). */
export interface ParsedProxyUrl {
  /** Нормализованный origin: `http://host:port` (path/query/hash отброшены). */
  href: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
}

/** Пустая (не заданная) конфигурация — прокси выключен (поведение не меняется). */
export function emptyResolvedProxyConfig(): ResolvedProxyConfig {
  return {
    enabled: false,
    source: 'none',
    noProxy: [],
    fromEnv: true,
    fallbackDirect: false,
    connectTimeoutMs: 10_000,
  };
}

/**
 * Разбирает URL прокси. Только `http`/`https` (SOCKS5 — этап D2).
 * Fail-closed: нет схемы/хоста, чужая схема, userinfo (аутентификация — D2).
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  const value = raw.trim();
  if (!value) throw new ProxyConfigError('proxy: пустой URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyConfigError(`proxy: некорректный URL "${redactProxyUrl(value)}"`);
  }
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:' || url.protocol === 'socks:') {
    throw new ProxyConfigError(
      'proxy: SOCKS5 пока не поддерживается (этап D2) — используйте http:// или https://',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyConfigError(
      `proxy: схема "${url.protocol.replace(/:$/, '')}" не поддерживается (только http/https)`,
    );
  }
  if (url.username || url.password) {
    throw new ProxyConfigError(
      'proxy: userinfo (Basic/NTLM) пока не поддерживается (этап D2) — ' +
        'уберите логин/пароль из URL прокси',
    );
  }
  if (!url.hostname) {
    throw new ProxyConfigError(`proxy: не удалось выделить хост из "${redactProxyUrl(value)}"`);
  }
  const protocol = url.protocol as 'http:' | 'https:';
  const port = url.port ? Number(url.port) : protocol === 'https:' ? 443 : 80;
  return { href: `${protocol}//${url.host}`, protocol, hostname: url.hostname, port };
}

/**
 * Безопасное представление URL прокси для логов/API: без userinfo, path/query/hash.
 * Невалидный URL → пустая строка (не эхоим потенциальный секрет).
 */
export function redactProxyUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = '/';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Матчер `noProxy` (без regex): `host`, `.suffix`, `*.suffix`, `host:port`,
 * IPv4/IPv6-литерал, CIDR, `*` (всё напрямую).
 *
 * - `example.com` — точное совпадение;
 * - `.example.com` — сам домен и поддомены;
 * - `*.example.com` — только поддомены;
 * - `example.com:8443` — точный host+port;
 * - `10.0.0.0/8` — только IP-литералы хоста (DNS не выполняется);
 * - `*` — прокси не используется ни для одного хоста.
 */
export class NoProxyMatcher {
  private readonly _all: boolean;
  private readonly _hosts = new Set<string>();
  private readonly _suffixes: string[] = [];
  private readonly _wildcards: string[] = [];
  private readonly _hostPorts = new Set<string>();
  private readonly _ips = new Set<string>();
  private readonly _cidrs = new BlockList();
  private readonly _hasCidr: boolean;

  constructor(entries: readonly string[] | undefined) {
    let all = false;
    let hasCidr = false;
    for (const raw of entries ?? []) {
      if (typeof raw !== 'string') continue;
      const entry = raw.trim().toLowerCase().replace(/\.$/, '');
      if (!entry) continue;
      if (entry === '*') {
        all = true;
        continue;
      }
      if (entry.includes('/')) {
        const slash = entry.lastIndexOf('/');
        const net = entry.slice(0, slash).trim();
        const prefix = Number(entry.slice(slash + 1).trim());
        const version = isIP(net);
        if (version === 0 || !Number.isInteger(prefix)) continue;
        if (prefix < 0 || prefix > (version === 4 ? 32 : 128)) continue;
        try {
          this._cidrs.addSubnet(net, prefix, version === 4 ? 'ipv4' : 'ipv6');
          hasCidr = true;
        } catch {
          // Невалидный CIDR — запись игнорируется (fail-soft: остальные правила работают).
        }
        continue;
      }
      // IPv6 в скобках: `[::1]` либо `[::1]:8080`.
      const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      if (bracket) {
        const host = bracket[1]!;
        if (bracket[2]) this._hostPorts.add(`${host}|${bracket[2]}`);
        else this._ips.add(host);
        continue;
      }
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(2);
        if (suffix) this._wildcards.push(suffix);
        continue;
      }
      if (entry.startsWith('.')) {
        const suffix = entry.slice(1);
        if (suffix) this._suffixes.push(suffix);
        continue;
      }
      if (isIP(entry) !== 0) {
        this._ips.add(entry);
        continue;
      }
      // `host:port` (не IPv6: там двоеточий больше одного).
      const colon = entry.lastIndexOf(':');
      if (colon > 0 && !entry.slice(0, colon).includes(':') && /^\d+$/.test(entry.slice(colon + 1))) {
        this._hostPorts.add(`${entry.slice(0, colon)}|${entry.slice(colon + 1)}`);
        continue;
      }
      this._hosts.add(entry);
    }
    this._all = all;
    this._hasCidr = hasCidr;
  }

  /** `true` — хост исключён из прокси (идём напрямую). */
  matches(rawHost: string, port?: number | string): boolean {
    const host = normalizeHost(rawHost);
    if (!host) return false;
    if (this._all) return true;
    if (this._hosts.has(host) || this._ips.has(host)) return true;
    if (this._suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
    if (this._wildcards.some((suffix) => host.endsWith(`.${suffix}`))) return true;
    if (port !== undefined && port !== '') {
      if (this._hostPorts.has(`${host}|${String(port)}`)) return true;
    }
    if (this._hasCidr) {
      const version = isIP(host);
      if (version !== 0) {
        try {
          if (this._cidrs.check(host, version === 4 ? 'ipv4' : 'ipv6')) return true;
        } catch {
          // некорректный литерал — не матчим
        }
      }
    }
    return false;
  }
}

/** Нормализует hostname (нижний регистр, без завершающей точки/скобок IPv6). */
function normalizeHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

/** Непустое значение env (пустая строка — «не задано», как прочие env-резолверы). */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== '' ? value : undefined;
}

/** Парсит boolean env; невалидно → warn + `undefined` (фоллбэк на config). */
function envBoolean(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  console.warn(`[config] невалидное значение ${name}="${raw}" (ожидается true/1/false/0) — игнорируется`);
  return undefined;
}

/** Парсит положительное целое env; невалидно → warn + `undefined`. */
function envPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  console.warn(`[config] невалидное значение ${name}="${raw}" (ожидается положительное целое) — игнорируется`);
  return undefined;
}

/** Разбивает список no_proxy из env (через запятую/пробелы — стандарт). */
function splitEnvList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface PickedUrl {
  value?: string;
  origin?: ProxyConfigOrigin;
}

/**
 * Сливает env и config.yaml для секции `proxy` (ADR-023).
 *
 * Приоритет: `SYNTH_PROXY_*` > `config.proxy` > стандартные env (при `fromEnv`) >
 * defaults. Явный `proxy.enabled: false` (config) подавляет стандартные env —
 * прокси не включается «из окружения» вопреки конфигу.
 */
export function resolveProxyConfig(
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyConfig {
  const cfg = (config?.proxy ?? {}) as Partial<ProxyConfig>;
  const fromEnv = cfg.fromEnv ?? true;
  const empty = emptyResolvedProxyConfig();

  const pickUrl = (
    envKey: string,
    cfgValue: string | undefined,
    standard: readonly string[],
  ): PickedUrl => {
    const synth = envValue(env, envKey);
    if (synth !== undefined) return { value: parseProxyUrl(synth).href, origin: 'env' };
    if (cfgValue !== undefined && cfgValue !== '') {
      return { value: parseProxyUrl(cfgValue).href, origin: 'config' };
    }
    if (fromEnv) {
      for (const key of standard) {
        const raw = envValue(env, key);
        if (raw !== undefined) return { value: parseProxyUrl(raw).href, origin: 'env' };
      }
    }
    return {};
  };

  const url = pickUrl(PROXY_ENV.url, cfg.url, []);
  const httpProxy = pickUrl(PROXY_ENV.httpProxy, cfg.httpProxy, STANDARD_PROXY_ENV.httpProxy);
  const httpsProxy = pickUrl(PROXY_ENV.httpsProxy, cfg.httpsProxy, STANDARD_PROXY_ENV.httpsProxy);
  const allProxy = pickUrl(PROXY_ENV.allProxy, cfg.allProxy, STANDARD_PROXY_ENV.allProxy);

  // noProxy: SYNTH_PROXY_NO_PROXY > config.noProxy (непустой) > NO_PROXY (при fromEnv).
  let noProxy: string[] = [];
  const envNoProxy = envValue(env, PROXY_ENV.noProxy);
  if (envNoProxy !== undefined) {
    noProxy = splitEnvList(envNoProxy);
  } else if (Array.isArray(cfg.noProxy) && cfg.noProxy.length > 0) {
    noProxy = cfg.noProxy.map((item) => String(item).trim()).filter(Boolean);
  } else if (fromEnv) {
    for (const key of STANDARD_PROXY_ENV.noProxy) {
      const raw = envValue(env, key);
      if (raw !== undefined) {
        noProxy = splitEnvList(raw);
        break;
      }
    }
  }

  const picked = [url, httpProxy, httpsProxy, allProxy];
  const urls = picked.map((p) => p.value).filter((value): value is string => value !== undefined);
  const hasAnyUrl = urls.length > 0;

  const explicitEnv = envBoolean(envValue(env, PROXY_ENV.enabled), PROXY_ENV.enabled);
  const explicitCfg = cfg.enabled;
  const explicit = explicitEnv ?? explicitCfg;

  let enabled: boolean;
  if (explicit !== undefined) {
    enabled = explicit;
  } else {
    // Не задано явно — прокси включается наличием URL (в т.ч. из стандартных env).
    enabled = hasAnyUrl;
  }
  if (enabled && !hasAnyUrl) {
    throw new ProxyConfigError(
      'proxy.enabled=true, но не задан URL прокси — укажите proxy.url/httpProxy/httpsProxy/allProxy ' +
        `либо ${PROXY_ENV.url} (fail-closed: тихого direct-режима нет)`,
    );
  }

  const envFallback = envBoolean(envValue(env, PROXY_ENV.fallbackDirect), PROXY_ENV.fallbackDirect);
  const fallbackDirect = envFallback ?? cfg.fallbackDirect ?? empty.fallbackDirect;
  const connectTimeoutMs =
    envPositiveInt(envValue(env, PROXY_ENV.connectTimeoutMs), PROXY_ENV.connectTimeoutMs) ??
    cfg.connectTimeoutMs ??
    empty.connectTimeoutMs;

  const origins = picked.map((p) => p.origin).filter((origin): origin is ProxyConfigOrigin => origin !== undefined);
  const source: ResolvedProxyConfig['source'] = !enabled
    ? 'none'
    : origins.includes('env')
      ? 'env'
      : origins.includes('config')
        ? 'config'
        : 'none';

  const resolved: ResolvedProxyConfig = {
    enabled,
    source,
    noProxy,
    fromEnv,
    fallbackDirect,
    connectTimeoutMs,
  };
  if (url.value !== undefined) resolved.url = url.value;
  if (httpProxy.value !== undefined) resolved.httpProxy = httpProxy.value;
  if (httpsProxy.value !== undefined) resolved.httpsProxy = httpsProxy.value;
  if (allProxy.value !== undefined) resolved.allProxy = allProxy.value;
  return resolved;
}

/**
 * URL прокси для target-origin: `httpsProxy`/`httpProxy` по схеме цели, затем
 * `allProxy`, затем общий `url`. `undefined` — прокси для этой схемы нет.
 */
export function proxyUrlFor(config: ResolvedProxyConfig, origin: string | URL): string | undefined {
  let protocol: string;
  try {
    protocol = typeof origin === 'string' ? new URL(origin).protocol : origin.protocol;
  } catch {
    return undefined;
  }
  if (protocol === 'https:') return config.httpsProxy ?? config.allProxy ?? config.url;
  if (protocol === 'http:') return config.httpProxy ?? config.allProxy ?? config.url;
  return undefined;
}

/**
 * Нужно ли направлять URL через прокси: прокси включён, есть прокси для схемы
 * и хост не исключён `noProxy`. DNS/CIDR-сверка не выполняется (только host/port).
 */
export function shouldProxyUrl(
  config: ResolvedProxyConfig | null | undefined,
  rawUrl: string,
): boolean {
  if (!config?.enabled) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (proxyUrlFor(config, parsed) === undefined) return false;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return !new NoProxyMatcher(config.noProxy).matches(parsed.hostname, port);
}

/** Read-only статус прокси (без userinfo/секретов). */
export function proxyStatus(config: ResolvedProxyConfig | null | undefined): EgressProxyStatus {
  const resolved = config ?? emptyResolvedProxyConfig();
  const status: EgressProxyStatus = {
    enabled: resolved.enabled,
    source: resolved.source,
    noProxy: [...resolved.noProxy],
    fallbackDirect: resolved.fallbackDirect,
    connectTimeoutMs: resolved.connectTimeoutMs,
    restartRequired: true,
  };
  const url = redactProxyUrl(resolved.url);
  if (url) status.url = url;
  const httpProxy = redactProxyUrl(resolved.httpProxy);
  if (httpProxy) status.httpProxy = httpProxy;
  const httpsProxy = redactProxyUrl(resolved.httpsProxy);
  if (httpsProxy) status.httpsProxy = httpsProxy;
  const allProxy = redactProxyUrl(resolved.allProxy);
  if (allProxy) status.allProxy = allProxy;
  return status;
}
