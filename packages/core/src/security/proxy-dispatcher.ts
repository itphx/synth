/**
 * ADR-099 (этап D1): единый undici-dispatcher с HTTP/HTTPS-прокси.
 *
 * `EgressDispatcher` — `undici.Dispatcher`, который для каждого запроса выбирает
 * маршрут через **единую точку** `resolveProxyRoute` (shared):
 * - `disabled` / `noProxy` / `action:'direct'`-правило / `mode:'selected'` без
 *   правила → прямой `Agent` (target TLS);
 * - `action:'proxy'` → `ProxyAgent` выбранного **профиля** (`profile.url`/
 *   scheme-поля, `profile.credentials`, `proxyTls: profile.tls`), кэш —
 *   `origin + профиль + proxy URL + auth fingerprint + target TLS profile id`;
 * - TLS-доверие к цели — `requestTls` из `security.tls` (CA/mTLS), к самому
 *   прокси — `proxyTls` из профиля (для synthetic legacy-default — `config.tls`);
 * - недоступный прокси → `EgressProxyUnavailableError` (`EGRESS_PROXY_UNAVAILABLE`),
 *   без тихого direct; `fallbackDirect` — только явный opt-in с warn и
 *   `via:'fallback'` (fallback идёт напрямую с target TLS профилем).
 *
 * Модуль тянет `undici` статически, поэтому `security/tls.ts` импортирует его
 * **динамически** — при конфигурации без прокси/доверия пакет не грузится.
 */
import { createHash } from 'node:crypto';
import { Agent, Dispatcher, ProxyAgent, Socks5ProxyAgent } from 'undici';
import {
  isSocksProxyProtocol,
  matchTlsHostPattern,
  redactProxyUrl,
  resolveProxyRoute,
  type ProxyCredentials,
  type ResolvedProxyConfig,
  type ResolvedProxyProfile,
  type ResolvedProxyRoute,
  type ResolvedProxyTls,
} from '@itphx/synth-shared';
import {
  EGRESS_VIA,
  proxyProfileOf,
  type EgressVia,
  type EgressViaReporter,
} from './proxy-state.js';

/** Ошибка недоступности прокси (fail-closed: direct молча не выполняется). */
export class EgressProxyUnavailableError extends Error {
  readonly code = 'EGRESS_PROXY_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EgressProxyUnavailableError';
  }
}

/**
 * Ошибка аутентификации прокси (D2a): `407` без кред либо с неверными.
 * Direct-фоллбек для auth-ошибок **не применяется** даже при `fallbackDirect`.
 */
export class EgressProxyAuthError extends Error {
  readonly code: 'EGRESS_PROXY_AUTH_REQUIRED' | 'EGRESS_PROXY_AUTH_FAILED';

  constructor(
    code: 'EGRESS_PROXY_AUTH_REQUIRED' | 'EGRESS_PROXY_AUTH_FAILED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EgressProxyAuthError';
    this.code = code;
  }
}

/** `true`, если ошибка транспорта — ответ прокси `407` (auth required). */
function isProxyAuthFailure(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  return /Proxy Authentication Required \(407\)|Proxy response \(407\)/i.test(reason);
}

