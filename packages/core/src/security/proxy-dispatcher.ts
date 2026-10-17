/**
 * ADR-099 (этап D1): единый undici-dispatcher с HTTP/HTTPS-прокси.
 *
 * `EgressDispatcher` — `undici.Dispatcher`, который для каждого запроса выбирает
 * маршрут:
 * - `proxy.enabled` + `noProxy` не матчит хост → `ProxyAgent` (кэш по
 *   `origin+proxy`), иначе — прямой `Agent`;
 * - TLS-доверие к цели — `requestTls` из `security.tls` (CA/mTLS), к самому
 *   прокси — `proxyTls` (задел D2 для https-прокси/аутентификации);
 * - недоступный прокси → `EgressProxyUnavailableError` (`EGRESS_PROXY_UNAVAILABLE`),
 *   без тихого direct; `fallbackDirect` — только явный opt-in с warn и
 *   `via:'fallback'`.
 *
 * Модуль тянет `undici` статически, поэтому `security/tls.ts` импортирует его
 * **динамически** — при конфигурации без прокси/доверия пакет не грузится.
 */
import { Agent, Dispatcher, ProxyAgent } from 'undici';
import {
  NoProxyMatcher,
  proxyUrlFor,
  redactProxyUrl,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import { EGRESS_VIA, type EgressVia, type EgressViaReporter } from './proxy-state.js';

/** Ошибка недоступности прокси (fail-closed: direct молча не выполняется). */
export class EgressProxyUnavailableError extends Error {
  readonly code = 'EGRESS_PROXY_UNAVAILABLE';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EgressProxyUnavailableError';
  }
}

/** TLS-опции соединения (совместимы с `undici` `connect`/`requestTls`). */
export interface EgressDispatcherTls {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface EgressDispatcherOptions {
  proxy: ResolvedProxyConfig;
  tls?: EgressDispatcherTls;
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
  readonly #matcher: NoProxyMatcher;
  readonly #direct: Agent;
  readonly #proxies = new Map<string, ProxyAgent>();
  readonly #requestTls: EgressDispatcherTls;
  readonly #warn: (message: string) => void;

  constructor(options: EgressDispatcherOptions) {
    super();
    this.#proxy = options.proxy;
    this.#matcher = new NoProxyMatcher(options.proxy.noProxy);
    this.#requestTls = options.tls ?? { rejectUnauthorized: true };
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#direct = new Agent({ connect: this.#connectOptions() });
  }

