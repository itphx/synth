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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { PROXY_PROFILE_NAME_RE, proxyConfigSchema } from './types.js';
import { matchTlsHostPattern } from './tls.js';
import type {
  ProxyAuthConfig,
  ProxyConfig,
  ProxyMode,
  ProxyProfileConfig,
  ProxyRuleConfig,
  ProxyTlsConfig,
} from './types.js';

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

/**
 * Пароль Basic-аутентификации прокси: **только** env или файл
 * `{dataDir}/secrets/proxy-password` (в config.yaml не хранится — инвариант 13).
 */
export const PROXY_PASSWORD_ENV = 'SYNTH_PROXY_PASSWORD';

/** Env-имена секции `proxy.tls` (TLS/mTLS к прокси, ADR-023). */
export const PROXY_TLS_ENV = {
  caFile: 'SYNTH_PROXY_TLS_CA_FILE',
  caPem: 'SYNTH_PROXY_TLS_CA_PEM',
  certFile: 'SYNTH_PROXY_TLS_CERT_FILE',
  keyFile: 'SYNTH_PROXY_TLS_KEY_FILE',
  rejectUnauthorized: 'SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED',
} as const;

/** Поля URL прокси (для per-field кредов). */
export const PROXY_URL_FIELDS = ['url', 'httpProxy', 'httpsProxy', 'allProxy'] as const;
export type ProxyUrlField = (typeof PROXY_URL_FIELDS)[number];

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

/** Откуда взято эффективное значение (`runtime` — UI-override, `env` — `SYNTH_PROXY_*`). */
export type ProxyConfigOrigin = 'env' | 'runtime' | 'config';

/** Креды Basic-аутентификации прокси (в памяти; наружу не отдаются). */
export interface ProxyCredentials {
  username: string;
  password: string;
}

/** Креды по полям URL (userinfo URL либо `proxy.auth` + env/файл-пароль). */
export type ProxyCredentialSet = Partial<Record<ProxyUrlField, ProxyCredentials>>;

/** Эффективный TLS/mTLS к самому прокси (CA/серт/ключ уже прочитаны). */
export interface ResolvedProxyTls {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
}

/** Эффективный именованный профиль прокси (URL без userinfo, креды — отдельно). */
export interface ResolvedProxyProfile {
  name: string;
  label?: string;
  /** URL без userinfo (для логов/статуса/ProxyAgent `uri`). */
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  /** Креды Basic по URL-полям (только если заданы; наружу не отдаются). */
  credentials?: ProxyCredentialSet;
  /** Redacted-сведения об аутентификации (username, без пароля). */
  auth?: ProxyStatusAuth;
  /** TLS/mTLS к прокси (`ProxyAgent.proxyTls`); цель — `security.tls`. */
  tls?: ResolvedProxyTls;
  /** Метаданные TLS-файлов для статуса/UI (пути, флаг `caPem`; без содержимого). */
  tlsMeta?: ProxyStatusTlsMeta;
  /** Источник: `env`/`runtime` — legacy-default; профили — config/runtime. */
  source: ProxyConfigOrigin;
  /** `true` — синтетический legacy-профиль `default` (top-level URL/auth/tls). */
  legacy: boolean;
}

/** Действие правила маршрутизации прокси. */
export type ProxyRuleAction = 'proxy' | 'direct';

/** Правило маршрутизации прокси с нормализованными хостами. */
export interface ResolvedProxyRule {
  /** `id` из конфига либо сгенерированный `rule-<n>`. */
  id: string;
  label?: string;
  hosts: string[];
  action: ProxyRuleAction;
  /** Эффективный профиль (`rule.profile` либо `defaultProfile`). */
  profile?: string;
}

/** Эффективная конфигурация прокси (после слияния env/runtime/config/defaults). */
export interface ResolvedProxyConfig {
  enabled: boolean;
  /** Источник эффективного прокси-URL: `env` | `runtime` | `config`; `none` — прокси выключен. */
  source: 'env' | 'runtime' | 'config' | 'none';
  /** Режим маршрутизации (`all` — default для всех, `selected` — только правила). */
  mode: ProxyMode;
  /** Профиль по умолчанию (для `mode: all` и правил без `profile`). */
  defaultProfile?: string;
  /** Именованные профили (в legacy-режиме — синтетический `default`). */
  profiles: Record<string, ResolvedProxyProfile>;
  /** Правила маршрутизации (порядок = приоритет). */
  rules: ResolvedProxyRule[];
  /** URL без userinfo (legacy-поля; в режиме профилей не заполняются). */
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  /** Креды Basic по полям (только если заданы). */
  credentials?: ProxyCredentialSet;
  /** Redacted-сведения об аутентификации (username, без пароля). */
  auth?: ProxyStatusAuth;
  /** TLS/mTLS к прокси (`ProxyAgent.proxyTls`); цель — `security.tls`. */
  tls?: ResolvedProxyTls;
  /** Метаданные TLS-файлов для статуса/UI (пути, флаг `caPem`; без содержимого). */
  tlsMeta?: ProxyStatusTlsMeta;
  noProxy: string[];
  fromEnv: boolean;
  /** Явный opt-in: при недоступном прокси идти напрямую (warn + via:'fallback'). */
  fallbackDirect: boolean;
  connectTimeoutMs: number;
}

/** Причина решения `resolveProxyRoute` (для логов/UI). */
export type ProxyRouteReason =
  | 'disabled'
  | 'no-proxy'
  | 'rule'
  | 'default'
  | 'no-match'
  | 'no-default';

/** Решение маршрутизации для target-origin (единая точка для dispatcher/API-check). */
export interface ResolvedProxyRoute {
  action: ProxyRuleAction;
  reason: ProxyRouteReason;
  /** Сработавшее правило (только `reason: 'rule'`). */
  rule?: ResolvedProxyRule;
  /** Эффективный профиль (только `action: 'proxy'`). */
  profile?: string;
  /** URL прокси без userinfo. */
  proxyUrl?: string;
  /** Креды Basic выбранного URL (только в памяти). */
  credentials?: ProxyCredentials;
}

/** Безопасные сведения об аутентификации прокси для статуса/UI (без пароля). */
export interface ProxyStatusAuth {
  type: 'basic';
  username: string;
}

/** Метаданные TLS к прокси для статуса/UI (без PEM-содержимого). */
export interface ProxyStatusTlsMeta {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  /** `true` — CA задан через `caPem` (сам PEM наружу не отдаётся). */
  hasCaPem: boolean;
}

/** Redacted-сведения о профиле прокси для статуса/UI (без паролей/PEM/userinfo). */
export interface ProxyStatusProfile {
  name: string;
  label?: string;
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  /** Только username (пароль не отдаётся). */
  auth?: ProxyStatusAuth;
  /** Пути TLS-файлов и флаг `caPem`; PEM/ключи не отдаются. */
  tls?: ProxyStatusTlsMeta & { rejectUnauthorized: boolean };
  /** `true` — синтетический legacy-профиль `default`. */
  legacy: boolean;
  source: ProxyConfigOrigin;
}

/** Правило маршрутизации в статусе (без секретов). */
export interface ProxyStatusRule {
  id: string;
  label?: string;
  hosts: string[];
  action: ProxyRuleAction;
  profile?: string;
}

/** Read-only статус прокси для `GET /api/v2/settings/proxy` (без секретов). */
export interface EgressProxyStatus {
  enabled: boolean;
  source: 'env' | 'runtime' | 'config' | 'none';
  mode: ProxyMode;
  defaultProfile?: string;
  /** Профили (redacted: URL без userinfo, username, TLS-метаданные). */
  profiles: Record<string, ProxyStatusProfile>;
  /** Правила маршрутизации (порядок сохраняется). */
  rules: ProxyStatusRule[];
  url?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy: string[];
  fromEnv: boolean;
  fallbackDirect: boolean;
  connectTimeoutMs: number;
  /** Basic-аутентификация: только username (пароль не отдаётся). */
  auth?: ProxyStatusAuth;
  /** TLS к прокси: пути и флаг `caPem`; PEM/ключи не отдаются. */
  tls?: ProxyStatusTlsMeta & { rejectUnauthorized: boolean };
  /** Настройка применяется при старте процесса. */
  restartRequired: true;
}

/**
 * Источник пароля Basic-аутентификации прокси (значение **никогда** не отдаётся).
 * `env` — `SYNTH_PROXY_PASSWORD` (деплой, UI не может удалить); `file` —
 * `{dataDir}/secrets/proxy-password` (управляется через API); `none` — не задан.
 */