/** `true`, если ошибка — отказ SOCKS5-аутентификации (RFC 1929/0xFF). */
function isSocksAuthFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.includes('SOCKS5_AUTH')) return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/no acceptable authentication|authentication failed|SOCKS5 authentication/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** TLS-опции соединения (совместимы с `undici` `connect`/`requestTls`). */
export interface EgressDispatcherTls {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

/** Per-host клиентский TLS-профиль (ADR-099, mTLS). */
export interface EgressTlsProfile {
  /** `default` либо id runtime-маппинга. */
  id: string;
  /** Host-паттерны (`host`, `*.suffix`, `*`); пусто — только default. */
  hosts: string[];
  tls: EgressDispatcherTls;
}

export interface EgressDispatcherOptions {
  proxy: ResolvedProxyConfig;
  tls?: EgressDispatcherTls;
  /**
   * ADR-099: per-host клиентские профили. Первый совпавший по host запроса
   * используется для TLS к цели; нет совпадений — `tls` (default).
   */
  tlsProfiles?: EgressTlsProfile[];
  /** Логгер предупреждений (fallbackDirect). */
  warn?: (message: string) => void;
}

type ViaOptions = Dispatcher.DispatchOptions & {
  [EGRESS_VIA]?: EgressViaReporter;
};

/**
 * Единый dispatcher egress-слоя. Один экземпляр на процесс (ставится
 * `setGlobalDispatcher` и передаётся явным `dispatcher` в `egressFetch`).
 */
export class EgressDispatcher extends Dispatcher {
  readonly #proxy: ResolvedProxyConfig;
  readonly #defaultTls: EgressDispatcherTls;
  readonly #profiles: EgressTlsProfile[];
  /** Прямые агенты — кэш по `origin+profile.id`. */
  readonly #directAgents = new Map<string, Agent>();
  readonly #proxies = new Map<string, Dispatcher>();
  readonly #warn: (message: string) => void;

