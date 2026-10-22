/**
 * PROP-090 §«out-of-process»: клиент удалённого процесса плагина (Ф4б-1).
 *
 * Транспорт — HTTP/1.1 + JSON, контракт — `@itphx/synth-shared`
 * (`types/plugin-protocol.ts`): `GET /health` (без токена), `GET /capabilities`,
 * `POST /invoke`. Образец — клиент исполнителя (`packages/executor/src/client.ts`,
 * ADR-077).
 *
 * **Только loopback.** Адрес процесса обязан быть `http://127.0.0.1:<port>`,
 * `http://[::1]:<port>` или `http://localhost:<port>`: внешний хост — отказ
 * (`connection_failed`). Плагин `out-of-process` — локальный процесс, а не
 * сетевой сервис: `egress`-политика и прокси к нему не применяются.
 *
 * **Токен.** Bearer-токен приходит из файла (`{dataDir}/secrets/plugin-token`,
 * Ф4б-2) и **никогда** не попадает в `message` ошибки и в логи: тексты,
 * полученные от процесса, проходят через редактирование (`***`).
 *
 * **Fail-closed.** Не-2xx — ошибка с причиной из тела (`{error:{reason,…}}`)
 * либо выведенной из HTTP-статуса; сетевой сбой — `connection_failed`,
 * таймаут — `timeout`. Молчаливой деградации «работаем без плагина» нет.
 */
import {
  PLUGIN_PROTOCOL_PATHS,
  PLUGIN_PROTOCOL_VERSION,
  checkPluginCapabilities,
  isPluginProtocolErrorReason,
} from '@itphx/synth-shared';
import type {
  PluginCapabilities,
  PluginInvokeRequest,
  PluginProtocolErrorReason,
  PluginProtocolPoint,
} from '@itphx/synth-shared';

/** Транспорт клиента (совместим с глобальным `fetch`; для тестов — инъекция). */
export type RemotePluginFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Таймаут одного вызова по умолчанию, мс. */
export const DEFAULT_REMOTE_PLUGIN_TIMEOUT_MS = 5_000;

/** Допустимые хосты процесса плагина (только loopback). */
export const LOOPBACK_PLUGIN_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

/** Причина недоступности удалённого плагина: протокольная или сетевая. */
export type RemotePluginUnavailableReason =
  | PluginProtocolErrorReason
  | 'connection_failed';

/** Опции клиента удалённого плагина. */
export interface RemotePluginClientOptions {
  /** Базовый URL (только `http://127.0.0.1:<port>`; иное — отказ). */
  baseUrl: string;
  /** Bearer-токен (из файла; не логируется). */
  token: string;
  /** Таймаут одного вызова, мс (по умолчанию 5 000). */
  timeoutMs?: number;
  /** Инъекция fetch — тесты. */
  fetch?: RemotePluginFetch;
  /** Имя плагина (сверяется с `/capabilities`). */
  name: string;
  /** Версия плагина (сверяется с `/capabilities`). */
  version: string;
}

/**
 * Удалённый плагин недоступен или ответил отказом.
 *
 * `reason` — причина протокола (`invalid_request`/`unknown_point`/… ) либо
 * `connection_failed` (сеть, не-loopback адрес, конфигурация клиента).
 * `status` — HTTP-статус ответа (если ответ был).
 */
export class RemotePluginUnavailableError extends Error {
  readonly reason: RemotePluginUnavailableReason;
  readonly status?: number;

