/**
 * ADR-099: единый механизм доверия TLS/CA для **всех** исходящих соединений Synth.
 *
 * Проблема: раньше каждая точка (LLM-провайдеры, MCP, webhooks, гибридный backend,
 * OIDC, git, загрузка иконок/обновлений) ходила в сеть «сырым» глобальным `fetch`,
 * который доверяет только системным CA Node. За корпоративным прокси/CA это либо
 * падало с `self-signed certificate in certificate chain`, либо (при отключении
 * проверки) открывало MITM.
 *
 * Решение — один слой доверия:
 * - конфиг читается резолверами `resolveTlsConfig`/`resolveTlsTrust`
 *   (`@itphx/synth-shared`, секция `security.tls`, ADR-023);
 * - `buildTlsTrust` читает PEM CA/клиентского сертификата и ключа;
 * - `applyGlobalTlsTrust` ставит глобальный undici-dispatcher (`setGlobalDispatcher`)
 *   — покрывает обычный `fetch` по всему процессу;
 * - `egressFetch` — `fetch` с **явным** dispatcher, не зависящий от глобального
 *   состояния (для точек, где нужен детерминированный транспорт/тесты).
 *
 * Пустая конфигурация — системное доверие, никаких эффектов (поведение не меняется).
 * Заданная конфигурация без пакета `undici` — понятная ошибка (в духе ADR-078),
 * а не тихий фоллбэк на недоверенный транспорт.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  certificateSubjectFromFile,
  certificateSubjectsFromPem,
  countCertificates,
  emptyResolvedProxyConfig,
  readTlsRuntimeSettings,
  resolveProxyConfig,
  resolveTlsConfig,
  resolveTlsProfiles,
  resolveTlsTrust,
  type ProxyConfig,
  type ProxyConfigSource,
  type ResolvedProxyConfig,
  type ResolvedTlsConfig,
  type SecurityTlsConfig,
  type TlsClientProfile,
  type TlsConfigSource,
  type TlsRuntimeSettings,
  type TlsSource,
} from '@itphx/synth-shared';
import {
  getEgressProxyConfig,
  gitProxyConfig as gitProxyConfigFromState,
  resetEgressProxyState,
  setEgressProxyConfig,
  wrapDispatcherWithVia,
  type EgressVia,
} from './proxy-state.js';

/** Транспорт с явным dispatcher (undici-совместимый `fetch`). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Эффективное доверие для undici `Agent({ connect })`. */
export interface TlsTrust {
  /** PEM доверенного CA (система + корпоративный CA). */
  ca?: string;
  /** PEM клиентского сертификата (mTLS). */
  cert?: string;
  /** PEM приватного ключа клиента (mTLS). */
  key?: string;
  /** Проверять сертификат сервера. */
  rejectUnauthorized: boolean;
  /**
   * ADR-099: per-host клиентские профили (mTLS). Первый совпавший по host
   * используется для запроса; нет совпадений — основной `ca/cert/key` (default).
   * Пусто/не задано — прежнее поведение (один профиль).
   */
  profiles?: TlsProfileTrust[];
}

/** Прочитанный клиентский профиль (PEM уже загружен; наружу не отдаётся). */
export interface TlsProfileTrust {
  id: string;
  hosts: string[];
  label?: string;
  source: TlsSource;
  readOnly: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
}

/** Ленивая загрузка undici (инъекция — тесты на отсутствие зависимости). */
export type LoadUndici = () => Promise<typeof import('undici')>;

export interface ApplyTlsTrustDeps {
  loadUndici?: LoadUndici;
  /** ADR-099 (D1): эффективная конфигурация прокси (по умолчанию — активная). */
  proxy?: ResolvedProxyConfig | null;
  /** ADR-099 (D2a): каталог данных — для файла `{dataDir}/secrets/proxy-password`. */
  dataDir?: string;
  /**
   * ADR-099: bootstrap-настройки TLS (`{dataDir}/security-tls.json`). Не задано —
   * читаются из `dataDir` (если он передан); `null` — явно не читать (тесты).
   */
  tlsRuntime?: TlsRuntimeSettings | null;
}