export interface ProxyPasswordStatus {
  source: 'env' | 'file' | 'none';
  set: boolean;
  /** `true` — пароль можно удалить через `DELETE /settings/proxy/password`. */
  removable: boolean;
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

/** Разобранный и нормализованный URL прокси (userinfo — отдельно). */
export interface ParsedProxyUrl {
  /** Нормализованный origin **без userinfo**: `http://host:port` / `socks5://…`. */
  href: string;
  /**
   * `socks5:` / `socks5h:` — один транспорт (SOCKS5). `socks5h` — стандартное
   * написание «DNS резолвит прокси»; `socks5` — совместимость с libcurl-стилем.
   * В текущей реализации undici (`Socks5ProxyAgent`) hostname цели уходит в
   * SOCKS-CONNECT для **обеих** схем, т.е. фактически резолвит прокси; отдельного
   * локального DNS-резолва клиентом нет.
   */
  protocol: 'http:' | 'https:' | 'socks5:' | 'socks5h:';
  hostname: string;
  port: number;
  username?: string;
  password?: string;
}

/** `true` — SOCKS5-прокси (D2b). */
export function isSocksProxyProtocol(protocol: string): boolean {
  return protocol === 'socks5:' || protocol === 'socks5h:';
}

/** Пустая (не заданная) конфигурация — прокси выключен (поведение не меняется). */
export function emptyResolvedProxyConfig(): ResolvedProxyConfig {
  return {
    enabled: false,
    source: 'none',
    mode: 'all',
    profiles: {},
    rules: [],
    noProxy: [],
    fromEnv: true,
    fallbackDirect: false,
    connectTimeoutMs: 10_000,
  };
}

/**
 * Разбирает URL прокси: `http`, `https`, `socks5`, `socks5h` (D2b).
 * Userinfo (`user:pass@host`) разрешён: креды извлекаются отдельно (для SOCKS5 —
 * RFC 1929 user/pass), `href` всегда без userinfo (безопасен для логов/статуса).
 * `password` без `username` — ошибка; отсутствие пароля при наличии username
 * решает резолвер (env/файл).
 *
 * `socks5h://` — hostname цели резолвит прокси; `socks5://` — клиент (поведение
 * зависит от клиента, undici передаёт hostname в SOCKS CONNECT).
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
  if (url.protocol === 'socks:') {
    throw new ProxyConfigError(
      'proxy: схема "socks:" не поддерживается — используйте socks5:// или socks5h://',
    );
  }
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'socks5:' &&
    url.protocol !== 'socks5h:'
  ) {
    throw new ProxyConfigError(
      `proxy: схема "${url.protocol.replace(/:$/, '')}" не поддерживается (только http/https/socks5/socks5h)`,
    );
  }
  if (!url.hostname) {
    throw new ProxyConfigError(`proxy: не удалось выделить хост из "${redactProxyUrl(value)}"`);
  }
  const protocol = url.protocol as ParsedProxyUrl['protocol'];
  const defaultPort = protocol === 'https:' ? 443 : isSocksProxyProtocol(protocol) ? 1080 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const decoded = decodeUserinfo(url, value);
  if (decoded.password !== undefined && decoded.username === undefined) {
    throw new ProxyConfigError('proxy: пароль в URL задан без имени пользователя');
  }
  const parsed: ParsedProxyUrl = {
    href: `${protocol}//${url.host}`,
    protocol,
    hostname: url.hostname,
    port,
  };
  if (decoded.username !== undefined) parsed.username = decoded.username;
  if (decoded.password !== undefined) parsed.password = decoded.password;
  return parsed;
}

/** Декодирует userinfo; битый percent-encoding → fail-closed без эха секрета. */
function decodeUserinfo(url: URL, raw: string): { username?: string; password?: string } {
  if (!url.username && !url.password) return {};
  try {
    return {
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
  } catch {
    throw new ProxyConfigError(`proxy: некорректный userinfo в URL "${redactProxyUrl(raw)}"`);
  }
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
    // `URL.origin` для не-special схем (socks5) равен "null" — собираем вручную.
    return `${url.protocol}//${url.host}`;
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
    // `*.suffix` — только поддомены; семантика шаблона общая с ADR-099-матчером.
    if (this._wildcards.some((suffix) => matchTlsHostPattern(`*.${suffix}`, host))) return true;
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

/** Валидное DNS-имя (метки `[a-z0-9_-]`, без пустых меток, длина ≤ 253). */
function isValidHostname(host: string): boolean {
  if (host === '' || host.length > 253) return false;
  return host
    .split('.')
    .every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label));
}

/**
 * Валидирует host-паттерны правил прокси (`proxy.rules[].hosts`).
 * Возвращает нормализованные значения (trim/lower-case/без завершающей точки).
 *
 * Допустимо: exact (`api.example.com`), `.suffix` (apex+sub), `*.suffix` (sub),
 * `host:port`, IPv4/IPv6-литерал (в т.ч. `[::1]:8080`), CIDR (только по IP-литералу
 * цели — DNS не выполняется), `*`.
 *
 * **Fail-closed**: невалидный паттерн — `ProxyConfigError` (а не тихий игнор),
 * иначе опечатка в правиле молча меняет маршрут (прокси ↔ direct).
 */
export function validateProxyHostPatterns(
  entries: readonly string[],
  context = 'proxy.rules',
): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProxyConfigError(`${context}.hosts: нужен хотя бы один паттерн`);
  }
  return entries.map((raw, index) => {
    const where = `${context}.hosts[${index}]`;
    if (typeof raw !== 'string') {
      throw new ProxyConfigError(`${where}: паттерн должен быть строкой`);
    }
    // Завершающая точка нормализуется, но `*.` — невалидный wildcard, а не `*`.
    const rawValue = raw.trim().toLowerCase();
    const value =
      rawValue !== '*' && !rawValue.endsWith('*.') ? rawValue.replace(/\.$/, '') : rawValue;
    if (value === '') {
      throw new ProxyConfigError(`${where}: пустой паттерн`);
    }
    if (/\s/.test(value)) {
      throw new ProxyConfigError(`${where}: пробелы в паттерне "${raw}" недопустимы`);
    }
    if (value === '*') return value;

    if (value.includes('/')) {
      const slash = value.lastIndexOf('/');
      const net = value.slice(0, slash);
      const prefixRaw = value.slice(slash + 1);
      const family = isIP(net);
      if (family === 0) {
        throw new ProxyConfigError(
          `${where}: CIDR "${raw}" — сеть должна быть IP-литералом (DNS/CIDR по имени не поддерживается)`,
        );
      }
      if (!/^\d{1,3}$/.test(prefixRaw)) {
        throw new ProxyConfigError(`${where}: CIDR "${raw}" — невалидная длина префикса`);
      }
      const prefix = Number(prefixRaw);
      const max = family === 4 ? 32 : 128;
      if (prefix > max) {
        throw new ProxyConfigError(
          `${where}: CIDR "${raw}" — префикс должен быть 0..${max} для IPv${family}`,
        );
      }
      return value;
    }

    if (value.includes('*')) {
      if (!value.startsWith('*.') || value.slice(2) === '') {
        throw new ProxyConfigError(
          `${where}: невалидный wildcard "${raw}" (допустимо только "*.suffix")`,
        );
      }
      const suffix = value.slice(2);
      if (suffix.includes('*') || isIP(suffix) !== 0 || !isValidHostname(suffix)) {
        throw new ProxyConfigError(`${where}: невалидный wildcard-суффикс "${raw}"`);
      }
      return value;
    }

    // IPv6 в скобках: `[::1]` либо `[::1]:8080`.
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
    if (bracket) {
      const host = bracket[1]!;
      if (isIP(host) !== 6) {
        throw new ProxyConfigError(`${where}: "${raw}" — в скобках ожидается IPv6-литерал`);
      }
      if (bracket[2] !== undefined) assertPort(bracket[2], where, raw);
      return value;
    }

    if (isIP(value) !== 0) return value;

    if (value.startsWith('.')) {
      const suffix = value.slice(1);
      if (suffix === '' || isIP(suffix) !== 0 || !isValidHostname(suffix)) {
        throw new ProxyConfigError(`${where}: невалидный суффикс "${raw}"`);
      }
      return value;
    }

    // `host:port` (IPv6-литералы уже обработаны выше — там двоеточий больше).
    const colon = value.lastIndexOf(':');
    if (colon > 0 && !value.slice(0, colon).includes(':')) {
      const host = value.slice(0, colon);
      const port = value.slice(colon + 1);
      if (!/^\d+$/.test(port)) {
        throw new ProxyConfigError(`${where}: невалидный порт в "${raw}"`);
      }
      assertPort(port, where, raw);
      if (!isValidHostname(host)) {
        throw new ProxyConfigError(`${where}: невалидный хост в "${raw}"`);
      }
      return value;
    }

    if (!isValidHostname(value)) {
      throw new ProxyConfigError(`${where}: невалидный паттерн "${raw}"`);
    }
    return value;
  });
}

