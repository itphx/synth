/**
 * Провайдеры пулов исполнения (PROP-135, Ф4b-1).
 *
 * ## Зачем
 *
 * Ф4a (роутер портов) умел выбирать порт **по профилю**: адреса исполнителей
 * известны из конфигурации, порты создаются на старте. Динамические пулы
 * (проектный/сессионный под, отдельный исполнитель на проект) требуют
 * другого: адрес пула известен **только в момент обращения** — его даёт
 * provisioner (сервис, который сам поднимает/назначает исполнителей).
 *
 * Этот модуль вводит **провайдер пулов** — источник адреса и токена пула:
 *
 * - `StaticExecutionPoolProvider` — пулы из конфигурации (адрес профиля);
 * - `HttpExecutionPoolProvider` — пулы от provisioner'а по HTTP.
 *
 * ## Ключ пула
 *
 * Ключ — **то, что различает пулы**: область (`instance`/`project`/`session`),
 * идентификатор области (id проекта/сессии; у `instance` — нет), класс
 * (`exec`/`browser`) и профиль. Строковое представление
 * (`poolKeyString`) — **канонический** идентификатор пула: он идёт в
 * provisioner по проводу и служит ключом кэша портов в роутере.
 *
 * ## Секреты
 *
 * Токен provisioner'а — **путь/ссылка**, а не значение (инвариант 13):
 * значение читается из файла (`readExecutorToken`) в момент обращения и
 * **никогда** не попадает в текст ошибок, логи и ключи пулов.
 */

import type { ResolvedExecutionRemoteConfig } from '@itphx/synth-shared';
import { egressFetch, type FetchLike } from '../security/tls.js';
import { readExecutorToken } from './remote.js';

/** Область пула: общий пул инстанса, проектный или сессионный. */
export type ExecutionPoolScope = 'instance' | 'project' | 'session';

/** Класс пула: обычные команды либо браузерная сессия. */
export type ExecutionPoolClass = 'exec' | 'browser';

/**
 * Ключ пула исполнения.
 *
 * `id` обязателен для `project`/`session` (иначе ключи разных проектов
 * совпали бы — это ломало бы изоляцию пулов).
 */
export interface ExecutionPoolKey {
  /** Область пула. */
  scope: ExecutionPoolScope;
  /** Идентификатор области (id проекта/сессии); у `instance` — нет. */
  id?: string;
  /** Класс пула. */
  class: ExecutionPoolClass;
  /** Имя профиля исполнения. */
  profile: string;
  /**
   * Относительный путь внутри PVC workspace (`proj-slug`,
   * `proj-slug/.worktrees/feature`) — что монтировать в пул как рабочее
   * дерево (PROP-135 Ф4b-2b-2a).
   *
   * В ключ пула (`poolKeyString`) **не** входит: пул остаётся один на
   * область (проект/сессию), а subPath — свойство монтирования тома, которое
   * provisioner получает из тела `POST /v1/pools`. Не задан — монтируется
   * корень тома (поведение для standalone-проектов вне `workspacesRoot`).
   */
  workspaceSubPath?: string;
}

/**
 * Каноническая строка ключа пула: `project:<id>:exec:<profile>`,
 * `session:<id>:browser:<profile>`, `instance:exec:<profile>`.
 *
 * Единое представление нужно в двух местах: провод к provisioner'у (путь
 * `POST /v1/pools/{key}`) и кэш портов роутера (один порт на ключ).
 *
 * @throws Error — у `project`/`session` без `id` (fail-closed: ключ без
 *   идентификатора совпал бы с ключом чужого пула).
 */
export function poolKeyString(key: ExecutionPoolKey): string {
  const profile = (key.profile ?? '').trim() || 'default';
  const cls = key.class;
  if (key.scope === 'instance') {
    return `instance:${cls}:${profile}`;
  }
  const id = (key.id ?? '').trim();
  if (id === '') {
    throw new Error(
      `execution pool key for scope "${key.scope}" requires an id (project/session pool isolation)`,
    );
  }
  return `${key.scope}:${id}:${cls}:${profile}`;
}

/** Адрес (и необязательный токен) пула исполнения. */
export interface ExecutionPoolRef {
  /** Адрес исполнителя пула (`http://…`). */
  url: string;
  /** Токен доступа к пулу (значение, не путь) — если провайдер его выдал. */
  token?: string;
}

/**
 * Источник пулов исполнения.
 *
 * `ensure` — **обязательный**: он возвращает адрес (и токен) пула, создавая
 * пул при необходимости. Остальные методы необязательны и по контракту
 * **best-effort** (сбой `touch`/`drain`/`release` не должен ломать ход).
 */