/** Опции применения runtime-override прокси при старте (`applyEgressProxyConfig`). */
export interface ApplyEgressProxyDeps extends ApplyTlsTrustDeps {
  /** Runtime-override (`RuntimeSettings.proxy`) поверх `config.yaml proxy`. */
  runtime?: Partial<ProxyConfig> | undefined;
}

export interface EgressFetchDeps {
  /** Явный транспорт (тесты) — по умолчанию глобальный `fetch`. */
  fetchImpl?: FetchLike;
  /** Явный undici-dispatcher (тесты) — по умолчанию dispatcher доверия процесса. */
  dispatcher?: unknown;
  /**
   * ADR-099 (D1): фактический маршрут запроса (`proxy`/`direct`/`fallback`) —
   * для журнала egress. Вызывается dispatcher'ом; без прокси не вызывается.
   */
  onVia?: (via: EgressVia) => void;
}

/** Ошибка отсутствия зависимости: доверие задано, но применить его нечем (ADR-078-подобно). */
export class TlsDependencyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsDependencyUnavailableError';
  }
}

/** `true`, если доверие явно сконфигурировано (есть CA/клиентский серт либо проверка серта выключена). */
export function isTlsTrustConfigured(trust?: TlsTrust): boolean {
  const t = trust ?? _trust;
  if (!t) return false;
  if (!!(t.ca || t.cert || t.key) || t.rejectUnauthorized === false) return true;
  return (t.profiles ?? []).some(
    (profile) => !!(profile.ca || profile.cert || profile.key) || profile.rejectUnauthorized === false,
  );
}

/**
 * Читает CA/клиентский сертификат+ключ (PEM) и возвращает эффективное доверие.
 * Без файлов — `{ rejectUnauthorized: true }` (системное доверие).
 *
 * Fail-closed на каждый явно заданный файл: отсутствует/не читается/не PEM →
 * внятная ошибка (см. `resolveTlsTrust`/`readPemFile`).
 */
export function buildTlsTrust(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: TlsRuntimeSettings,
): TlsTrust {
  return resolveTrustBundle(config, env, runtime).trust;
}

/**
 * ADR-099: доверие + per-host клиентские профили (mTLS) — для dispatcher'а и
 * PostgreSQL. Профили читаются из runtime (bootstrap) и материалов; default —
 * из env > runtime > config (поле-уровнево).
 */
export function buildTlsTrustProfiles(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: TlsRuntimeSettings,
): TlsTrust {
  return resolveTrustBundle(config, env, runtime).trust;
}

/**
 * Применяет доверие глобально: `setGlobalDispatcher(new Agent({ connect }))`
 * (ленивый `import('undici')`). Покрывает обычный `fetch` по всему процессу.
 *
 * - доверие не сконфигурировано — no-op (undici даже не загружается);
 * - `undici` недоступен, а доверие задано — `TlsDependencyUnavailableError`.
 */