/** Проверка диапазона порта паттерна (1..65535). */
function assertPort(rawPort: string, where: string, rawPattern: string): void {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxyConfigError(`${where}: порт в "${rawPattern}" должен быть 1..65535`);
  }
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
  username?: string;
  password?: string;
}

/** Env-имя пароля профиля: `default` — legacy `SYNTH_PROXY_PASSWORD`. */
export function proxyProfilePasswordEnv(name: string): string {
  if (name === 'default') return PROXY_PASSWORD_ENV;
  return `SYNTH_PROXY_${name.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
}

/**
 * Путь файла пароля профиля: `default` — legacy `{dataDir}/secrets/proxy-password`,
 * прочие — `{dataDir}/secrets/proxy/<profile>.password`.
 */
export function proxyProfilePasswordPath(dataDir: string, name: string): string {
  if (name === 'default') return join(dataDir, 'secrets', 'proxy-password');
  return join(dataDir, 'secrets', 'proxy', `${name}.password`);
}

/** Читает пароль из env/файла профиля (лениво: только если реально нужен). */
function makeProfilePasswordResolver(
  env: NodeJS.ProcessEnv,
  dataDir: string | undefined,
  name: string,
): () => string | undefined {
  let cached: string | undefined | null = null;
  return () => {
    if (cached !== null) return cached;
    const fromEnv = envValue(env, proxyProfilePasswordEnv(name));
    if (fromEnv !== undefined) {
      cached = fromEnv;
      return cached;
    }
    cached = dataDir ? readProxyPasswordFile(proxyProfilePasswordPath(dataDir, name)) : undefined;
    return cached;
  };
}

/** Читает файл пароля по точному пути; ENOENT → `undefined` (пароля нет). */
export function readProxyPasswordFile(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyConfigError(`proxy: не удалось прочитать пароль из "${path}": ${reason}`);
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** PEM-маркер блока. */
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----/;

/** Читает PEM-файл прокси-TLS; нет/не читается/не PEM → fail-closed. */
function readProxyPemFile(
  path: string,
  field: string,
  marker: RegExp,
  scope = 'proxy.tls',
): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyConfigError(
      `[config] ${scope}.${field}: не удалось прочитать файл "${path}": ${reason}`,
    );
  }
  if (!marker.test(content)) {
    throw new ProxyConfigError(
      `[config] ${scope}.${field}: файл "${path}" не содержит PEM ` +
        `(ожидается блок "-----BEGIN ${field === 'keyFile' ? 'PRIVATE KEY' : 'CERTIFICATE'}-----")`,
    );
  }
  return content;
}

/**
 * TLS профиля прокси: **только** config/UI (без env `SYNTH_PROXY_TLS_*`).
 * Правила те же, что у `proxy.tls`: `caFile`↔`caPem`, `certFile`+`keyFile` парой,
 * нечитаемый/не-PEM файл — fail-closed.
 */
function resolveProfileTls(
  tls: Partial<ProxyTlsConfig> | undefined,
  name: string,
): { resolved: ResolvedProxyTls; meta: ProxyStatusTlsMeta; configured: boolean } {
  const cfg = (tls ?? {}) as Partial<ProxyTlsConfig>;
  const scope = `proxy.profiles.${name}.tls`;
  const nonEmpty = (value: string | undefined): string | undefined =>
    value !== undefined && value !== '' ? value : undefined;
  const caFile = nonEmpty(cfg.caFile);
  const caPem = nonEmpty(cfg.caPem);
  if (caFile !== undefined && caPem !== undefined) {
    throw new ProxyConfigError(
      `[config] ${scope}: 'caFile' и 'caPem' взаимоисключащи — задайте ровно один источник CA`,
    );
  }
  const certFile = nonEmpty(cfg.certFile);
  const keyFile = nonEmpty(cfg.keyFile);
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new ProxyConfigError(
      `[config] ${scope}: mTLS к прокси требует и certFile, и keyFile (задайте оба либо ни одного)`,
    );
  }
  const configured =
    caFile !== undefined ||
    caPem !== undefined ||
    certFile !== undefined ||
    keyFile !== undefined ||
    cfg.rejectUnauthorized === false;

  const resolved: ResolvedProxyTls = { rejectUnauthorized: cfg.rejectUnauthorized ?? true };
  if (caFile !== undefined) {
    resolved.ca = readProxyPemFile(caFile, 'caFile', /-----BEGIN CERTIFICATE-----/, scope);
  } else if (caPem !== undefined) {
    if (!PEM_BLOCK_RE.test(caPem)) {
      throw new ProxyConfigError(
        `[config] ${scope}.caPem: значение не содержит PEM-сертификат ` +
          '(ожидается блок "-----BEGIN CERTIFICATE-----")',
      );
    }
    resolved.ca = caPem;
  }
  if (certFile !== undefined && keyFile !== undefined) {
    resolved.cert = readProxyPemFile(certFile, 'certFile', /-----BEGIN CERTIFICATE-----/, scope);
    resolved.key = readProxyPemFile(
      keyFile,
      'keyFile',
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
      scope,
    );
  }

  const meta: ProxyStatusTlsMeta = { hasCaPem: caPem !== undefined };
  if (caFile !== undefined) meta.caFile = caFile;
  if (certFile !== undefined) meta.certFile = certFile;
  if (keyFile !== undefined) meta.keyFile = keyFile;
  return { resolved, meta, configured };
}

/**
 * Эффективный TLS/mTLS к **самому прокси** (`proxy.tls`, ADR-023).
 * Схема — как `security.tls`: env `SYNTH_PROXY_TLS_*` > config.yaml > defaults;
 * `caFile` ↔ `caPem` взаимоисключающие; `certFile`/`keyFile` — только вместе;
 * нечитаемый/не-PEM файл → fail-closed.
 */
export function resolveProxyTls(
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyTls {
  const cfg = (config?.proxy?.tls ?? {}) as Partial<ProxyTlsConfig>;
  const pick = (envKey: string, cfgValue: string | undefined): string | undefined => {
    const envValueRaw = envValue(env, envKey);
    if (envValueRaw !== undefined) return envValueRaw;
    return cfgValue !== undefined && cfgValue !== '' ? cfgValue : undefined;
  };
  const caFile = pick(PROXY_TLS_ENV.caFile, cfg.caFile);
  const caPem = pick(PROXY_TLS_ENV.caPem, cfg.caPem);
  if (caFile !== undefined && caPem !== undefined) {
    throw new ProxyConfigError(
      `[config] proxy.tls: 'caFile' и 'caPem' взаимоисключащи — задайте ровно один ` +
        `источник CA (${PROXY_TLS_ENV.caFile} ИЛИ ${PROXY_TLS_ENV.caPem})`,
    );
  }
  const certFile = pick(PROXY_TLS_ENV.certFile, cfg.certFile);
  const keyFile = pick(PROXY_TLS_ENV.keyFile, cfg.keyFile);
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new ProxyConfigError(
      '[config] proxy.tls: mTLS к прокси требует и certFile, и keyFile (задайте оба либо ни одного)',
    );
  }
  const rejectUnauthorized =
    envBoolean(envValue(env, PROXY_TLS_ENV.rejectUnauthorized), PROXY_TLS_ENV.rejectUnauthorized) ??
    cfg.rejectUnauthorized ??
    true;

  const result: ResolvedProxyTls = { rejectUnauthorized };
  if (caFile !== undefined) {
    const content = readProxyPemFile(caFile, 'caFile', /-----BEGIN CERTIFICATE-----/);
    result.ca = content;
  } else if (caPem !== undefined) {
    if (!PEM_BLOCK_RE.test(caPem)) {
      throw new ProxyConfigError(
        '[config] proxy.tls.caPem: значение не содержит PEM-сертификат ' +
          '(ожидается блок "-----BEGIN CERTIFICATE-----")',
      );
    }
    result.ca = caPem;
  }
  if (certFile !== undefined && keyFile !== undefined) {
    result.cert = readProxyPemFile(certFile, 'certFile', /-----BEGIN CERTIFICATE-----/);
    result.key = readProxyPemFile(keyFile, 'keyFile', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  }
  return result;
}

/** Протокол URL без исключения (для проверок конфигурации). */
function safeProtocol(raw: string): string {
  try {
    return new URL(raw).protocol;
  } catch {
    return '';
  }
}

/** Явно ли сконфигурирован TLS к прокси (config или env) — для проверки socks5. */
function isProxyTlsConfigured(cfg: Partial<ProxyConfig>, env: NodeJS.ProcessEnv): boolean {
  const fromCfg = Object.values(cfg.tls ?? {}).some((value) => value !== undefined && value !== '');
  if (fromCfg) return true;
  return Object.values(PROXY_TLS_ENV).some((key) => envValue(env, key) !== undefined);
}

/**
 * Метаданные TLS к прокси для статуса/UI: пути файлов и флаг `caPem`.
 * Приоритет env `SYNTH_PROXY_TLS_*` > эффективный config/runtime. Содержимое
 * PEM/ключа **не** возвращается.
 */
export function resolveProxyTlsMeta(
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProxyStatusTlsMeta {
  const cfg = (config?.proxy?.tls ?? {}) as Partial<ProxyTlsConfig>;
  const pick = (envKey: string, cfgValue: string | undefined): string | undefined => {
    const fromEnv = envValue(env, envKey);
    if (fromEnv !== undefined) return fromEnv;
    return cfgValue !== undefined && cfgValue !== '' ? cfgValue : undefined;
  };
  const caFile = pick(PROXY_TLS_ENV.caFile, cfg.caFile);
  const caPem = pick(PROXY_TLS_ENV.caPem, cfg.caPem);
  const certFile = pick(PROXY_TLS_ENV.certFile, cfg.certFile);
  const keyFile = pick(PROXY_TLS_ENV.keyFile, cfg.keyFile);
  const meta: ProxyStatusTlsMeta = { hasCaPem: caPem !== undefined };
  if (caFile !== undefined) meta.caFile = caFile;
  if (certFile !== undefined) meta.certFile = certFile;
  if (keyFile !== undefined) meta.keyFile = keyFile;
  return meta;
}

/** Публичная redacted-форма TLS-метаданных (никогда не содержит PEM/ключей). */
function redactedTlsMeta(meta: ProxyStatusTlsMeta | undefined): ProxyStatusTlsMeta | undefined {
  if (!meta) return undefined;
  const result: ProxyStatusTlsMeta = { hasCaPem: meta.hasCaPem === true };
  if (meta.caFile !== undefined) result.caFile = meta.caFile;
  if (meta.certFile !== undefined) result.certFile = meta.certFile;
  if (meta.keyFile !== undefined) result.keyFile = meta.keyFile;
  return result;
}

/** Опции резолвера `proxy`: каталог данных и runtime-override из UI/`settings.json`. */
export interface ResolveProxyConfigOptions {
  /** Каталог данных — файл `{dataDir}/secrets/proxy-password` (инвариант 13). */
  dataDir?: string;
  /**
   * Runtime-override (`RuntimeSettings.proxy`, `{dataDir}/settings.json`/PG).
   * Приоритет: `config.yaml` ← runtime ← явные `SYNTH_PROXY_*` (ADR-023).
   */
  runtime?: Partial<ProxyConfig> | undefined;
}

/**
 * Поле-уровневое слияние `config.yaml proxy` и runtime-override (UI).
 * Runtime приоритетнее; пустая строка трактуется как «не задано» (как в config).
 * Вложенные `auth`/`tls` мёржатся по полям.
 *
 * Источник конфигурации всегда один (иначе `resolveProxyConfig` бросает «два
 * источника»): `profiles` и legacy top-level (`url`/`httpProxy`/`httpsProxy`/
 * `allProxy`/`auth`/`tls`) не смешиваются между base и runtime.
 * - runtime с **непустыми** `profiles` — режим профилей: `profiles` из runtime,
 *   legacy top-level base игнорируется (свои top-level runtime-объекта остаются —
 *   их отклонит валидация);
 * - runtime без `profiles`, но с legacy top-level — переключение на legacy:
 *   `profiles` base не берутся, `rules`/`defaultProfile`/`mode` base тоже (они
 *   относятся к исчезнувшей профильной конфигурации: правила и `defaultProfile`
 *   ссылаются на профили, а `mode: selected` остаётся без правил); свои значения
 *   runtime сохраняются;
 * - runtime только с `rules`/`mode`/`defaultProfile` — `profiles` base сохраняются.
 */
export function mergeProxyConfig(
  base: Partial<ProxyConfig> | undefined,
  runtime: Partial<ProxyConfig> | undefined,
): Partial<ProxyConfig> {
  const b = (base ?? {}) as Partial<ProxyConfig>;
  const r = (runtime ?? {}) as Partial<ProxyConfig>;
  // Режим профилей/legacy определяется по runtime: base при смене режима не подмешивается.
  const runtimeProfileMode = hasNonEmptyProfiles(r);
  const runtimeLegacyMode = hasLegacyTopLevel(r);
  // Переключение с профилей на legacy (runtime без profiles, но с top-level URL/auth/tls):
  // структурная конфигурация base (`profiles`/`rules`/`defaultProfile`/`mode`) не
  // переносится — иначе остаются ссылки на исчезнувшие профили или `mode: selected`
  // без правил. Свои значения runtime сохраняются.
  const switchToLegacy = runtimeLegacyMode && hasNonEmptyProfiles(b);
  const pickString = (key: 'url' | 'httpProxy' | 'httpsProxy' | 'allProxy'): string | undefined => {
    const value = r[key];
    if (value !== undefined && value !== '') return value;
    if (runtimeProfileMode) return undefined;
    const fallback = b[key];
    return fallback !== undefined && fallback !== '' ? fallback : undefined;
  };
  const merged: Partial<ProxyConfig> = {};
  if (r.enabled !== undefined) merged.enabled = r.enabled;
  else if (b.enabled !== undefined) merged.enabled = b.enabled;
  if (r.mode !== undefined) merged.mode = r.mode;
  else if (!switchToLegacy && b.mode !== undefined) merged.mode = b.mode;
  const runtimeDefault = r.defaultProfile !== undefined && r.defaultProfile !== '' ? r.defaultProfile : undefined;
  const configDefault =
    !switchToLegacy && b.defaultProfile !== undefined && b.defaultProfile !== ''
      ? b.defaultProfile
      : undefined;
  const defaultProfile = runtimeDefault ?? configDefault;
  if (defaultProfile !== undefined) merged.defaultProfile = defaultProfile;
  // `profiles`/`rules` — не поле-уровневое слияние: runtime заменяет config целиком.
  const profiles = runtimeProfileMode
    ? r.profiles
    : switchToLegacy
      ? undefined
      : r.profiles !== undefined
        ? r.profiles
        : b.profiles;
  if (profiles !== undefined) merged.profiles = profiles;
  const rules = r.rules !== undefined ? r.rules : switchToLegacy ? undefined : b.rules;
  if (rules !== undefined) merged.rules = rules;
  const url = pickString('url');
  if (url !== undefined) merged.url = url;
  const httpProxy = pickString('httpProxy');
  if (httpProxy !== undefined) merged.httpProxy = httpProxy;
  const httpsProxy = pickString('httpsProxy');
  if (httpsProxy !== undefined) merged.httpsProxy = httpsProxy;
  const allProxy = pickString('allProxy');
  if (allProxy !== undefined) merged.allProxy = allProxy;
  const auth = runtimeProfileMode ? r.auth : (r.auth ?? b.auth);
  if (auth !== undefined) merged.auth = auth;
  if (runtimeProfileMode) {
    if (r.tls !== undefined) merged.tls = r.tls;
  } else if (r.tls !== undefined || b.tls !== undefined) {
    merged.tls = { ...(b.tls ?? {}), ...(r.tls ?? {}) };
  }
  if (r.noProxy !== undefined) merged.noProxy = r.noProxy;
  else if (b.noProxy !== undefined) merged.noProxy = b.noProxy;
  if (r.fromEnv !== undefined) merged.fromEnv = r.fromEnv;
  else if (b.fromEnv !== undefined) merged.fromEnv = b.fromEnv;
  if (r.fallbackDirect !== undefined) merged.fallbackDirect = r.fallbackDirect;
  else if (b.fallbackDirect !== undefined) merged.fallbackDirect = b.fallbackDirect;
  if (r.connectTimeoutMs !== undefined) merged.connectTimeoutMs = r.connectTimeoutMs;
  else if (b.connectTimeoutMs !== undefined) merged.connectTimeoutMs = b.connectTimeoutMs;
  return merged;
}

/** `true` — `profiles` заданы и непусты (режим профилей). */
function hasNonEmptyProfiles(cfg: Partial<ProxyConfig> | undefined): boolean {
  const profiles = cfg?.profiles;
  return profiles !== undefined && Object.keys(profiles).length > 0;
}

/** `true` — задан хотя бы один непустой legacy top-level (`url`/`auth`/`tls`). */
function hasLegacyTopLevel(cfg: Partial<ProxyConfig> | undefined): boolean {
  if (cfg === undefined) return false;
  if (
    PROXY_URL_FIELDS.some((field) => {
      const value = cfg[field];
      return typeof value === 'string' && value !== '';
    })
  ) {
    return true;
  }
  if (cfg.auth !== undefined) return true;
  return (
    cfg.tls !== undefined &&
    Object.values(cfg.tls).some((value) => value !== undefined && value !== '')
  );
}

/**
 * Сливает env, runtime и config.yaml для секции `proxy` (ADR-023).
 *
 * Приоритет: явные `SYNTH_PROXY_*` > runtime (`settings.json`, UI) > `config.proxy`
 * > стандартные env (при `fromEnv`) > defaults. Стандартные `HTTP_PROXY`/… не
 * применяются, если runtime/config явно задали `enabled: false`.
 *
 * `options.dataDir` нужен только для файла пароля
 * `{dataDir}/secrets/proxy-password` (инвариант 13).
 */
export function resolveProxyConfig(
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveProxyConfigOptions = {},
): ResolvedProxyConfig {
  const cfg = mergeProxyConfig(config?.proxy, options.runtime);
  const fromEnv = cfg.fromEnv ?? true;
  const empty = emptyResolvedProxyConfig();
  const explicitEnv = envBoolean(envValue(env, PROXY_ENV.enabled), PROXY_ENV.enabled);
  const explicit = explicitEnv ?? cfg.enabled;

  const mode: ProxyMode = cfg.mode ?? 'all';
  if (mode !== 'all' && mode !== 'selected') {
    throw new ProxyConfigError(`proxy.mode "${String(mode)}" не поддерживается (all|selected)`);
  }
  const rawProfiles = cfg.profiles;
  const hasProfiles = rawProfiles !== undefined && Object.keys(rawProfiles).length > 0;
  const rawRules: ProxyRuleConfig[] = Array.isArray(cfg.rules) ? cfg.rules : [];
  const structured = hasProfiles || rawRules.length > 0;
  const runtimeProfiles = (options.runtime as Partial<ProxyConfig> | undefined)?.profiles;

  // Профили и legacy top-level URL/auth/tls — два источника конфигурации: запрещено.
  if (hasProfiles) {
    const topLevelUrl = PROXY_URL_FIELDS.map((field) => cfg[field]).find(
      (value) => value !== undefined && value !== '',
    );
    if (topLevelUrl !== undefined) {
      throw new ProxyConfigError(
        'proxy: при заданных proxy.profiles top-level url/httpProxy/httpsProxy/allProxy запрещены ' +
          '(перенесите URL в профиль — иначе два источника конфигурации)',
      );
    }
    const envUrl = [PROXY_ENV.url, PROXY_ENV.httpProxy, PROXY_ENV.httpsProxy, PROXY_ENV.allProxy]
      .map((key) => envValue(env, key))
      .find((value) => value !== undefined);
    if (envUrl !== undefined) {
      throw new ProxyConfigError(
        'proxy: при заданных proxy.profiles env SYNTH_PROXY_URL/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY ' +
          'запрещены (URL задаётся только в профилях)',
      );
    }
    if (hasLegacyAuth(cfg.auth)) {
      throw new ProxyConfigError(
        'proxy: при заданных proxy.profiles top-level proxy.auth запрещён — auth задаётся в профиле',
      );
    }
    if (hasConfiguredTls(cfg.tls)) {
      throw new ProxyConfigError(
        'proxy: при заданных proxy.profiles top-level proxy.tls запрещён — tls задаётся в профиле ' +
          '(env SYNTH_PROXY_TLS_* для профилей не применяется)',
      );
    }
  }

  // Стандартные env — только для legacy-default; профили/правила из env не читаются.
  const allowStandardEnv = fromEnv && explicit !== false && !hasProfiles;

  const runtimeCfg = (options.runtime ?? {}) as Partial<ProxyConfig>;
  const originOf = (field: ProxyUrlField): ProxyConfigOrigin =>
    runtimeCfg[field] !== undefined && runtimeCfg[field] !== '' ? 'runtime' : 'config';

  const pick = (envKey: string, field: ProxyUrlField, standard: readonly string[]): PickedUrl => {
    const take = (raw: string, origin: ProxyConfigOrigin): PickedUrl => {
      const parsed = parseProxyUrl(raw);
      const picked: PickedUrl = { value: parsed.href, origin };
      if (parsed.username !== undefined) picked.username = parsed.username;
      if (parsed.password !== undefined) picked.password = parsed.password;
      return picked;
    };
    const synth = envValue(env, envKey);
    if (synth !== undefined) return take(synth, 'env');
    const cfgValue = cfg[field];
    if (cfgValue !== undefined && cfgValue !== '') return take(cfgValue, originOf(field));
    if (allowStandardEnv) {
      for (const key of standard) {
        const raw = envValue(env, key);
        if (raw !== undefined) return take(raw, 'env');
      }
    }
    return {};
  };

  const url = pick(PROXY_ENV.url, 'url', []);
  const httpProxy = pick(PROXY_ENV.httpProxy, 'httpProxy', STANDARD_PROXY_ENV.httpProxy);
  const httpsProxy = pick(PROXY_ENV.httpsProxy, 'httpsProxy', STANDARD_PROXY_ENV.httpsProxy);
  const allProxy = pick(PROXY_ENV.allProxy, 'allProxy', STANDARD_PROXY_ENV.allProxy);

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

  const fields: Array<[ProxyUrlField, PickedUrl]> = [
    ['url', url],
    ['httpProxy', httpProxy],
    ['httpsProxy', httpsProxy],
    ['allProxy', allProxy],
  ];
  const picked = fields.map(([, value]) => value);
  const legacyUrls = picked
    .map((p) => p.value)
    .filter((value): value is string => value !== undefined);
  const hasLegacyUrl = legacyUrls.length > 0;

  // D2b: SOCKS5 — только TCP-туннель; TLS к прокси (`proxy.tls`) неприменим.
  const anySocks = legacyUrls.some((value) => isSocksProxyProtocol(safeProtocol(value)));
  if (!hasProfiles && anySocks && isProxyTlsConfigured(cfg, env)) {
    throw new ProxyConfigError(
      'proxy.tls несовместим с socks5:// (TLS применяется только к http(s)-прокси); ' +
        'уберите proxy.tls или используйте http(s)-прокси',
    );
  }

  const hasProfileUrl =
    hasProfiles &&
    Object.values(rawProfiles!).some((profile) =>
      PROXY_URL_FIELDS.some((field) => {
        const value = profile?.[field];
        return typeof value === 'string' && value !== '';
      }),
    );
  const hasAnyUrl = hasProfiles ? hasProfileUrl : hasLegacyUrl;
  const enabled = explicit ?? (hasAnyUrl || rawRules.length > 0);

  if (enabled && !hasAnyUrl && !structured) {
    // Legacy-поведение (без profiles/rules): fail-closed без URL.
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

  const origins = picked
    .map((p) => p.origin)
    .filter((origin): origin is ProxyConfigOrigin => origin !== undefined);

  const profiles: Record<string, ResolvedProxyProfile> = hasProfiles
    ? resolveNamedProfiles(rawProfiles!, {
        env,
        dataDir: options.dataDir,
        enabled,
        runtimeProfiles,
      })
    : {};

  // Legacy synthetic default: top-level URL/auth/tls (+ env/стандартные env).
  // В режиме профилей top-level TLS/env к профилям не применяются.
  const legacyTls = resolveProxyTls({ proxy: hasProfiles ? {} : cfg }, hasProfiles ? {} : env);
  const legacyTlsMeta = resolveProxyTlsMeta({ proxy: hasProfiles ? {} : cfg }, hasProfiles ? {} : env);
  const auth = hasProfiles ? undefined : validateProxyAuth(cfg.auth);
  const credentials: ProxyCredentialSet = {};
  if (!hasProfiles && enabled) {
    const password = makeProfilePasswordResolver(env, options.dataDir, 'default');
    for (const [field, value] of fields) {
      if (value.value === undefined) continue;
      const username = value.username ?? auth?.username;
      if (username === undefined || username === '') continue;
      const pwd = value.password ?? password();
      if (pwd === undefined) {
        throw new ProxyConfigError(
          `proxy: для пользователя "${username}" не задан пароль — укажите ${PROXY_PASSWORD_ENV} ` +
            'или файл {dataDir}/secrets/proxy-password (в config.yaml пароль не хранится)',
        );
      }
      credentials[field] = { username, password: pwd };
    }
  }
  const firstCredentials = Object.values(credentials).find((value) => value !== undefined);
  const authUsername =
    firstCredentials?.username ??
    auth?.username ??
    picked.map((p) => p.username).find((value) => value !== undefined);

  if (!hasProfiles && hasLegacyUrl) {
    const profile: ResolvedProxyProfile = {
      name: 'default',
      source: origins.includes('env')
        ? 'env'
        : origins.includes('runtime')
          ? 'runtime'
          : 'config',
      legacy: true,
      tls: legacyTls,
    };
    if (url.value !== undefined) profile.url = url.value;
    if (httpProxy.value !== undefined) profile.httpProxy = httpProxy.value;
    if (httpsProxy.value !== undefined) profile.httpsProxy = httpsProxy.value;
    if (allProxy.value !== undefined) profile.allProxy = allProxy.value;
    if (Object.keys(credentials).length > 0) profile.credentials = credentials;
    if (authUsername !== undefined && authUsername !== '') {
      profile.auth = { type: 'basic', username: authUsername };
    }
    if (
      legacyTlsMeta.caFile !== undefined ||
      legacyTlsMeta.certFile !== undefined ||
      legacyTlsMeta.keyFile !== undefined ||
      legacyTlsMeta.hasCaPem ||
      legacyTls.rejectUnauthorized === false
    ) {
      profile.tlsMeta = legacyTlsMeta;
    }
    profiles.default = profile;
  }

  const hasLegacyTlsMeta =
    legacyTlsMeta.caFile !== undefined ||
    legacyTlsMeta.certFile !== undefined ||
    legacyTlsMeta.keyFile !== undefined ||
    legacyTlsMeta.hasCaPem ||
    legacyTls.rejectUnauthorized === false;

  let defaultProfile: string | undefined;
  if (cfg.defaultProfile !== undefined) {
    if (profiles[cfg.defaultProfile] === undefined) {
      throw new ProxyConfigError(
        `proxy.defaultProfile: профиль "${cfg.defaultProfile}" не найден ` +
          `(есть: ${Object.keys(profiles).join(', ') || '—'})`,
      );
    }
    defaultProfile = cfg.defaultProfile;
  } else if (profiles.default !== undefined) {
    defaultProfile = 'default';
  } else if (mode === 'all' && structured) {
    throw new ProxyConfigError(
      'proxy.defaultProfile: mode=all требует default-профиль (задайте profiles.default ' +
        'или proxy.defaultProfile)',
    );
  }

  if (mode === 'selected' && rawRules.length === 0) {
    throw new ProxyConfigError(
      'proxy.rules: mode=selected требует хотя бы одно правило (иначе весь трафик — direct)',
    );
  }

  const rules = resolveProxyRules(rawRules, profiles, defaultProfile);

  const source: ResolvedProxyConfig['source'] = !enabled
    ? 'none'
    : hasProfiles
      ? runtimeProfiles !== undefined
        ? 'runtime'
        : 'config'
      : origins.includes('env')
        ? 'env'
        : origins.includes('runtime')
          ? 'runtime'
          : origins.includes('config')
            ? 'config'
            : 'none';

  const resolved: ResolvedProxyConfig = {
    enabled,
    source,
    mode,
    profiles,
    rules,
    noProxy,
    fromEnv,
    fallbackDirect,
    connectTimeoutMs,
  };
  // TLS/mTLS к прокси: legacy-поле — только без профилей (профили несут свой tls).
  if (!hasProfiles) resolved.tls = legacyTls;
  if (defaultProfile !== undefined) resolved.defaultProfile = defaultProfile;
  if (authUsername !== undefined && authUsername !== '') {
    resolved.auth = { type: 'basic', username: authUsername };
  }
  if (hasLegacyTlsMeta) resolved.tlsMeta = legacyTlsMeta;
  // Legacy-поля заполняются только без `profiles` (в режиме профилей источник — profiles).
  if (!hasProfiles) {
    if (url.value !== undefined) resolved.url = url.value;
    if (httpProxy.value !== undefined) resolved.httpProxy = httpProxy.value;
    if (httpsProxy.value !== undefined) resolved.httpsProxy = httpsProxy.value;
    if (allProxy.value !== undefined) resolved.allProxy = allProxy.value;
    if (Object.keys(credentials).length > 0) resolved.credentials = credentials;
  }
  return resolved;
}

/** `true` — top-level `proxy.auth` задан (в режиме профилей запрещён). */
function hasLegacyAuth(auth: ProxyAuthConfig | undefined): boolean {
  return auth !== undefined;
}

/** `true` — top-level `proxy.tls` задан (в режиме профилей запрещён). */
function hasConfiguredTls(tls: Partial<ProxyTlsConfig> | undefined): boolean {
  return tls !== undefined;
}

/** Резолвит именованные профили (валидация URL/auth/паролей/TLS). */
function resolveNamedProfiles(
  raw: Record<string, ProxyProfileConfig>,
  ctx: {
    env: NodeJS.ProcessEnv;
    dataDir: string | undefined;
    enabled: boolean;
    runtimeProfiles: Record<string, ProxyProfileConfig> | undefined;
  },
): Record<string, ResolvedProxyProfile> {
  const result: Record<string, ResolvedProxyProfile> = {};
  for (const [name, rawProfile] of Object.entries(raw)) {
    if (!PROXY_PROFILE_NAME_RE.test(name)) {
      throw new ProxyConfigError(
        `proxy.profiles: имя "${name}" невалидно (ожидается ^[a-z][a-z0-9_-]{0,31}$)`,
      );
    }
    const scope = `proxy.profiles.${name}`;
    const profile = rawProfile ?? {};
    const values = new Map<ProxyUrlField, ParsedProxyUrl>();
    for (const field of PROXY_URL_FIELDS) {
      const rawUrl = profile[field];
      if (rawUrl === undefined || rawUrl === '') continue;
      values.set(field, parseProxyUrl(rawUrl));
    }
    if (values.size === 0) {
      throw new ProxyConfigError(
        `${scope}: не задан URL — укажите url или httpProxy/httpsProxy/allProxy`,
      );
    }
    const auth = validateProxyAuth(profile.auth, `${scope}.auth`);
    const anySocks = [...values.values()].some((parsed) => isSocksProxyProtocol(parsed.protocol));
    const tlsInfo = resolveProfileTls(profile.tls, name);
    if (anySocks && tlsInfo.configured) {
      throw new ProxyConfigError(
        `${scope}: tls несовместим с socks5:// (TLS применяется только к http(s)-прокси)`,
      );
    }

    const credentials: ProxyCredentialSet = {};
    if (ctx.enabled) {
      const password = makeProfilePasswordResolver(ctx.env, ctx.dataDir, name);
      for (const [field, parsed] of values) {
        const username = parsed.username ?? auth?.username;
        if (username === undefined || username === '') continue;
        const pwd = parsed.password ?? password();
        if (pwd === undefined) {
          throw new ProxyConfigError(
            `${scope}: для пользователя "${username}" не задан пароль — укажите ` +
              `${proxyProfilePasswordEnv(name)} или файл ` +
              `{dataDir}/secrets/proxy/${name}.password (в config.yaml пароль не хранится)`,
          );
        }
        credentials[field] = { username, password: pwd };
      }
    }

    const resolved: ResolvedProxyProfile = {
      name,
      source:
        ctx.runtimeProfiles !== undefined && ctx.runtimeProfiles[name] !== undefined
          ? 'runtime'
          : 'config',
      legacy: false,
    };
    if (profile.label !== undefined && profile.label !== '') resolved.label = profile.label;
    if (values.has('url')) resolved.url = values.get('url')!.href;
    if (values.has('httpProxy')) resolved.httpProxy = values.get('httpProxy')!.href;
    if (values.has('httpsProxy')) resolved.httpsProxy = values.get('httpsProxy')!.href;
    if (values.has('allProxy')) resolved.allProxy = values.get('allProxy')!.href;
    if (Object.keys(credentials).length > 0) resolved.credentials = credentials;
    const firstCredentials = Object.values(credentials).find((value) => value !== undefined);
    const authUsername =
      firstCredentials?.username ??
      auth?.username ??
      [...values.values()].map((parsed) => parsed.username).find((value) => value !== undefined);
    if (authUsername !== undefined && authUsername !== '') {
      resolved.auth = { type: 'basic', username: authUsername };
    }
    if (tlsInfo.configured) {
      resolved.tls = tlsInfo.resolved;
      resolved.tlsMeta = tlsInfo.meta;
    }
    result[name] = resolved;
  }
  return result;
}