  /** Планируемый маршрут для origin (без учёта fallback). */
  routeFor(origin: string | URL): 'proxy' | 'direct' {
    if (!this.#proxy.enabled) return 'direct';
    let url: URL;
    try {
      url = typeof origin === 'string' ? new URL(origin) : origin;
    } catch {
      return 'direct';
    }
    if (proxyUrlFor(this.#proxy, url) === undefined) return 'direct';
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return this.#matcher.matches(url.hostname, port) ? 'direct' : 'proxy';
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const reporter = (opts as ViaOptions)[EGRESS_VIA];
    const origin = opts.origin;
    if (origin === undefined) return this.#direct.dispatch(opts, handler);

    const url = safeUrl(origin, opts.path);
    if (this.routeFor(url ?? origin) === 'direct') {
      reporter?.('direct');
      return this.#direct.dispatch(opts, handler);
    }

    const proxyUrl = url ? proxyUrlFor(this.#proxy, url) : undefined;
    if (proxyUrl === undefined) {
      reporter?.('direct');
      return this.#direct.dispatch(opts, handler);
    }

    const proxy = this.#proxyAgent(origin, proxyUrl);
    reporter?.('proxy');
    return this.#dispatchViaProxy(proxy, opts, handler, reporter, proxyUrl);
  }

  /** TLS-опции соединения с целью (CA/mTLS из `security.tls`). */
  get requestTlsOptions(): EgressDispatcherTls {
    return { ...this.#requestTls };
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

  /** Прокси-агент для пары `origin+proxy` (кэш на время жизни процесса). */
  #proxyAgent(origin: string | URL, proxyUrl: string): ProxyAgent {
    const key = `${typeof origin === 'string' ? origin : origin.origin}|${proxyUrl}`;
    const cached = this.#proxies.get(key);
    if (cached) return cached;
    const agent = new ProxyAgent({
      uri: proxyUrl,
      // TLS к **цели** — доверие `security.tls` (CA/mTLS).
      requestTls: this.#requestTls,
      // Соединение с прокси — только таймаут; target-CA/mTLS сюда не попадают.
      connect: { timeout: this.#proxy.connectTimeoutMs },
      // Задел D2: TLS к https-прокси (`proxyTls`) — системное доверие по умолчанию.
    });
    this.#proxies.set(key, agent);
    return agent;
  }

  #connectOptions(): Record<string, unknown> {
    return {
      ca: this.#requestTls.ca,
      cert: this.#requestTls.cert,
      key: this.#requestTls.key,
      rejectUnauthorized: this.#requestTls.rejectUnauthorized ?? true,
    };
  }

  /**
   * Диспатч через прокси с обработкой недоступности: ошибка до получения
   * заголовков ответа → `EGRESS_PROXY_UNAVAILABLE`; при `fallbackDirect` —
   * повтор напрямую (только явный opt-in), `via:'fallback'`.
   */
  #dispatchViaProxy(
    proxy: ProxyAgent,
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
    reporter: EgressViaReporter | undefined,
    proxyUrl: string,
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
          this.#handleProxyFailure(error, opts, handler, reporter, proxyUrl, {
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
          this.#handleProxyFailure(error, opts, handler, reporter, proxyUrl, { style: 'error' })
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
      if (this.#handleProxyFailure(err, opts, handler, reporter, proxyUrl, { style: 'response' })) {
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
    delivery: { style: 'response' | 'error'; controller?: Dispatcher.DispatchController },
  ): boolean {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.#proxy.fallbackDirect) {
      this.#warn(
        `[egress] прокси ${redactProxyUrl(proxyUrl)} недоступен (${reason}); ` +
          'fallbackDirect=true → прямое соединение',
      );
      reporter?.('fallback');
      this.#direct.dispatch(opts, handler);
      return true;
    }
    const unavailable = new EgressProxyUnavailableError(
      `Прокси ${redactProxyUrl(proxyUrl)} недоступен: ${reason}`,
      { cause: error },
    );
    // Приводим доставку к контракту хендлера: legacy → onError, new-style →
    // onResponseError(controller, err). При синхронном throw controller ещё нет —
    // отдаём безопасную заглушку (запрос не стартовал).
    const respondWithError = (): void => {
      const controller = delivery.controller ?? failedDispatchController(unavailable);
      if (delivery.style === 'response' && typeof handler.onResponseError === 'function') {
        handler.onResponseError(controller, unavailable);
        return;
      }
      if (typeof handler.onError === 'function') {
        handler.onError(unavailable);
        return;
      }
      // Хендлер реализует только новый контракт, а транспорт сообщил legacy-ошибку.
      handler.onResponseError?.(controller, unavailable);
    };
    respondWithError();
    return true;
  }

  async #closeAll(kind: 'close' | 'destroy', err?: Error | null): Promise<void> {
    const targets: Array<Agent | ProxyAgent> = [this.#direct, ...this.#proxies.values()];
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

/** Безопасно строит URL из `origin`+`path` (путь может быть абсолютным). */
function safeUrl(origin: string | URL, path: string): URL | null {
  try {
    return new URL(path, typeof origin === 'string' ? origin : origin.toString());
  } catch {
    return null;
  }
}

/** Реэкспорт политики маршрута (для egress-guard/тестов). */
export { shouldProxyUrl } from './proxy-state.js';

/** Тип маршрута для журнала egress. */
export type { EgressVia };
