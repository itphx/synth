/**
 * Минимальный клиент Kubernetes API (PROP-135, Ф4b-2b).
 *
 * Только то, что нужно провайдеру пулов: поды и секреты в **своём** namespace.
 * Без новых зависимостей — `node:https`/`node:http` и `fetch` не нужны:
 *
 * - `fetch` в Node 22 не принимает CA напрямую (нужен `undici`-dispatcher, а
 *   `undici` — не гарантированная зависимость пакета);
 * - `node:https.request` понимает `ca` и даёт явный контроль над таймаутом.
 *
 * Аутентификация — projected ServiceAccount-токен из файла (Kubernetes сам
 * ротирует его, поэтому файл читается на **каждый** запрос, а не один раз при
 * старте). Токен передаётся только в заголовке `Authorization` и **никогда**
 * не попадает в текст ошибок и логи.
 *
 * ## Ошибки
 *
 * | Ответ API | Поведение |
 * |---|---|
 * | `2xx` | тело ответа |
 * | `404` | `null` (для `get*`), no-op (для `delete*`) |
 * | `409` (create) | `false` — «объект уже есть» (adopt/идемпотентность) |
 * | прочее | `PoolProvisionerError('provider_error', …)` с кодом и сообщением API |
 * | сеть/таймаут/TLS | `PoolProvisionerError('provider_error', …)` без токена |
 */

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PoolProvisionerError } from './errors.js';

/** Таймаут одного запроса к API по умолчанию, мс. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Условие пода (`status.conditions`). */
export interface KubernetesPodCondition {
  type?: string;
  status?: string;
}

/** Состояние контейнера пода (`status.containerStatuses`). */
export interface KubernetesContainerStatus {
  name?: string;
  ready?: boolean;
}

/** Под (только используемые поля). */
export interface KubernetesPod {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** Задан — под удаляется (terminating): ресурс уже не годится в пул. */
    deletionTimestamp?: string;
  };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: KubernetesPodCondition[];
    containerStatuses?: KubernetesContainerStatus[];
  };
}

/** Список подов (`GET /api/v1/namespaces/{ns}/pods`). */
export interface KubernetesPodList {
  items?: KubernetesPod[];
}

/** Секрет (`GET /api/v1/namespaces/{ns}/secrets/{name}`). */
export interface KubernetesSecret {
  metadata?: { name?: string; namespace?: string };
  type?: string;
  /** base64-значения (как их отдаёт API). */
  data?: Record<string, string>;
}

/**
 * DaemonSet (прогрев образов) — только используемые поля.
 *
 * `numberReady`/`desiredNumberScheduled` — готовность подов на нодах: прогрев
 * считается успешным, когда `numberReady >= desiredNumberScheduled`.
 */
export interface KubernetesDaemonSet {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** Задан — объект удаляется (terminating). */
    deletionTimestamp?: string;
  };
  status?: {
    numberReady?: number;
    desiredNumberScheduled?: number;
    numberUnavailable?: number;
  };
}

/** Манифест Kubernetes-объекта (под/секрет) — как есть, без типизации всех полей. */
export type KubernetesManifest = Record<string, unknown>;

/**
 * Шов клиента: провайдер зависит от интерфейса, поэтому тесты подставляют
 * in-memory реализацию, не поднимая TLS-сервер.
 */
export interface KubernetesClient {
  /** Поды по label selector (уже закодированному или в форме `k=v,…`). */
  listPods(labelSelector: string): Promise<KubernetesPod[]>;
  /** Под по имени либо `null` (404). */
  getPod(name: string): Promise<KubernetesPod | null>;
  /**
   * Создать под.
   *
   * @returns `true` — создан, `false` — уже существует (409, adopt)
   */
  createPod(manifest: KubernetesManifest): Promise<boolean>;
  /** Удалить под; 404 — no-op. */
  deletePod(name: string, graceSeconds: number): Promise<void>;
  /**
   * Создать секрет.
   *
   * @returns `true` — создан, `false` — уже существует (409; значение читается
   * через `getSecret`, чтобы вернуть актуальный токен)
   */
  createSecret(manifest: KubernetesManifest): Promise<boolean>;
  /** Секрет по имени либо `null` (404). */
  getSecret(name: string): Promise<KubernetesSecret | null>;
  /** Удалить секрет; 404 — no-op. */
  deleteSecret(name: string): Promise<void>;
  /**
   * Создать DaemonSet (прогрев образа).
   *
   * @returns `true` — создан, `false` — уже существует (409)
   */
  createDaemonSet(manifest: KubernetesManifest): Promise<boolean>;
  /** DaemonSet по имени либо `null` (404). */
  getDaemonSet(name: string): Promise<KubernetesDaemonSet | null>;
  /** Удалить DaemonSet; 404 — no-op. */
  deleteDaemonSet(name: string): Promise<void>;
}