export interface ExecutionPoolProvider {
  /** Адрес (и токен) пула по ключу; при необходимости пул создаётся. */
  ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef>;
  /** Продлить жизнь пула (idle-таймаут на стороне provisioner'а). */
  touch?(key: ExecutionPoolKey): Promise<void>;
  /** Слить пул (освободить исполнителей, но не удалить пул). */
  drain?(key: ExecutionPoolKey): Promise<void>;
  /** Удалить пул (освободить ресурсы). */
  release?(key: ExecutionPoolKey): Promise<void>;
  /** Диагностика: имя провайдера и известные профили. */
  capabilities?(): Promise<{ provider: string; profiles: string[] }>;
}

/**
 * Структурная проверка: переданное значение — провайдер пулов.
 *
 * По образцу `isExecutionRouter`/`isExecutionPort`: значение может прийти из
 * другой копии модуля, поэтому проверка опирается на форму, а не на класс.
 */
export function isExecutionPoolProvider(value: unknown): value is ExecutionPoolProvider {
  return typeof (value as { ensure?: unknown } | null | undefined)?.ensure === 'function';
}

/**
 * Ошибка провайдера пулов — понятная причина отказа.
 *
 * Отдельный класс (как `ExecutionProfileUnavailableError` в роутере): вызывающий
 * отличает «provisioner недоступен» от «исполнитель не отвечает».
 */
export class ExecutionPoolProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutionPoolProviderError';
  }
}

/**
 * Провайдер пулов из конфигурации (PROP-135 Ф4b-1, `provider: static`).
 *
 * Адрес пула известен заранее: это первый адрес профиля. **Изоляции пулов
 * нет** — ключ пула игнорируется: `project`/`session` при `provider: static`
 * дают тот же порт профиля, что и `instance` (документированное ограничение:
 * динамические пулы — только при `provider: http`).
 */
export class StaticExecutionPoolProvider implements ExecutionPoolProvider {
  private readonly _profiles: Record<string, { url: string[] }>;

  constructor(profiles: Record<string, { url: string[] }>) {
    this._profiles = profiles;
  }

  async ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef> {
    const profile = this._profiles[key.profile];
    const url = profile?.url?.[0]?.trim() ?? '';
    if (url === '') {
      throw new ExecutionPoolProviderError(
        `execution pool provider "static" has no address for profile "${key.profile}" ` +
          `(execution.remote.profiles.${key.profile}.url / execution.remote.url)`,
      );
    }
    // Токена нет: адрес и токен исполнителя читает фабрика порта (токен —
    // путь/ссылка из конфигурации, инвариант 13).
    return { url };
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    return { provider: 'static', profiles: Object.keys(this._profiles) };
  }
}

/** Опции HTTP-провайдера пулов. */
export interface HttpExecutionPoolProviderOptions {
  /** Адрес provisioner'а (`http://…`). */
  url: string;
  /** **Путь/ссылка** на токен provisioner'а (НЕ значение — инвариант 13). */
  tokenSecret: string;
  /** Таймаут обращения к provisioner'у, мс. */
  timeoutMs: number;
  /** Транспорт (тесты подменяют `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * Провайдер пулов у provisioner'а (PROP-135 Ф4b-1, `provider: http`).
 *
 * ## Протокол
 *
 * - `POST {url}/v1/pools` — тело `{ key, scope, id, class, profile }`
 *   (+ `workspaceSubPath`, если задан — per-project монтирование PVC),
 *   ответ `{ url, token }`; адрес и токен пула приходят **из ответа**;
 * - `POST {url}/v1/pools/{key}/touch` — продлить жизнь пула (best-effort);
 * - `POST {url}/v1/pools/{key}/drain` — слить пул (best-effort);
 * - `DELETE {url}/v1/pools/{key}` — удалить пул (best-effort);
 * - `GET {url}/v1/capabilities` — диагностика (`{ provider, profiles }`).
 *
 * `{key}` — **URL-encoded** канонический ключ пула (`poolKeyString`).
 *
 * ## Секреты
 *
 * Bearer-токен читается из файла (`provisioner.tokenSecret`) и **кэшируется
 * на процесс**: значение токена не попадает ни в логи, ни в текст ошибок
 * (в ошибку идёт только путь и техническая причина).
 */
export class HttpExecutionPoolProvider implements ExecutionPoolProvider {
  private readonly _url: string;
  private readonly _tokenSecret: string;
  private readonly _timeoutMs: number;
  private readonly _fetchImpl: FetchLike | undefined;
  /** Кэш значения токена на процесс (`null` — ещё не читали). */
  private _token: Promise<string> | null = null;

  constructor(opts: HttpExecutionPoolProviderOptions) {
    this._url = opts.url.replace(/\/+$/, '');
    this._tokenSecret = opts.tokenSecret;
    this._timeoutMs = opts.timeoutMs;
    this._fetchImpl = opts.fetchImpl;
  }