export async function applyGlobalTlsTrust(
  trust: TlsTrust,
  deps: ApplyTlsTrustDeps = {},
): Promise<void> {
  _trust = trust;
  const proxy = deps.proxy !== undefined ? deps.proxy : getEgressProxyConfig();
  if (!isTlsTrustConfigured(trust) && !proxy?.enabled) {
    _dispatcher = null;
    return;
  }

  const load = deps.loadUndici ?? (() => import('undici'));
  let undici: typeof import('undici');
  try {
    undici = await load();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TlsDependencyUnavailableError(
      'security.tls/proxy задан, но пакет undici недоступен: без него нельзя применить ' +
        'ca/cert/key/rejectUnauthorized и HTTP-прокси к исходящим https-запросам. ' +
        `Установите undici@^7 (${reason})`,
    );
  }

  const profiles = trust.profiles ?? [];
  if (proxy?.enabled || profiles.length > 0) {
    // Прокси и/или per-host профили — единый dispatcher egress-слоя.
    const { EgressDispatcher } = await import('./proxy-dispatcher.js');
    _dispatcher = new EgressDispatcher({
      proxy: proxy ?? emptyResolvedProxyConfig(),
      tls: {
        ca: trust.ca,
        cert: trust.cert,
        key: trust.key,
        rejectUnauthorized: trust.rejectUnauthorized,
      },
      tlsProfiles: profiles.map((profile) => ({
        id: profile.id,
        hosts: profile.hosts,
        tls: {
          ca: profile.ca,
          cert: profile.cert,
          key: profile.key,
          rejectUnauthorized: profile.rejectUnauthorized,
        },
      })),
    });
  } else {
    _dispatcher = new undici.Agent({
      connect: {
        ca: trust.ca,
        cert: trust.cert,
        key: trust.key,
        rejectUnauthorized: trust.rejectUnauthorized,
      },
    });
  }
  undici.setGlobalDispatcher(_dispatcher as never);
}

/**
 * Один вызов инициализации доверия при старте процесса: строит доверие из конфига
 * и применяет его глобально. Нужен **до** первого исходящего запроса (в т.ч. для
 * точек, которые ходят в сеть до сборки контекста: `syncProvidersFromEnv`,
 * проверка обновлений, дискавери OIDC).
 */
export async function initTlsTrust(
  config: (TlsConfigSource & ProxyConfigSource) | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: ApplyTlsTrustDeps = {},
): Promise<TlsTrust> {
  // ADR-099: bootstrap-настройки читаются **до** подключения к PostgreSQL/DNS —
  // настройки TLS нужны, чтобы это подключение вообще стало возможным. Явный
  // `runtime` (в т.ч. `null`) приоритетнее чтения файла.
  const runtime =
    deps.tlsRuntime !== undefined
      ? deps.tlsRuntime ?? undefined
      : deps.dataDir
        ? readTlsRuntimeSettings(deps.dataDir)
        : undefined;
  const bundle = resolveTrustBundle(config, env, runtime);
  // ADR-099 (D1): прокси резолвится здесь же (env > config > defaults) и
  // применяется к исходящим запросам тем же dispatcher'ом. Fail-closed:
  // битый URL/схема/userinfo останавливают старт (как caFile → не-PEM).
  const proxy = resolveProxyConfig(config, env, { dataDir: deps.dataDir });
  setEgressProxyConfig(proxy);
  _resolved = bundle.resolved;
  _runtime = runtime ?? null;
  _appliedFingerprint = fingerprintTrust(bundle.trust);
  await applyGlobalTlsTrust(bundle.trust, { ...deps, proxy });
  return bundle.trust;
}

/**
 * ADR-099: применить уже резолвленную конфигурацию прокси к процессу —
 * заменить текущий TLS-dispatcher на `EgressDispatcher` (или вернуть `Agent`
 * при выключенном прокси). Вызывается при старте; live-переключения нет.
 */
export async function configureEgressProxy(
  proxy: ResolvedProxyConfig,
  deps: ApplyTlsTrustDeps = {},
): Promise<void> {
  setEgressProxyConfig(proxy);
  await applyGlobalTlsTrust(_trust ?? { rejectUnauthorized: true }, { ...deps, proxy });
}

/**
 * Второй шаг инициализации egress после сборки хранилища: резолвит `proxy` с
 * runtime-override (`{dataDir}/settings.json`/PG) и применяет dispatcher **до**
 * создания провайдеров/deps. `initTlsTrust` остаётся первым (TLS/PG), потому что
 * хранилище нужно, чтобы прочитать runtime-настройку.
 */