/** Резолвит правила маршрутизации: id, хосты, ссылки на профили. */
function resolveProxyRules(
  rawRules: readonly ProxyRuleConfig[],
  profiles: Record<string, ResolvedProxyProfile>,
  defaultProfile: string | undefined,
): ResolvedProxyRule[] {
  const seen = new Set<string>();
  return rawRules.map((raw, index) => {
    const scope = `proxy.rules[${index}]`;
    const id = raw.id !== undefined && raw.id !== '' ? raw.id : `rule-${index + 1}`;
    if (seen.has(id)) {
      throw new ProxyConfigError(`${scope}: id "${id}" повторяется (id правил уникальны)`);
    }
    seen.add(id);
    const hosts = validateProxyHostPatterns(raw.hosts, scope);
    if (raw.action !== 'proxy' && raw.action !== 'direct') {
      throw new ProxyConfigError(`${scope}.action: ожидается proxy|direct`);
    }
    if (raw.action === 'direct' && raw.profile !== undefined) {
      throw new ProxyConfigError(
        `${scope}: action=direct несовместим с profile (уберите profile или выберите action=proxy)`,
      );
    }
    const rule: ResolvedProxyRule = { id, hosts, action: raw.action };
    if (raw.label !== undefined && raw.label !== '') rule.label = raw.label;
    if (raw.action === 'proxy') {
      const profileName = raw.profile ?? defaultProfile;
      if (profileName === undefined) {
        throw new ProxyConfigError(
          `${scope}: action=proxy без profile требует defaultProfile ` +
            '(задайте profile в правиле или proxy.defaultProfile)',
        );
      }
      if (profiles[profileName] === undefined) {
        throw new ProxyConfigError(
          `${scope}: профиль "${profileName}" не найден (есть: ${Object.keys(profiles).join(', ') || '—'})`,
        );
      }
      rule.profile = profileName;
    }
    return rule;
  });
}