  constructor(options: EgressDispatcherOptions) {
    super();
    this.#proxy = options.proxy;
    this.#defaultTls = options.tls ?? { rejectUnauthorized: true };
    this.#profiles = options.tlsProfiles ?? [];
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Клиентский профиль для origin (первое совпадение маппинга, иначе default). */
  profileFor(origin: string | URL): EgressTlsProfile {
    const host = hostOf(origin);
    if (host !== undefined) {
      for (const profile of this.#profiles) {
        if (profile.hosts.some((pattern) => matchTlsHostPattern(pattern, host))) return profile;
      }
    }
    const fallback = this.#profiles.find((profile) => profile.id === 'default');
    return fallback ?? { id: 'default', hosts: [], tls: this.#defaultTls };
  }

  /** id профиля, который будет применён к origin (для тестов/диагностики). */
  tlsProfileIdFor(origin: string | URL): string {
    return this.profileFor(origin).id;
  }

  /**
   * Маршрут для origin по единой точке shared (`resolveProxyRoute`):
   * disabled → noProxy → первое правило → default (`mode: all`) / no-match.
   */
  proxyRouteFor(origin: string | URL): ResolvedProxyRoute {
    return resolveProxyRoute(this.#proxy, origin);
  }

  /**
   * Эффективный **прокси-профиль** для origin (не путать с `profileFor` —
   * target TLS профиль). `undefined` — маршрут direct.
   */
  proxyProfileFor(origin: string | URL): ResolvedProxyProfile | undefined {
    const route = this.proxyRouteFor(origin);
    if (route.action !== 'proxy') return undefined;
    return proxyProfileOf(this.#proxy, route.profile);
  }

  /** Планируемый маршрут для origin (без учёта fallback). */
  routeFor(origin: string | URL): 'proxy' | 'direct' {
    const route = this.proxyRouteFor(origin);
    return route.action === 'proxy' && route.proxyUrl !== undefined ? 'proxy' : 'direct';
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const reporter = (opts as ViaOptions)[EGRESS_VIA];
    const origin = opts.origin;
    if (origin === undefined) return this.#directFor(undefined).dispatch(opts, handler);

    const url = safeUrl(origin, opts.path);
    const target = url ?? origin;
    const route = this.proxyRouteFor(target);
    if (route.action !== 'proxy' || route.proxyUrl === undefined) {
      reporter?.('direct');
      return this.#directFor(target).dispatch(opts, handler);
    }

    // Маршрут дал имя профиля; из профиля берём TLS/mTLS к прокси (креды и URL
    // уже выбраны резолвером маршрута по схеме цели).
    const proxyProfile = proxyProfileOf(this.#proxy, route.profile);
    const targetProfile = this.profileFor(target);
    const proxy = this.#proxyAgent(
      target,
      proxyProfile?.name ?? route.profile ?? 'default',
      route.proxyUrl,
      route.credentials,
      proxyProfile?.tls,
      targetProfile,
    );
    reporter?.('proxy');
    return this.#dispatchViaProxy(
      proxy,
      opts,
      handler,
      reporter,
      route.proxyUrl,
      route.credentials !== undefined,
    );
  }

  /** TLS-опции соединения с целью по умолчанию (CA/mTLS из `security.tls`). */
  get requestTlsOptions(): EgressDispatcherTls {
    return { ...this.#defaultTls };
  }

  /** TLS-опции профиля для origin (для тестов/диагностики). */
  requestTlsFor(origin: string | URL): EgressDispatcherTls {
    return { ...this.profileFor(origin).tls };
  }

  async close(callback?: () => void): Promise<void> {
    await this.#closeAll('close');
    callback?.();
  }

  async destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const cb = typeof errOrCallback === 'function' ? errOrCallback : callback;
    await this.#closeAll('destroy', err);
    cb?.();
  }

  /** Планируемый маршрут (публичный, для тестов/диагностики). */
  plannedVia(origin: string | URL): EgressVia {
    return this.routeFor(origin);
  }

  /** Прямой агент для `origin+profile` (кэш на время жизни процесса). */
  #directFor(origin: string | URL | undefined): Agent {
    const profile = origin === undefined ? this.profileFor('') : this.profileFor(origin);
    const originKey = origin === undefined ? '' : typeof origin === 'string' ? origin : origin.origin;
    const key = `${originKey}|${profile.id}`;
    const cached = this.#directAgents.get(key);
    if (cached) return cached;
    const agent = new Agent({ connect: connectOptions(profile.tls) });
    this.#directAgents.set(key, agent);
    return agent;
  }

  /**
   * Прокси-агент для `origin + профиль + proxy URL + auth + target TLS профиль`
   * (кэш на время жизни процесса). Агенты разных профилей/кред/TLS не смешиваются.
   */
  #proxyAgent(
    origin: string | URL,
    proxyProfileName: string,
    proxyUrl: string,
    credentials: ProxyCredentials | undefined,
    proxyTlsProfile: ResolvedProxyTls | undefined,
    targetProfile: EgressTlsProfile,
  ): Dispatcher {
    // Auth fingerprint — хеш (не длина пароля): смена пароля той же длины
    // не должна переиспользовать старый агент.
    const authKey = credentials
      ? createHash('sha256')
          .update(`${credentials.username}:${credentials.password}`, 'utf8')
          .digest('hex')
      : 'anon';
    const key = [
      originKeyOf(origin),
      proxyProfileName,
      proxyUrl,
      authKey,
      targetProfile.id,
    ].join('|');
    const cached = this.#proxies.get(key);
    if (cached) return cached;

    // D2b: SOCKS5 — отдельный агент undici (username/password по RFC 1929).
    // Известное ограничение: Socks5ProxyAgent не принимает `requestTls` —
    // TLS к цели остаётся системным (поведение прежнее); `profile.tls`
    // несовместим с socks5 и отклоняется резолвером конфигурации.
    if (isSocksProxyProtocol(safeProtocol(proxyUrl))) {
      const socks = new Socks5ProxyAgent(proxyUrl, {
        ...(credentials ? { username: credentials.username, password: credentials.password } : {}),
        connectTimeout: this.#proxy.connectTimeoutMs,
      });
      this.#proxies.set(key, socks);
      return socks;
    }

    // TLS/mTLS к **прокси** — из профиля (для synthetic legacy-default это
    // `config.tls`, уже перенесённый в профиль резолвером). Target TLS — ниже.
    const proxyTls: ResolvedProxyTls = proxyTlsProfile ?? { rejectUnauthorized: true };
    const agent = new ProxyAgent({
      uri: proxyUrl,
      // TLS к **цели** — доверие `security.tls` выбранного профиля (CA/mTLS).
      requestTls: targetProfile.tls,
      // TLS/mTLS к самому прокси (профиль прокси); https-прокси.
      proxyTls: proxyTls as unknown as Record<string, unknown>,
      // Соединение с прокси — только таймаут; target-CA/mTLS сюда не попадают.
      connect: { timeout: this.#proxy.connectTimeoutMs },
      // Basic — именно `token` (undici кладёт `Proxy-Authorization` сразу
      // в CONNECT-заголовки; `auth`/ручной заголовок запрещены undici).
      ...(credentials
        ? { token: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}` }
        : {}),
    });
    this.#proxies.set(key, agent);
    return agent;
  }

  /**
   * Диспатч через прокси с обработкой недоступности: ошибка до получения
   * заголовков ответа → `EGRESS_PROXY_UNAVAILABLE`; при `fallbackDirect` —
   * повтор напрямую (только явный opt-in), `via:'fallback'`.
   */
  #dispatchViaProxy(
    proxy: Dispatcher,
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
    reporter: EgressViaReporter | undefined,
    proxyUrl: string,
    hasCredentials: boolean,
  ): boolean {
    let headersReceived = false;

    const wrapped: Dispatcher.DispatchHandler = {
      onRequestStart: (controller, context) => {
        handler.onRequestStart?.(controller, context);
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) => {
        handler.onRequestUpgrade?.(controller, statusCode, headers, socket);
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        headersReceived = true;
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (controller, chunk) => {
        handler.onResponseData?.(controller, chunk);
      },
      onResponseEnd: (controller, trailers) => {
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (controller, error) => {
        if (
          !headersReceived &&
          this.#handleProxyFailure(error, opts, handler, reporter, proxyUrl, hasCredentials, {
            style: 'response',
            controller,
          })
        ) {
          return;
        }
        handler.onResponseError?.(controller, error);
      },
      onConnect: (abort) => {
        handler.onConnect?.(abort);
      },
      onUpgrade: (statusCode, headers, socket) => {
        handler.onUpgrade?.(statusCode, headers, socket);
      },
      onResponseStarted: () => {
        handler.onResponseStarted?.();
      },
      onHeaders: (statusCode, headers, resume, statusText) => {
        headersReceived = true;
        return handler.onHeaders?.(statusCode, headers, resume, statusText) ?? false;
      },
      onData: (chunk) => {
        return handler.onData?.(chunk) ?? true;
      },
      onComplete: (trailers) => {
        handler.onComplete?.(trailers);
      },
      onError: (error) => {
        if (
          !headersReceived &&
          this.#handleProxyFailure(error, opts, handler, reporter, proxyUrl, hasCredentials, {
            style: 'error',
          })
        ) {
          return;
        }
        handler.onError?.(error);
      },
      onBodySent: (chunkSize, totalBytesSent) => {
        handler.onBodySent?.(chunkSize, totalBytesSent);
      },
    };

    try {
      return proxy.dispatch(opts, wrapped);
    } catch (err) {
      // Синхронный throw (недоступность прокси обычно приходит асинхронно):
      // сообщаем хендлеру в его контракте, а не проглатываем.
      if (
        this.#handleProxyFailure(err, opts, handler, reporter, proxyUrl, hasCredentials, {
          style: 'response',
        })
      ) {
        return true;
      }
      throw err;
    }
  }

  /**
   * Сообщает хендлеру о недоступности прокси в **его** протоколе:
   * new-style (`onResponseError(controller, err)`) либо legacy (`onError(err)`).
   * Возвращает `true`, если ошибка доставлена/обработана fallback'ом.
   */
  #handleProxyFailure(
    error: unknown,
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
    reporter: EgressViaReporter | undefined,
    proxyUrl: string,
    hasCredentials: boolean,
    delivery: { style: 'response' | 'error'; controller?: Dispatcher.DispatchController },
  ): boolean {
    const reason = error instanceof Error ? error.message : String(error);
    // D2a/D2b: 407 (HTTP) или отказ SOCKS5-аутентификации — direct-фоллбек
    // запрещён даже при fallbackDirect.
    if (isProxyAuthFailure(error) || isSocksAuthFailure(error)) {
      const authError = new EgressProxyAuthError(
        hasCredentials ? 'EGRESS_PROXY_AUTH_FAILED' : 'EGRESS_PROXY_AUTH_REQUIRED',
        hasCredentials
          ? `Прокси ${redactProxyUrl(proxyUrl)} отклонил учётные данные (407)`
          : `Прокси ${redactProxyUrl(proxyUrl)} требует аутентификации (407)`,
        { cause: error },
      );
      this.#deliverProxyError(authError, handler, delivery);
      return true;
    }
    if (this.#proxy.fallbackDirect) {
      this.#warn(
        `[egress] прокси ${redactProxyUrl(proxyUrl)} недоступен (${reason}); ` +
          'fallbackDirect=true → прямое соединение',
      );
      reporter?.('fallback');
      this.#directFor(opts.origin).dispatch(opts, handler);
      return true;
    }
    const unavailable = new EgressProxyUnavailableError(
      `Прокси ${redactProxyUrl(proxyUrl)} недоступен: ${reason}`,
      { cause: error },
    );
    this.#deliverProxyError(unavailable, handler, delivery);
    return true;
  }

  /**
   * Доставляет ошибку прокси в контракте хендлера: legacy → `onError`,
   * new-style → `onResponseError(controller, err)`. При синхронном throw
   * controller ещё нет — отдаём безопасную заглушку (запрос не стартовал).
   */
  #deliverProxyError(
    error: Error,
    handler: Dispatcher.DispatchHandler,
    delivery: { style: 'response' | 'error'; controller?: Dispatcher.DispatchController },
  ): void {
    const controller = delivery.controller ?? failedDispatchController(error);
    if (delivery.style === 'response' && typeof handler.onResponseError === 'function') {
      handler.onResponseError(controller, error);
      return;
    }
    if (typeof handler.onError === 'function') {
      handler.onError(error);
      return;
    }
    // Хендлер реализует только новый контракт, а транспорт сообщил legacy-ошибку.
    handler.onResponseError?.(controller, error);
  }

  async #closeAll(kind: 'close' | 'destroy', err?: Error | null): Promise<void> {
    const targets: Dispatcher[] = [...this.#directAgents.values(), ...this.#proxies.values()];
    this.#directAgents.clear();
    this.#proxies.clear();
    await Promise.allSettled(
      targets.map((target) => (kind === 'close' ? target.close() : err ? target.destroy(err) : target.destroy())),
    );
  }
}

/**
 * Заглушка `DispatchController` для синхронного throw: запрос ещё не стартовал,
 * отменять нечего. Нужна, чтобы new-style хендлер получил ошибку в своём
 * контракте и не «завис».
 */
function failedDispatchController(error: Error): Dispatcher.DispatchController {
  return {
    aborted: true,
    paused: false,
    reason: error,
    abort() {},
    pause() {},
    resume() {},
  };
}

/** TLS-опции undici `Agent({ connect })` из профиля. */
function connectOptions(tls: EgressDispatcherTls): Record<string, unknown> {
  return {
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
  };
}

/** Hostname origin/URL без исключения. */
function hostOf(origin: string | URL): string | undefined {
  try {
    return (typeof origin === 'string' ? new URL(origin) : origin).hostname;
  } catch {
    return undefined;
  }
}

/** Протокол URL без исключения. */
function safeProtocol(raw: string): string {
  try {
    return new URL(raw).protocol;
  } catch {
    return '';
  }
}

/** Безопасно строит URL из `origin`+`path` (путь может быть абсолютным). */
function safeUrl(origin: string | URL, path: string): URL | null {
  try {
    return new URL(path, typeof origin === 'string' ? origin : origin.toString());
  } catch {
    return null;
  }
}

/** Ключ origin для кэша агентов (`scheme://host:port`); невалидный — как есть. */
function originKeyOf(origin: string | URL): string {
  try {
    return typeof origin === 'string' ? new URL(origin).origin : origin.origin;
  } catch {
    return typeof origin === 'string' ? origin : '';
  }
}

/** Реэкспорт политики маршрута (для egress-guard/тестов). */
export { shouldProxyUrl } from './proxy-state.js';

/** Тип маршрута для журнала egress. */
export type { EgressVia };