/** Параметры HTTP-клиента Kubernetes API. */
export interface HttpKubernetesClientOptions {
  /** Адрес API (`https://kubernetes.default.svc` либо http для тестов). */
  apiServer: string;
  /** Namespace подов и секретов. */
  namespace: string;
  /** Файл токена ServiceAccount. */
  tokenFile: string;
  /** Файл CA API-сервера (используется только для https). */
  caFile: string;
  /** Таймаут одного запроса, мс (по умолчанию 15 с). */
  requestTimeoutMs?: number;
}

/** Ответ API: код и разобранное тело. */
interface KubernetesResponse {
  status: number;
  body: unknown;
}

/** Сообщение API из тела ошибки (`message`/`reason`), без секретов. */
function apiErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    if (message !== '' && reason !== '') return `${reason}: ${message}`;
    if (message !== '') return message;
    if (reason !== '') return reason;
  }
  return 'без описания';
}

/**
 * HTTP-клиент Kubernetes API.
 *
 * Namespace фиксирован при создании: провайдер пулов работает только в своём
 * namespace (RBAC чарта это и предполагает), поэтому пути собираются здесь, а
 * не приходят снаружи.
 */
export class HttpKubernetesClient implements KubernetesClient {
  private readonly _apiServer: string;
  private readonly _namespace: string;
  private readonly _tokenFile: string;
  private readonly _caFile: string;
  private readonly _timeoutMs: number;

