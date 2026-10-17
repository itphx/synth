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
import { readFileSync } from 'node:fs';
import {
  resolveProxyConfig,
  resolveTlsConfig,
  resolveTlsTrust,
  type ProxyConfigSource,
  type ResolvedProxyConfig,
  type ResolvedTlsConfig,
  type SecurityTlsConfig,
  type TlsConfigSource,
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
}

/** Ленивая загрузка undici (инъекция — тесты на отсутствие зависимости). */
export type LoadUndici = () => Promise<typeof import('undici')>;

export interface ApplyTlsTrustDeps {
  loadUndici?: LoadUndici;
  /** ADR-099 (D1): эффективная конфигурация прокси (по умолчанию — активная). */
  proxy?: ResolvedProxyConfig | null;
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
  return !!(t.ca || t.cert || t.key) || t.rejectUnauthorized === false;
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
): TlsTrust {
  return resolveTrustBundle(config, env).trust;
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

  if (proxy?.enabled) {
    // Прокси — единый dispatcher egress-слоя (TLS к цели + маршрут).
    const { EgressDispatcher } = await import('./proxy-dispatcher.js');
    _dispatcher = new EgressDispatcher({
      proxy,
      tls: {
        ca: trust.ca,
        cert: trust.cert,
        key: trust.key,
        rejectUnauthorized: trust.rejectUnauthorized,
      },
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
  const bundle = resolveTrustBundle(config, env);
  // ADR-099 (D1): прокси резолвится здесь же (env > config > defaults) и
  // применяется к исходящим запросам тем же dispatcher'ом. Fail-closed:
  // битый URL/схема/userinfo останавливают старт (как caFile → не-PEM).
  const proxy = resolveProxyConfig(config, env);
  setEgressProxyConfig(proxy);
  _resolved = bundle.resolved;
  await applyGlobalTlsTrust(bundle.trust, { ...deps, proxy });
  return bundle.trust;
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

/** Сброс модульного состояния (изоляция тестов). Не для продакшн-кода. */
export function _resetTlsTrustForTests(): void {
  _resolved = null;
  _trust = null;
  _dispatcher = null;
  resetEgressProxyState();
}

// ─── внутреннее состояние ────────────────────────────────────────────────────

let _resolved: ResolvedTlsConfig | null = null;
let _trust: TlsTrust | null = null;
let _dispatcher: unknown | null = null;

interface TrustBundle {
  resolved: ResolvedTlsConfig;
  trust: TlsTrust;
}

/** Один проход: эффективный конфиг + прочитанное доверие (CA/cert/key). */
function resolveTrustBundle(config: TlsConfigSource | undefined, env: NodeJS.ProcessEnv): TrustBundle {
  const resolved = resolveTlsConfig(config, env);
  const trustCfg = resolveTlsTrust(config, env);
  const trust: TlsTrust = { rejectUnauthorized: trustCfg.rejectUnauthorized };
  if (trustCfg.ca !== undefined) trust.ca = trustCfg.ca;
  if (trustCfg.certFile !== undefined) {
    trust.cert = readPemFile(trustCfg.certFile, 'certFile', /-----BEGIN CERTIFICATE-----/);
  }
  if (trustCfg.keyFile !== undefined) {
    trust.key = readPemFile(trustCfg.keyFile, 'keyFile', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
  }
  return { resolved, trust };
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