export async function applyEgressProxyConfig(
  config: ProxyConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: ApplyEgressProxyDeps = {},
): Promise<ResolvedProxyConfig> {
  const proxy = resolveProxyConfig(config, env, { dataDir: deps.dataDir, runtime: deps.runtime });
  await configureEgressProxy(proxy, deps);
  return proxy;
}

/**
 * `fetch` с **явным** dispatcher доверия процесса (если задано) — не зависит от
 * глобального состояния `setGlobalDispatcher`. Без заданного доверия — обычный
 * `fetch`. Тесты инжектят `fetchImpl`/`dispatcher`.
 */
export function egressFetch(
  input: string | URL | Request,
  init?: RequestInit,
  deps: EgressFetchDeps = {},
): Promise<Response> {
  const impl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const dispatcher = deps.dispatcher !== undefined ? deps.dispatcher : _dispatcher;
  if (dispatcher === null || dispatcher === undefined) {
    return impl(input, init);
  }
  // ADR-099 (D1): при запросе фактического маршрута (`onVia`) dispatcher
  // оборачивается лёгким шимом, который передаёт колбэк в DispatchOptions.
  const effective = deps.onVia ? wrapDispatcherWithVia(dispatcher, deps.onVia) : dispatcher;
  return impl(input, { ...(init ?? {}), dispatcher: effective } as unknown as RequestInit);
}

/**
 * Путь к PEM-файлу доверенного CA из **уже инициализированного** доверия
 * (`initTlsTrust`) либо `undefined`, если CA не задан через `caFile`.
 *
 * Нужен точкам, которые не читают конфиг сами и живут вне общего транспорта
 * (git): им нужен путь к файлу для `-c http.sslCAInfo=<path>`. `caPem` (PEM без
 * файла) git-каналу недоступен — для git задавайте `security.tls.caFile`.
 */
export function getTlsCaPath(): string | undefined {
  return _resolved?.caFile;
}

/**
 * Эффективный конфиг доверия (`initTlsTrust`) — для call-site'ов без доступа к
 * конфигу (git). Копия, чтобы потребитель не мутировал модульное состояние.
 */
export function getTlsTrustConfig(): ResolvedTlsConfig | undefined {
  return _resolved ? { ..._resolved } : undefined;
}

/**
 * Аргументы git-конфига для доверия CA (`git -c <arg>`): `http.sslCAInfo=<path>`
 * когда задан `caFile`. Пусто — системное доверие.
 */
export function gitCaConfig(): string[] {
  const caFile = getTlsCaPath();
  return caFile ? [`http.sslCAInfo=${caFile}`] : [];
}

/**
 * ADR-099 (D1): аргументы git-конфига для прокси (`git -c http.proxy=<url>`).
 * Пусто — прокси выключен (или URL нет). SOCKS/креды — этап D2.
 */
export function gitProxyConfig(): string[] {
  return gitProxyConfigFromState();
}

/**
 * ADR-099 (D1): read-only статус прокси процесса (для
 * `GET /api/v2/settings/proxy`; без userinfo/секретов).
 */
export { getEgressProxyStatus } from './proxy-state.js';
export type { EgressProxyStatus, ResolvedProxyConfig, ProxyConfigSource } from '@itphx/synth-shared';
export type { EgressVia } from './proxy-state.js';

/**
 * ADR-099: read-only статус доверия TLS для будущего API/UI.
 * Секреты (PEM/ключи) **не отдаются**: только источники, subject'ы, пути и флаги.
 */
export interface TlsStatusCa {
  source: TlsSource;
  /** Количество сертификатов в CA-бандле. */
  count: number;
  /** Subject'ы сертификатов CA (без PEM). */
  subjects: string[];
}

export interface TlsStatusClient {
  source: TlsSource;
  certSubject?: string;
  hasKey: boolean;
  /** `true` — источник env/config (UI только показывает). */
  readOnly: boolean;
}

export interface TlsStatusMapping {
  id: string;
  hosts: string[];
  label?: string;
  certSubject?: string;
  source: TlsSource;
  readOnly: boolean;
}