/**
 * Валидация входной секции `proxy` для сохранения runtime-override через API.
 *
 * Схема (`proxyConfigSchema`) + полный резолв (URL/схемы, `noProxy`, только
 * `auth.type=basic`, `tls` caFile↔caPem, cert+key, пароль из env/файла).
 * Дополнительно **запрещает пароль в userinfo URL** — в `settings.json`/PG
 * секреты не хранятся (инвариант 13), пароль задаётся отдельным endpoint'ом.
 * `SYNTH_PROXY_*`/стандартные env намеренно игнорируются, чтобы валидировать
 * именно сохраняемый объект (пароль из `SYNTH_PROXY_PASSWORD`/файла остаётся).
 */
export function validateProxyConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: { dataDir?: string } = {},
): ProxyConfig {
  const parsed = proxyConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'proxy';
    throw new ProxyConfigError(`proxy.${path}: ${issue?.message ?? 'невалидная структура'}`);
  }
  const config = parsed.data;

  /** Пароль в userinfo URL — в сохраняемом объекте запрещён (инвариант 13). */
  const assertNoUrlPassword = (raw: string | undefined, scope: string, passwordEnv: string): void => {
    if (raw === undefined || raw === '') return;
    const url = parseProxyUrl(raw);
    if (url.password === undefined) return;
    throw new ProxyConfigError(
      `${scope}: пароль в URL не хранится (инвариант 13) — задайте username и пароль ` +
        `через ${passwordEnv} или файл в {dataDir}/secrets (в config.yaml пароль не хранится)`,
    );
  };
  for (const field of PROXY_URL_FIELDS) {
    assertNoUrlPassword(config[field], `proxy.${field}`, 'secrets/proxy-password или SYNTH_PROXY_PASSWORD');
  }
  for (const [name, profile] of Object.entries(config.profiles ?? {})) {
    const passwordHint =
      name === 'default'
        ? `${PROXY_PASSWORD_ENV} или {dataDir}/secrets/proxy-password`
        : `${proxyProfilePasswordEnv(name)} или {dataDir}/secrets/proxy/${name}.password`;
    for (const field of PROXY_URL_FIELDS) {
      assertNoUrlPassword(profile[field], `proxy.profiles.${name}.${field}`, passwordHint);
    }
  }
  const validationEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    ...Object.values(PROXY_ENV),
    ...Object.values(PROXY_TLS_ENV),
    ...STANDARD_PROXY_ENV.httpProxy,
    ...STANDARD_PROXY_ENV.httpsProxy,
    ...STANDARD_PROXY_ENV.allProxy,
    ...STANDARD_PROXY_ENV.noProxy,
  ]) {
    delete validationEnv[key];
  }
  resolveProxyConfig({ proxy: config }, validationEnv, options);
  return config;
}