  async ensure(key: ExecutionPoolKey): Promise<ExecutionPoolRef> {
    const body = {
      key: poolKeyString(key),
      scope: key.scope,
      ...(key.id ? { id: key.id } : {}),
      class: key.class,
      profile: key.profile,
      // PROP-135 Ф4b-2b-2a: per-project монтирование PVC — поле аддитивное
      // (старый provisioner его проигнорирует и смонтирует корень тома).
      ...(key.workspaceSubPath ? { workspaceSubPath: key.workspaceSubPath } : {}),
    };
    const response = await this._request('POST', '/v1/pools', body, true);
    const payload = (await response.json().catch(() => null)) as {
      url?: unknown;
      token?: unknown;
    } | null;
    const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (url === '') {
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" returned no pool address for key "${body.key}"`,
      );
    }
    const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
    return token === '' ? { url } : { url, token };
  }

  async touch(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('POST', `/v1/pools/${encodeURIComponent(poolKeyString(key))}/touch`);
  }

  async drain(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('POST', `/v1/pools/${encodeURIComponent(poolKeyString(key))}/drain`);
  }

  async release(key: ExecutionPoolKey): Promise<void> {
    await this._bestEffort('DELETE', `/v1/pools/${encodeURIComponent(poolKeyString(key))}`);
  }

  async capabilities(): Promise<{ provider: string; profiles: string[] }> {
    const response = await this._request('GET', '/v1/capabilities', undefined, true);
    const payload = (await response.json().catch(() => null)) as {
      provider?: unknown;
      profiles?: unknown;
    } | null;
    const profiles = Array.isArray(payload?.profiles)
      ? payload.profiles.filter((p): p is string => typeof p === 'string')
      : [];
    return {
      provider: typeof payload?.provider === 'string' ? payload.provider : 'http',
      profiles,
    };
  }

  /**
   * Best-effort вызов: сбой не ломает ход (смысл `touch`/`drain`/`release` —
   * подчистка, а не условие работы).
   */
  private async _bestEffort(method: string, path: string): Promise<void> {
    try {
      await this._request(method, path, undefined, false);
    } catch {
      // Намеренно проглочено: best-effort.
    }
  }

  /**
   * Запрос к provisioner'у: bearer-токен, таймаут, приведение ответа к ошибке.
   *
   * @param requireAuth `true` — заголовок `Authorization` обязателен
   * @param body тело запроса (JSON) либо `undefined`
   */
  private async _request(
    method: string,
    path: string,
    body: unknown,
    requireAuth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (requireAuth) {
      headers.authorization = `Bearer ${await this._readToken()}`;
    }
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this._timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await egressFetch(`${this._url}${path}`, init, {
        ...(this._fetchImpl ? { fetchImpl: this._fetchImpl } : {}),
      });
    } catch (err) {
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" request failed (${method} ${path})`,
        { cause: err },
      );
    }
    if (!response.ok) {
      // Тело ответа **не** включаем в текст ошибки: provisioner мог бы
      // вернуть эхо токена.
      throw new ExecutionPoolProviderError(
        `execution pool provider "http" request failed (${method} ${path}): status ${response.status}`,
      );
    }
    return response;
  }

  /** Значение bearer-токена (кэш на процесс); при ошибке — понятная причина. */
  private async _readToken(): Promise<string> {
    if (!this._token) {
      this._token = readExecutorToken(this._tokenSecret).catch((err: unknown) => {
        // Кэш сбрасываем: файл токена мог появиться позже (файл монтируется
        // после старта процесса).
        this._token = null;
        throw new ExecutionPoolProviderError(
          'execution pool provider "http" could not read its token ' +
            '(execution.remote.provisioner.tokenSecret / SYNTH_EXECUTION_PROVISIONER_TOKEN)',
          { cause: err },
        );
      });
    }
    return this._token;
  }
}

/**
 * Фабрика провайдера пулов по эффективной секции `execution`.
 *
 * `provider: static` — пулы из конфигурации; `provider: http` — provisioner
 * по HTTP. Неизвестное значение — **fail-closed** (его отсекает резолвер
 * конфигурации; здесь — страховка).
 *
 * @param remote эффективная секция `execution.remote`
 * @param opts транспорт (тесты подменяют `fetch`)
 */
export function createExecutionPoolProvider(
  remote: ResolvedExecutionRemoteConfig,
  opts?: { fetchImpl?: FetchLike },
): ExecutionPoolProvider {
  if (remote.provider === 'http') {
    return new HttpExecutionPoolProvider({
      url: remote.provisioner.url,
      tokenSecret: remote.provisioner.tokenSecret,
      timeoutMs: remote.provisioner.timeoutMs,
      ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  const profiles: Record<string, { url: string[] }> = {};
  for (const [name, profile] of Object.entries(remote.profiles)) {
    profiles[name] = { url: [...profile.url] };
  }
  // Профиль по умолчанию существует всегда: из каталога либо «общие
  // параметры секции» (адреса секции — как «профиль по умолчанию»).
  if (!profiles[remote.defaultProfile]) {
    profiles[remote.defaultProfile] = { url: [...remote.url] };
  }
  return new StaticExecutionPoolProvider(profiles);
}