export interface TlsStatus {
  ca: TlsStatusCa;
  rejectUnauthorized: boolean;
  defaultClient?: TlsStatusClient;
  mappings: TlsStatusMapping[];
  /** Что пришло из config/env/runtime — для read-only отображения. */
  params: {
    ca?: { source: TlsSource; caFile?: string; hasPem: boolean };
    client?: { source: TlsSource; certFile?: string; keyFile?: string; readOnly: boolean };
  };
  running?: { applied: boolean; profileIds: string[] };
  saved?: { bootstrap: boolean; profileIds: string[] };
  /** Изменения сохранены, но вступят в силу при следующем старте. */
  restartRequired?: boolean;
}

export interface TlsStatusOptions {
  config?: TlsConfigSource;
  env?: NodeJS.ProcessEnv;
  /** Bootstrap-настройки; `undefined` — прочитать из `dataDir`/применённые. */
  runtime?: TlsRuntimeSettings | null;
  dataDir?: string;
}

/**
 * Собирает статус: эффективные источники (env > runtime > config), клиентские
 * профили (per-host) и признак «нужен рестарт». Только метаданные.
 */
export function getTlsStatus(options: TlsStatusOptions = {}): TlsStatus {
  const env = options.env ?? process.env;
  const runtime =
    options.runtime !== undefined
      ? options.runtime ?? undefined
      : options.dataDir
        ? readTlsRuntimeSettings(options.dataDir)
        : _runtime ?? undefined;

  const profiles = resolveTlsProfiles(options.config, env, runtime);
  const trust = resolveTrustBundle(options.config, env, runtime).trust;

  const caPem = trust.ca;
  const status: TlsStatus = {
    ca: {
      source: profiles.sources.ca,
      count: countCertificates(caPem),
      subjects: certificateSubjectsFromPem(caPem),
    },
    rejectUnauthorized: profiles.rejectUnauthorized,
    mappings: profiles.mappings.map((mapping) => ({
      id: mapping.id,
      hosts: [...mapping.hosts],
      ...(mapping.label !== undefined ? { label: mapping.label } : {}),
      ...(certificateSubjectFromFile(mapping.certFile) !== undefined
        ? { certSubject: certificateSubjectFromFile(mapping.certFile) }
        : {}),
      source: 'runtime',
      readOnly: false,
    })),
    params: {},
  };

  if (profiles.default !== undefined) {
    const profile = profiles.default;
    status.defaultClient = {
      source: profile.source,
      ...(certificateSubjectFromFile(profile.certFile) !== undefined
        ? { certSubject: certificateSubjectFromFile(profile.certFile) }
        : {}),
      hasKey: profile.keyFile !== '',
      readOnly: profile.readOnly,
    };
    status.params.client = {
      source: profile.source,
      certFile: profile.certFile,
      keyFile: profile.keyFile,
      readOnly: profile.readOnly,
    };
  }
  if (profiles.sources.ca !== 'none') {
    status.params.ca = {
      source: profiles.sources.ca,
      ...(profiles.caFile !== undefined ? { caFile: profiles.caFile } : {}),
      hasPem: profiles.caPem !== undefined,
    };
  }

  if (_trust !== null) {
    status.running = {
      applied: true,
      profileIds: ['default', ...(_trust.profiles ?? []).map((profile) => profile.id)],
    };
    status.saved = {
      bootstrap: runtime !== undefined,
      profileIds: ['default', ...profiles.mappings.map((mapping) => mapping.id)],
    };
    status.restartRequired = _appliedFingerprint !== fingerprintTrust(trust);
  }

  return status;
}

/** Сброс модульного состояния (изоляция тестов). Не для продакшн-кода. */
export function _resetTlsTrustForTests(): void {
  _resolved = null;
  _trust = null;
  _runtime = null;
  _appliedFingerprint = null;
  _dispatcher = null;
  resetEgressProxyState();
}