/** Валидация `proxy.auth`: D2a — только `basic`; NTLM/Negotiate — D3/D4. */
function validateProxyAuth(
  auth: ProxyAuthConfig | undefined,
  scope = 'proxy.auth',
): ProxyAuthConfig | undefined {
  if (auth === undefined) return undefined;
  if (auth.type !== 'basic') {
    throw new ProxyConfigError(
      `${scope}.type "${auth.type}" не поддерживается (NTLM/Negotiate — этапы D3/D4); ` +
        "доступен только 'basic'",
    );
  }
  if (!auth.username) {
    throw new ProxyConfigError(
      `${scope}.username обязателен для type=basic (либо задайте userinfo в URL прокси)`,
    );
  }
  return auth;
}

/** Разобранная цель маршрутизации (`http`/`https` + host/port). */
interface ProxyTarget {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
}

/** Разбирает origin (URL-строка/`URL`); невалидный/не-HTTP(S) → `undefined`. */
function parseProxyTarget(origin: string | URL): ProxyTarget | undefined {
  let parsed: URL;
  try {
    parsed = typeof origin === 'string' ? new URL(origin) : origin;
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return { protocol: parsed.protocol, hostname: parsed.hostname, port };
}

/** Кэш матчеров (noProxy/правила не меняются в пределах resolved-конфига). */
const matcherCache = new WeakMap<object, NoProxyMatcher>();

function cachedMatcher(key: object, entries: readonly string[] | undefined): NoProxyMatcher {
  let matcher = matcherCache.get(key);
  if (matcher === undefined) {
    matcher = new NoProxyMatcher(entries);
    matcherCache.set(key, matcher);
  }
  return matcher;
}

/** Поле URL профиля по схеме цели. */
function schemeFieldFor(protocol: 'http:' | 'https:'): ProxyUrlField {
  return protocol === 'https:' ? 'httpsProxy' : 'httpProxy';
}

/**
 * URL профиля для схемы цели: `http(s)Proxy` → `allProxy` → `url`; креды —
 * по выбранному полю. Используется и маршрутом, и `defaultProxyEntry`.
 */
function profileEntryFor(
  profile: ResolvedProxyProfile,
  field: ProxyUrlField,
): { url: string; field: ProxyUrlField; credentials?: ProxyCredentials } | undefined {
  const order: ProxyUrlField[] = [field, 'allProxy', 'url'];
  for (const candidate of order) {
    const value = profile[candidate];
    if (value === undefined) continue;
    const entry: { url: string; field: ProxyUrlField; credentials?: ProxyCredentials } = {
      url: value,
      field: candidate,
    };
    const credentials = profile.credentials?.[candidate];
    if (credentials) entry.credentials = credentials;
    return entry;
  }
  return undefined;
}

/** Legacy-профиль из flat-полей (для вручную собранных `ResolvedProxyConfig`). */
function legacyProfileOf(config: ResolvedProxyConfig): ResolvedProxyProfile | undefined {
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

/** Профиль по имени: из `profiles`, для `default` — фоллбэк на flat-поля. */
function profileByName(
  config: ResolvedProxyConfig,
  name: string | undefined,
): ResolvedProxyProfile | undefined {
  if (name === undefined) return undefined;
  const profile = config.profiles?.[name];
  // Legacy-профиль выводится из flat-полей: они остаются авторитетными
  // (совместимость с кодом/тестами, патчащими `url`/`httpProxy`/… напрямую).
  if (profile?.legacy) {
    const legacy = legacyProfileOf(config);
    if (legacy !== undefined) return legacy;
  }
  if (profile !== undefined) return profile;
  if (name === 'default') return legacyProfileOf(config);
  return undefined;
}

/**
 * Единая точка маршрутизации прокси для target-origin (ADR-099).
 *
 * Порядок: `enabled:false` → всё direct; `noProxy` **всегда выигрывает**;
 * правила (первое совпадение); затем default (`mode: all`) либо `no-match`
 * (`mode: selected`). `action: proxy` берёт `rule.profile ?? defaultProfile`.
 * CIDR матчится только по IP-литералу цели (DNS не выполняется).
 */
export function resolveProxyRoute(
  config: ResolvedProxyConfig | null | undefined,
  origin: string | URL,
): ResolvedProxyRoute {
  if (!config?.enabled) return { action: 'direct', reason: 'disabled' };
  const target = parseProxyTarget(origin);
  if (target === undefined) return { action: 'direct', reason: 'no-match' };

  const noProxyEntries = config.noProxy ?? [];
  const noProxy = cachedMatcher(noProxyEntries, noProxyEntries);
  if (noProxy.matches(target.hostname, target.port)) {
    return { action: 'direct', reason: 'no-proxy' };
  }

  const field = schemeFieldFor(target.protocol);
  for (const rule of config.rules ?? []) {
    const matcher = cachedMatcher(rule, rule.hosts);
    if (!matcher.matches(target.hostname, target.port)) continue;
    if (rule.action === 'direct') {
      return { action: 'direct', reason: 'rule', rule };
    }
    const profileName = rule.profile ?? config.defaultProfile ?? 'default';
    const profile = profileByName(config, profileName);
    if (profile === undefined) {
      return { action: 'direct', reason: 'no-default', rule };
    }
    const entry = profileEntryFor(profile, field);
    if (entry === undefined) {
      return { action: 'direct', reason: 'no-default', rule };
    }
    const route: ResolvedProxyRoute = {
      action: 'proxy',
      reason: 'rule',
      rule,
      profile: profileName,
      proxyUrl: entry.url,
    };
    if (entry.credentials !== undefined) route.credentials = entry.credentials;
    return route;
  }

  const mode: ProxyMode = config.mode ?? 'all';
  if (mode === 'selected') return { action: 'direct', reason: 'no-match' };
  return resolveDefaultProxyRoute(config, field);
}

/** Default-ветка маршрута (без правил/noProxy) — общая с `defaultProxyEntry`. */
function resolveDefaultProxyRoute(
  config: ResolvedProxyConfig,
  field: ProxyUrlField,
): ResolvedProxyRoute {
  const defaultName = config.defaultProfile ?? 'default';
  const defaultProfile = profileByName(config, defaultName);
  if (defaultProfile === undefined) return { action: 'direct', reason: 'no-default' };
  const entry = profileEntryFor(defaultProfile, field);
  if (entry === undefined) return { action: 'direct', reason: 'no-default' };
  const route: ResolvedProxyRoute = {
    action: 'proxy',
    reason: 'default',
    profile: defaultName,
    proxyUrl: entry.url,
  };
  if (entry.credentials !== undefined) route.credentials = entry.credentials;
  return route;
}

/**
 * Эффективный прокси для target-origin: `{url, credentials?}` или `undefined`.
 * Полностью выводится из `resolveProxyRoute` (профили/правила/noProxy).
 */
export function proxyEntryFor(
  config: ResolvedProxyConfig,
  origin: string | URL,
): { url: string; credentials?: ProxyCredentials } | undefined {
  const route = resolveProxyRoute(config, origin);
  if (route.action !== 'proxy' || route.proxyUrl === undefined) return undefined;
  return route.credentials !== undefined
    ? { url: route.proxyUrl, credentials: route.credentials }
    : { url: route.proxyUrl };
}

/**
 * Прокси по умолчанию (для диагностики/`/settings/proxy/check`): профиль
 * `defaultProfile` без учёта правил; порядок полей `https → all → url → http`
 * (как legacy-поведение). `undefined` — default-профиля/URL нет.
 */
export function defaultProxyEntry(
  config: ResolvedProxyConfig,
): { url: string; credentials?: ProxyCredentials } | undefined {
  if (!config.enabled) return undefined;
  // Порядок legacy: https → all → url → http (http — фоллбэк для http-only прокси).
  let route = resolveDefaultProxyRoute(config, 'httpsProxy');
  if (route.action !== 'proxy') route = resolveDefaultProxyRoute(config, 'httpProxy');
  if (route.action !== 'proxy' || route.proxyUrl === undefined) return undefined;
  return route.credentials !== undefined
    ? { url: route.proxyUrl, credentials: route.credentials }
    : { url: route.proxyUrl };
}

/**
 * URL прокси для target-origin (по маршруту: профили/правила/noProxy).
 * `undefined` — для этой цели прокси нет (direct).
 */
export function proxyUrlFor(config: ResolvedProxyConfig, origin: string | URL): string | undefined {
  return resolveProxyRoute(config, origin).proxyUrl;
}

/**
 * Нужно ли направлять URL через прокси (маршрут `action: proxy`).
 * DNS/CIDR-сверка не выполняется (только host/port цели).
 */
export function shouldProxyUrl(
  config: ResolvedProxyConfig | null | undefined,
  rawUrl: string,
): boolean {
  const route = resolveProxyRoute(config, rawUrl);
  return route.action === 'proxy' && route.proxyUrl !== undefined;
}

/** Redacted-профиль для статуса: без userinfo/паролей/PEM. */
function redactedProfileStatus(profile: ResolvedProxyProfile): ProxyStatusProfile {
  const result: ProxyStatusProfile = {
    name: profile.name,
    legacy: profile.legacy,
    source: profile.source,
  };
  if (profile.label !== undefined && profile.label !== '') result.label = profile.label;
  const url = redactProxyUrl(profile.url);
  if (url) result.url = url;
  const httpProxy = redactProxyUrl(profile.httpProxy);
  if (httpProxy) result.httpProxy = httpProxy;
  const httpsProxy = redactProxyUrl(profile.httpsProxy);
  if (httpsProxy) result.httpsProxy = httpsProxy;
  const allProxy = redactProxyUrl(profile.allProxy);
  if (allProxy) result.allProxy = allProxy;
  if (profile.auth && profile.auth.username !== '') {
    result.auth = { type: 'basic', username: profile.auth.username };
  }
  const meta = redactedTlsMeta(profile.tlsMeta);
  if (meta) {
    result.tls = { ...meta, rejectUnauthorized: profile.tls?.rejectUnauthorized ?? true };
  }
  return result;
}

/** Read-only статус прокси (без userinfo/секретов/PEM). */
export function proxyStatus(config: ResolvedProxyConfig | null | undefined): EgressProxyStatus {
  const resolved = config ?? emptyResolvedProxyConfig();
  const profiles: Record<string, ProxyStatusProfile> = {};
  for (const [name, profile] of Object.entries(resolved.profiles ?? {})) {
    profiles[name] = redactedProfileStatus(profile);
  }
  const rules: ProxyStatusRule[] = (resolved.rules ?? []).map((rule) => {
    const item: ProxyStatusRule = {
      id: rule.id,
      hosts: [...rule.hosts],
      action: rule.action,
    };
    if (rule.label !== undefined && rule.label !== '') item.label = rule.label;
    if (rule.profile !== undefined) item.profile = rule.profile;
    return item;
  });
  const status: EgressProxyStatus = {
    enabled: resolved.enabled,
    source: resolved.source,
    mode: resolved.mode ?? 'all',
    profiles,
    rules,
    noProxy: [...resolved.noProxy],
    fromEnv: resolved.fromEnv,
    fallbackDirect: resolved.fallbackDirect,
    connectTimeoutMs: resolved.connectTimeoutMs,
    restartRequired: true,
  };
  if (resolved.defaultProfile !== undefined) status.defaultProfile = resolved.defaultProfile;
  const url = redactProxyUrl(resolved.url);
  if (url) status.url = url;
  const httpProxy = redactProxyUrl(resolved.httpProxy);
  if (httpProxy) status.httpProxy = httpProxy;
  const httpsProxy = redactProxyUrl(resolved.httpsProxy);
  if (httpsProxy) status.httpsProxy = httpsProxy;
  const allProxy = redactProxyUrl(resolved.allProxy);
  if (allProxy) status.allProxy = allProxy;
  if (resolved.auth && resolved.auth.username !== '') {
    status.auth = { type: 'basic', username: resolved.auth.username };
  }
  const tlsMeta = redactedTlsMeta(resolved.tlsMeta);
  if (tlsMeta) {
    status.tls = { ...tlsMeta, rejectUnauthorized: resolved.tls?.rejectUnauthorized ?? true };
  }
  return status;
}