  constructor(opts: HttpKubernetesClientOptions) {
    this._apiServer = opts.apiServer.replace(/\/+$/, '');
    this._namespace = opts.namespace;
    this._tokenFile = opts.tokenFile;
    this._caFile = opts.caFile;
    this._timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async listPods(labelSelector: string): Promise<KubernetesPod[]> {
    const query = labelSelector === '' ? '' : `?labelSelector=${encodeURIComponent(labelSelector)}`;
    const response = await this._request('GET', this._podsPath(query));
    const list = response.body as KubernetesPodList | null;
    return Array.isArray(list?.items) ? list.items : [];
  }

  async getPod(name: string): Promise<KubernetesPod | null> {
    const response = await this._request('GET', `${this._podsPath()}/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    return (response.body as KubernetesPod | null) ?? null;
  }

  async createPod(manifest: KubernetesManifest): Promise<boolean> {
    const response = await this._request('POST', this._podsPath(), manifest);
    return response.status !== 409;
  }

  async deletePod(name: string, graceSeconds: number): Promise<void> {
    const grace = Math.max(0, Math.trunc(graceSeconds));
    const response = await this._request(
      'DELETE',
      `${this._podsPath()}/${encodeURIComponent(name)}?gracePeriodSeconds=${grace}`,
    );
    // 404 — уже удалён: удаление идемпотентно.
    if (response.status !== 404 && response.status >= 300) {
      throw new PoolProvisionerError(
        'provider_error',
        `Kubernetes API DELETE pod "${name}": ${response.status} ${apiErrorMessage(response.body)}`,
      );
    }
  }

  async createSecret(manifest: KubernetesManifest): Promise<boolean> {
    const response = await this._request('POST', this._secretsPath(), manifest);
    return response.status !== 409;
  }

  async getSecret(name: string): Promise<KubernetesSecret | null> {
    const response = await this._request(
      'GET',
      `${this._secretsPath()}/${encodeURIComponent(name)}`,
    );
    if (response.status === 404) return null;
    return (response.body as KubernetesSecret | null) ?? null;
  }

  async deleteSecret(name: string): Promise<void> {
    const response = await this._request(
      'DELETE',
      `${this._secretsPath()}/${encodeURIComponent(name)}`,
    );
    if (response.status !== 404 && response.status >= 300) {
      throw new PoolProvisionerError(
        'provider_error',
        `Kubernetes API DELETE secret "${name}": ${response.status} ${apiErrorMessage(response.body)}`,
      );
    }
  }

  async createDaemonSet(manifest: KubernetesManifest): Promise<boolean> {
    const response = await this._request('POST', this._daemonSetsPath(), manifest);
    return response.status !== 409;
  }

  async getDaemonSet(name: string): Promise<KubernetesDaemonSet | null> {
    const response = await this._request(
      'GET',
      `${this._daemonSetsPath()}/${encodeURIComponent(name)}`,
    );
    if (response.status === 404) return null;
    return (response.body as KubernetesDaemonSet | null) ?? null;
  }

  async deleteDaemonSet(name: string): Promise<void> {
    const response = await this._request(
      'DELETE',
      `${this._daemonSetsPath()}/${encodeURIComponent(name)}`,
    );
    // 404 — уже удалён: удаление идемпотентно.
    if (response.status !== 404 && response.status >= 300) {
      throw new PoolProvisionerError(
        'provider_error',
        `Kubernetes API DELETE daemonset "${name}": ${response.status} ${apiErrorMessage(response.body)}`,
      );
    }
  }

  /** Путь списка подов (`query` — уже с `?`). */
  private _podsPath(query = ''): string {
    return `/api/v1/namespaces/${encodeURIComponent(this._namespace)}/pods${query}`;
  }

  /** Путь списка секретов. */
  private _secretsPath(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this._namespace)}/secrets`;
  }

  /** Путь DaemonSet'ов (`apps/v1` — отдельная группа API). */
  private _daemonSetsPath(): string {
    return `/apis/apps/v1/namespaces/${encodeURIComponent(this._namespace)}/daemonsets`;
  }

  /**
   * Один запрос к API.
   *
   * 404 и 409 не считаются ошибкой транспорта: их обрабатывают методы
   * (идемпотентность/`adopt`). Остальные не-2xx — `provider_error`.
   */
  private async _request(
    method: string,
    path: string,
    body?: KubernetesManifest,
  ): Promise<KubernetesResponse> {
    const token = await this._readToken();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    const response = await this._send(method, path, headers, payload);
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status === 404 || response.status === 409) return response;
    throw new PoolProvisionerError(
      'provider_error',
      `Kubernetes API ${method} ${path}: ${response.status} ${apiErrorMessage(response.body)}`,
    );
  }

  /** Прочитать токен ServiceAccount (значение не логируется и не кэшируется). */
  private async _readToken(): Promise<string> {
    let token: string;
    try {
      token = (await readFile(this._tokenFile, 'utf8')).trim();
    } catch {
      throw new PoolProvisionerError(
        'provider_error',
        `не удалось прочитать токен ServiceAccount (${this._tokenFile}) — ` +
          'проверьте монтирование projected-токена',
      );
    }
    if (token === '') {
      throw new PoolProvisionerError(
        'provider_error',
        `файл токена ServiceAccount пуст (${this._tokenFile})`,
      );
    }
    return token;
  }

  /** CA API-сервера (только для https): доверие задаётся явно, fail-closed. */
  private async _readCa(): Promise<string> {
    try {
      const ca = await readFile(this._caFile, 'utf8');
      if (ca.trim() === '') throw new Error('empty');
      return ca;
    } catch {
      throw new PoolProvisionerError(
        'provider_error',
        `не удалось прочитать CA Kubernetes API (${this._caFile}) — ` +
          'доверие TLS задаётся явно (fail-closed)',
      );
    }
  }

  /** Отправка запроса через `node:https`/`node:http`. */
  private async _send(
    method: string,
    path: string,
    headers: Record<string, string>,
    payload: string | undefined,
  ): Promise<KubernetesResponse> {
    const url = new URL(`${this._apiServer}${path}`);
    const isHttps = url.protocol === 'https:';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PoolProvisionerError(
        'provider_error',
        `неподдерживаемая схема адреса Kubernetes API: "${url.protocol}"`,
      );
    }
    const ca = isHttps ? await this._readCa() : undefined;

    return new Promise<KubernetesResponse>((resolve, reject) => {
      const send = isHttps ? httpsRequest : httpRequest;
      const req = send(
        {
          method,
          hostname: url.hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          headers,
          ...(ca !== undefined ? { ca } : {}),
          timeout: this._timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', (err: Error) => {
            reject(
              new PoolProvisionerError(
                'provider_error',
                `Kubernetes API ${method} ${path}: ответ прерван (${err.message})`,
                { cause: err },
              ),
            );
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            if (text.trim() !== '') {
              try {
                parsed = JSON.parse(text) as unknown;
              } catch {
                parsed = { message: text.slice(0, 512) };
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(
          new PoolProvisionerError(
            'provider_error',
            `Kubernetes API ${method} ${path}: таймаут ${this._timeoutMs} мс`,
          ),
        );
      });
      req.on('error', (err: Error) => {
        reject(
          err instanceof PoolProvisionerError
            ? err
            : new PoolProvisionerError(
                'provider_error',
                `Kubernetes API ${method} ${path}: ${err.message}`,
                { cause: err },
              ),
        );
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