  constructor(
    message: string,
    reason: RemotePluginUnavailableReason = 'connection_failed',
    status?: number,
  ) {
    super(message);
    this.name = 'RemotePluginUnavailableError';
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

/** Клиент удалённого процесса плагина (`out-of-process`). */
export class RemotePluginClient {
  private readonly _baseUrl: string;
  private readonly _token: string;
  private readonly _timeoutMs: number;
  private readonly _fetch: RemotePluginFetch;
  private readonly _name: string;
  private readonly _version: string;

  constructor(options: RemotePluginClientOptions) {
    this._baseUrl = resolveLoopbackBaseUrl(options.baseUrl);

    const token = typeof options.token === 'string' ? options.token : '';
    if (token.trim().length === 0) {
      throw new RemotePluginUnavailableError(
        'токен доступа к процессу плагина не задан — вызов запрещён (fail-closed).',
        'connection_failed',
      );
    }
    this._token = token;

    if (options.timeoutMs !== undefined) {
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new RemotePluginUnavailableError(
          'таймаут вызова плагина должен быть целым числом > 0 мс.',
          'connection_failed',
        );
      }
    }
    this._timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_PLUGIN_TIMEOUT_MS;

    if (!isNonEmptyString(options.name) || !isNonEmptyString(options.version)) {
      throw new RemotePluginUnavailableError(
        'не заданы имя/версия плагина для сверки с /capabilities.',
        'connection_failed',
      );
    }
    this._name = options.name;
    this._version = options.version;

    this._fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** `GET /health` (без токена) — процесс жив. */
  async health(): Promise<boolean> {
    try {
      const response = await this._request(PLUGIN_PROTOCOL_PATHS.health, {
        method: 'GET',
        auth: false,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** `GET /capabilities` + проверка версии протокола и имени/версии плагина. */
  async capabilities(): Promise<PluginCapabilities> {
    const response = await this._request(PLUGIN_PROTOCOL_PATHS.capabilities, {
      method: 'GET',
      auth: true,
    });
    if (!response.ok) throw await this._errorFromResponse(response);

    const payload = await this._readJson(response);
    const check = checkPluginCapabilities(payload, {
      name: this._name,
      version: this._version,
    });
    if (!check.ok) {
      throw new RemotePluginUnavailableError(
        this._safe(`ответ /capabilities не принят: ${check.message}`),
        check.reason,
      );
    }
    return check.capabilities;
  }

  /** `POST /invoke` — результат точки расширения или `RemotePluginUnavailableError`. */
  async invoke(point: PluginProtocolPoint, id: string, input: unknown): Promise<unknown> {
    const body: PluginInvokeRequest = {
      protocol: PLUGIN_PROTOCOL_VERSION,
      point,
      id,
      input,
    };
    const response = await this._request(PLUGIN_PROTOCOL_PATHS.invoke, {
      method: 'POST',
      auth: true,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await this._errorFromResponse(response);

    const payload = await this._readJson(response);
    if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
      throw new RemotePluginUnavailableError(
        'ответ /invoke не соответствует протоколу (нет поля ok).',
        'internal_error',
        response.status,
      );
    }
    if (payload.ok) return payload.output;

    const error = payload.error;
    if (isRecord(error) && isPluginProtocolErrorReason(error.reason)) {
      const message =
        typeof error.message === 'string' && error.message.trim().length > 0
          ? error.message
          : `точка «${point}»/${id}: отказ «${error.reason}»`;
      throw new RemotePluginUnavailableError(
        this._safe(message),
        error.reason,
        response.status,
      );
    }
    throw new RemotePluginUnavailableError(
      'ответ /invoke с ok:false не содержит корректной причины отказа.',
      'internal_error',
      response.status,
    );
  }

  // ── Транспорт ───────────────────────────────────────────────────────

  private async _request(
    path: string,
    init: { method: 'GET' | 'POST'; auth: boolean; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.auth) headers.authorization = `Bearer ${this._token}`;

    try {
      return await this._fetch(`${this._baseUrl}${path}`, {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(this._timeoutMs),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new RemotePluginUnavailableError(
          `процесс плагина не ответил за ${this._timeoutMs} мс — вызов прерван.`,
          'timeout',
        );
      }
      throw new RemotePluginUnavailableError(
        `запрос к процессу плагина не удался${networkErrorSuffix(err)}.`,
        'connection_failed',
      );
    }
  }

  private async _readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new RemotePluginUnavailableError(
        'ответ процесса плагина — не JSON.',
        'internal_error',
        response.status,
      );
    }
  }

  private async _errorFromResponse(response: Response): Promise<RemotePluginUnavailableError> {
    let reason = reasonFromStatus(response.status);
    let message = `процесс плагина ответил HTTP ${response.status}.`;

    try {
      const payload = (await response.json()) as unknown;
      if (isRecord(payload) && isRecord(payload.error)) {
        const error = payload.error;
        if (isPluginProtocolErrorReason(error.reason)) reason = error.reason;
        if (typeof error.message === 'string' && error.message.trim().length > 0) {
          message = error.message;
        } else if (typeof error.code === 'string' && error.code.length > 0) {
          message += ` (код: ${error.code})`;
        }
      }
    } catch {
      // Тело не JSON — остаётся причина по HTTP-статусу.
    }

    return new RemotePluginUnavailableError(this._safe(message), reason, response.status);
  }

  /** Убрать токен из любого текста, уходящего в `message` ошибки. */
  private _safe(text: string): string {
    return text.split(this._token).join('***');
  }
}

/**
 * Разобрать и проверить базовый адрес процесса: только `http:` и loopback.
 *
 * @throws {RemotePluginUnavailableError} `connection_failed` — адрес не URL,
 *   не `http:`, указывает на внешний хост или содержит креды/query/hash.
 */
function resolveLoopbackBaseUrl(raw: string): string {
  const base = typeof raw === 'string' ? raw.trim() : '';
  if (!base) {
    throw new RemotePluginUnavailableError(
      'адрес процесса плагина не задан — вызов запрещён (fail-closed).',
      'connection_failed',
    );
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RemotePluginUnavailableError(
      'адрес процесса плагина — не URL.',
      'connection_failed',
    );
  }

  if (url.protocol !== 'http:') {
    throw new RemotePluginUnavailableError(
      `адрес процесса плагина должен быть http:// (получено «${url.protocol}»).`,
      'connection_failed',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemotePluginUnavailableError(
      'адрес процесса плагина не должен содержать креды, query или hash.',
      'connection_failed',
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!(LOOPBACK_PLUGIN_HOSTS as readonly string[]).includes(host)) {
    throw new RemotePluginUnavailableError(
      `процесс плагина разрешён только на loopback (${LOOPBACK_PLUGIN_HOSTS.join('/')}), ` +
      `а адрес указывает на «${host}» — внешние плагины по сети не поддерживаются.`,
      'connection_failed',
    );
  }

  return url.toString().replace(/\/+$/, '');
}

/** Причина по HTTP-статусу, когда тело ответа не дало причину. */
function reasonFromStatus(status: number): RemotePluginUnavailableReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'unknown_id';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'internal_error';
  if (status >= 400) return 'invalid_request';
  return 'connection_failed';
}

/** Сбой — таймаут `AbortSignal.timeout` (или прерывание сигналом)? */
function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Короткая деталь сетевого сбоя (`ECONNREFUSED` и т. п.) — без текста запроса. */
function networkErrorSuffix(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const cause = (err as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === 'string' && cause.code.length > 0) {
    return ` (${cause.code})`;
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