// ─── внутреннее состояние ────────────────────────────────────────────────────

let _resolved: ResolvedTlsConfig | null = null;
let _trust: TlsTrust | null = null;
let _runtime: TlsRuntimeSettings | null = null;
let _appliedFingerprint: string | null = null;
let _dispatcher: unknown | null = null;

interface TrustBundle {
  resolved: ResolvedTlsConfig;
  trust: TlsTrust;
}

/** Один проход: эффективный конфиг + прочитанное доверие (CA/cert/key + профили). */
function resolveTrustBundle(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv,
  runtime?: TlsRuntimeSettings,
): TrustBundle {
  const resolved = resolveTlsConfig(config, env, runtime);
  const trustCfg = resolveTlsTrust(config, env, runtime);
  const profiles = resolveTlsProfiles(config, env, runtime);

  const trust: TlsTrust = { rejectUnauthorized: trustCfg.rejectUnauthorized };
  if (trustCfg.ca !== undefined) trust.ca = trustCfg.ca;
  if (trustCfg.certFile !== undefined) {
    trust.cert = readPemFile(trustCfg.certFile, 'certFile', /-----BEGIN CERTIFICATE-----/);
  }
  if (trustCfg.keyFile !== undefined) {
    trust.key = readPemFile(trustCfg.keyFile, 'keyFile', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  }

  if (profiles.mappings.length > 0) {
    trust.profiles = profiles.mappings.map((profile) => loadProfile(profile, trustCfg.ca, trustCfg.rejectUnauthorized));
  }
  return { resolved, trust };
}

/** Читает PEM-материалы клиентского профиля (fail-closed). */
function loadProfile(
  profile: TlsClientProfile,
  ca: string | undefined,
  rejectUnauthorized: boolean,
): TlsProfileTrust {
  const loaded: TlsProfileTrust = {
    id: profile.id,
    hosts: [...profile.hosts],
    source: profile.source,
    readOnly: profile.readOnly,
    cert: readPemFile(profile.certFile, `mappings.${profile.id}.certFile`, /-----BEGIN CERTIFICATE-----/),
    key: readPemFile(profile.keyFile, `mappings.${profile.id}.keyFile`, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/),
    rejectUnauthorized,
  };
  if (profile.label !== undefined) loaded.label = profile.label;
  if (ca !== undefined) loaded.ca = ca;
  return loaded;
}

/** Отпечаток применённого/сохранённого доверия (без раскрытия PEM). */
function fingerprintTrust(trust: TlsTrust): string {
  const digest = (value: string | undefined): string | null =>
    value === undefined ? null : createHash('sha256').update(value).digest('hex');
  return JSON.stringify({
    ca: digest(trust.ca),
    cert: digest(trust.cert),
    key: digest(trust.key),
    rejectUnauthorized: trust.rejectUnauthorized,
    profiles: (trust.profiles ?? [])
      .map((profile) => ({
        id: profile.id,
        hosts: profile.hosts.map((host) => host.toLowerCase()),
        ca: digest(profile.ca),
        cert: digest(profile.cert),
        key: digest(profile.key),
        rejectUnauthorized: profile.rejectUnauthorized,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Читает PEM-файл; нет/не читается/не PEM → внятная ошибка (fail-closed). */
function readPemFile(path: string, field: string, marker: RegExp): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[tls] security.tls.${field}: не удалось прочитать файл "${path}": ${reason}`);
  }
  if (!marker.test(content)) {
    throw new Error(
      `[tls] security.tls.${field}: файл "${path}" не содержит PEM (ожидается блок ` +
        `"-----BEGIN ${field === 'keyFile' ? 'PRIVATE KEY' : 'CERTIFICATE'}-----")`,
    );
  }
  return content;
}

/** Совместимый с `SecurityTlsConfig` реэкспорт (для call-site'ов без полного конфига). */
export type { SecurityTlsConfig };
