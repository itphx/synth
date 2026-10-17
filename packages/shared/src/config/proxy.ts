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
import { proxyConfigSchema } from './types.js';
import type { ProxyAuthConfig, ProxyConfig, ProxyTlsConfig } from './types.js';

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

/** Эффективная конфигурация прокси (после слияния env/runtime/config/defaults). */
export interface ResolvedProxyConfig {
  enabled: boolean;
  /** Источник эффективного прокси-URL: `env` | `runtime` | `config`; `none` — прокси выключен. */
  source: 'env' | 'runtime' | 'config' | 'none';
  /** URL без userinfo (для логов/статуса/ProxyAgent `uri`). */
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

/** Read-only статус прокси для `GET /api/v2/settings/proxy` (без секретов). */
export interface EgressProxyStatus {
  enabled: boolean;
  source: 'env' | 'runtime' | 'config' | 'none';
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
  username?: string;
  password?: string;
}

/** Читает пароль из env/файла (лениво: только если реально нужен). */
function makePasswordResolver(env: NodeJS.ProcessEnv, dataDir: string | undefined): () => string | undefined {
  let cached: string | undefined | null = null;
  return () => {
    if (cached !== null) return cached;
    const fromEnv = envValue(env, PROXY_PASSWORD_ENV);
    if (fromEnv !== undefined) {
      cached = fromEnv;
      return cached;
    }
    cached = dataDir ? readProxyPasswordFile(dataDir) : undefined;
    return cached;
  };
}

/** Файл `{dataDir}/secrets/proxy-password`; ENOENT → `undefined` (пароля нет). */
function readProxyPasswordFile(dataDir: string): string | undefined {
  const path = join(dataDir, 'secrets', 'proxy-password');
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
function readProxyPemFile(path: string, field: string, marker: RegExp): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProxyConfigError(
      `[config] proxy.tls.${field}: не удалось прочитать файл "${path}": ${reason}`,
    );
  }
  if (!marker.test(content)) {
    throw new ProxyConfigError(
      `[config] proxy.tls.${field}: файл "${path}" не содержит PEM ` +
        `(ожидается блок "-----BEGIN ${field === 'keyFile' ? 'PRIVATE KEY' : 'CERTIFICATE'}-----")`,
    );
  }
  return content;
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
 */
export function mergeProxyConfig(
  base: Partial<ProxyConfig> | undefined,
  runtime: Partial<ProxyConfig> | undefined,
): Partial<ProxyConfig> {
  const b = (base ?? {}) as Partial<ProxyConfig>;
  const r = (runtime ?? {}) as Partial<ProxyConfig>;
  const pickString = (key: 'url' | 'httpProxy' | 'httpsProxy' | 'allProxy'): string | undefined => {
    const value = r[key];
    if (value !== undefined && value !== '') return value;
    const fallback = b[key];
    return fallback !== undefined && fallback !== '' ? fallback : undefined;
  };
  const merged: Partial<ProxyConfig> = {};
  if (r.enabled !== undefined) merged.enabled = r.enabled;
  else if (b.enabled !== undefined) merged.enabled = b.enabled;
  const url = pickString('url');
  if (url !== undefined) merged.url = url;
  const httpProxy = pickString('httpProxy');
  if (httpProxy !== undefined) merged.httpProxy = httpProxy;
  const httpsProxy = pickString('httpsProxy');
  if (httpsProxy !== undefined) merged.httpsProxy = httpsProxy;
  const allProxy = pickString('allProxy');
  if (allProxy !== undefined) merged.allProxy = allProxy;
  if (r.auth !== undefined || b.auth !== undefined) merged.auth = r.auth ?? b.auth;
  if (r.tls !== undefined || b.tls !== undefined) merged.tls = { ...(b.tls ?? {}), ...(r.tls ?? {}) };
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
  const auth = validateProxyAuth(cfg.auth);
  const explicitEnv = envBoolean(envValue(env, PROXY_ENV.enabled), PROXY_ENV.enabled);
  const explicit = explicitEnv ?? cfg.enabled;
  // Стандартные env — только при fromEnv и без явного `enabled:false`
  // (runtime/config задают политику инстанса, env не «включает прокси обратно»).
  const allowStandardEnv = fromEnv && explicit !== false;

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
  const urls = picked.map((p) => p.value).filter((value): value is string => value !== undefined);
  const hasAnyUrl = urls.length > 0;

  // D2b: SOCKS5 — только TCP-туннель; TLS к прокси (`proxy.tls`) неприменим.
  const anySocks = urls.some((value) => isSocksProxyProtocol(safeProtocol(value)));
  if (anySocks && isProxyTlsConfigured(cfg, env)) {
    throw new ProxyConfigError(
      'proxy.tls несовместим с socks5:// (TLS применяется только к http(s)-прокси); ' +
        'уберите proxy.tls или используйте http(s)-прокси',
    );
  }

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

  // Креды: userinfo URL приоритетнее `proxy.auth`; пароль — env/файл (если не в URL).
  // Выключенному прокси пароль не нужен — не требуем его при сохранении disable.
  const credentials: ProxyCredentialSet = {};
  if (enabled) {
    const password = makePasswordResolver(env, options.dataDir);
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
      : origins.includes('runtime')
        ? 'runtime'
        : origins.includes('config')
          ? 'config'
          : 'none';

  const resolvedTls = resolveProxyTls({ proxy: cfg }, env);
  const meta = resolveProxyTlsMeta({ proxy: cfg }, env);
  const firstCredentials = Object.values(credentials).find((value) => value !== undefined);
  const authUsername = firstCredentials?.username
    ?? auth?.username
    ?? picked.map((p) => p.username).find((value) => value !== undefined);
  const resolved: ResolvedProxyConfig = {
    enabled,
    source,
    noProxy,
    fromEnv,
    fallbackDirect,
    connectTimeoutMs,
    // TLS/mTLS к прокси: всегда резолвим (дефолт — системное доверие).
    tls: resolvedTls,
  };
  if (authUsername !== undefined && authUsername !== '') {
    resolved.auth = { type: 'basic', username: authUsername };
  }
  if (meta.caFile !== undefined || meta.certFile !== undefined || meta.keyFile !== undefined
    || meta.hasCaPem || resolvedTls.rejectUnauthorized === false) {
    resolved.tlsMeta = meta;
  }
  if (url.value !== undefined) resolved.url = url.value;
  if (httpProxy.value !== undefined) resolved.httpProxy = httpProxy.value;
  if (httpsProxy.value !== undefined) resolved.httpsProxy = httpsProxy.value;
  if (allProxy.value !== undefined) resolved.allProxy = allProxy.value;
  if (Object.keys(credentials).length > 0) resolved.credentials = credentials;
  return resolved;
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
  for (const field of PROXY_URL_FIELDS) {
    const raw = config[field];
    if (raw === undefined || raw === '') continue;
    const url = parseProxyUrl(raw);
    if (url.password !== undefined) {
      throw new ProxyConfigError(
        `proxy.${field}: пароль в URL не хранится (инвариант 13) — задайте ` +
          'proxy.auth.username и пароль через secrets/proxy-password или SYNTH_PROXY_PASSWORD',
      );
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
function validateProxyAuth(auth: ProxyAuthConfig | undefined): ProxyAuthConfig | undefined {
  if (auth === undefined) return undefined;
  if (auth.type !== 'basic') {
    throw new ProxyConfigError(
      `proxy.auth.type "${auth.type}" не поддерживается (NTLM/Negotiate — этапы D3/D4); ` +
        "доступен только 'basic'",
    );
  }
  if (!auth.username) {
    throw new ProxyConfigError(
      'proxy.auth.username обязателен для type=basic (либо задайте userinfo в URL прокси)',
    );
  }
  return auth;
}

/** Поле URL, выбранное для target-origin (по схеме цели). */
function proxyFieldFor(origin: string | URL): ProxyUrlField | undefined {
  let protocol: string;
  try {
    protocol = typeof origin === 'string' ? new URL(origin).protocol : origin.protocol;
  } catch {
    return undefined;
  }
  if (protocol === 'https:') return 'httpsProxy';
  if (protocol === 'http:') return 'httpProxy';
  return undefined;
}

/**
 * Эффективный прокси для target-origin: `{url, credentials?}` или `undefined`.
 * Выбор: `httpsProxy`/`httpProxy` по схеме → `allProxy` → общий `url`.
 */
export function proxyEntryFor(
  config: ResolvedProxyConfig,
  origin: string | URL,
): { url: string; credentials?: ProxyCredentials } | undefined {
  const schemeField = proxyFieldFor(origin);
  if (schemeField === undefined) return undefined;
  const order: ProxyUrlField[] = [schemeField, 'allProxy', 'url'];
  for (const field of order) {
    const value = config[field];
    if (value !== undefined) {
      const credentials = config.credentials?.[field];
      return credentials ? { url: value, credentials } : { url: value };
    }
  }
  return undefined;
}

/** Прокси по умолчанию (для диагностики/`/settings/proxy/check`). */
export function defaultProxyEntry(
  config: ResolvedProxyConfig,
): { url: string; credentials?: ProxyCredentials } | undefined {
  if (!config.enabled) return undefined;
  const order: ProxyUrlField[] = ['httpsProxy', 'allProxy', 'url', 'httpProxy'];
  for (const field of order) {
    const value = config[field];
    if (value !== undefined) {
      const credentials = config.credentials?.[field];
      return credentials ? { url: value, credentials } : { url: value };
    }
  }
  return undefined;
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
    fromEnv: resolved.fromEnv,
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
  if (resolved.auth && resolved.auth.username !== '') {
    status.auth = { type: 'basic', username: resolved.auth.username };
  }
  const tlsMeta = redactedTlsMeta(resolved.tlsMeta);
  if (tlsMeta) {
    status.tls = { ...tlsMeta, rejectUnauthorized: resolved.tls?.rejectUnauthorized ?? true };
  }
  return status;
}
