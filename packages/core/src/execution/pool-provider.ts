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
 * (`exec`/`browser`/`sandbox`) и профиль. Строковое представление
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

/**
 * Класс пула: обычные команды, браузерная сессия либо разовый песочный запуск.
 *
 * `sandbox` (PROP-135 слайс 5a) — отдельный профиль исполнения для
 * `sandbox_exec`: другой образ/набор программ, отдельный пул и собственная
 * политика провижининга. Ключ пула поэтому различает классы — иначе
 * песочный запуск занял бы порт обычного пула.
 */
export type ExecutionPoolClass = 'exec' | 'browser' | 'sandbox';

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
 * `session:<id>:browser:<profile>`, `session:<id>:sandbox:<profile>`,
 * `instance:exec:<profile>`.
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

/**
 * Публичное описание пула исполнения (PROP-135 Ф6b-1) — диагностика для
 * admin-API/UI.
 *
 * **Без адреса и токена**: `url` пула и его токен — секреты доступа к
 * исполнителю (инвариант 13), наружу они не отдаются. Ключ пула — только если
 * его знает провайдер (у `static` пулы адресуются профилем — ключа нет).
 */
export interface PoolInfo {
  /** Канонический ключ пула (`poolKeyString`); у `static` — отсутствует. */
  key?: string;
  /** Имя профиля исполнения пула. */
  profile: string;
  /** Состояние: задан профилем (`configured`), готов (`ready`), снимается (`draining`). */
  state: 'configured' | 'ready' | 'draining';
  /** Когда пул выдан (ISO-8601). */
  createdAt?: string;
  /** Когда пул последний раз использовался (ISO-8601). */
  lastUsedAt?: string;
}

/**
 * Разбор канонического ключа пула (`poolKeyString`) обратно в ключ.
 *
 * Нужен admin-API (`POST /pools/:key/drain`, `DELETE /pools/:key`): клиент
 * присылает **строку** ключа (как в протоколе provisioner'а), а методы
 * провайдера принимают объект. Формат: `instance:<class>:<profile>` либо
 * `<scope>:<id>:<class>:<profile>`; профиль — остаток после класса (имя может
 * содержать `:`).
 *
 * @throws Error — пустая строка, неизвестная область/класс, пустой id или профиль.
 */
export function parsePoolKey(key: string): ExecutionPoolKey {
  const raw = (key ?? '').trim();
  const parts = raw.split(':');
  const scope = parts[0];
  let parsed: ExecutionPoolKey | null = null;
  if (scope === 'instance' && parts.length >= 3) {
    parsed = {
      scope: 'instance',
      class: toPoolClass(parts[1]),
      profile: parts.slice(2).join(':'),
    };
  } else if ((scope === 'project' || scope === 'session') && parts.length >= 4) {
    const id = parts[1] ?? '';
    if (id.trim() === '') throw new Error(`execution pool key "${raw}" has no scope id`);
    parsed = {
      scope,
      id,
      class: toPoolClass(parts[2]),
      profile: parts.slice(3).join(':'),
    };
  }
  if (!parsed) throw new Error(`invalid execution pool key "${raw}"`);
  if (parsed.profile.trim() === '') {
    throw new Error(`execution pool key "${raw}" has no profile`);
  }
  return parsed;
}

/** Класс пула из сегмента ключа; неизвестный — ошибка (fail-closed). */
function toPoolClass(value: string | undefined): ExecutionPoolClass {
  if (value === 'exec' || value === 'browser' || value === 'sandbox') return value;
  throw new Error(`invalid execution pool class "${value ?? ''}"`);
}

/**
 * Метка времени provisioner'а (мс epoch либо ISO-строка) → ISO-8601.
 *
 * Невалидное/отсутствующее значение — `undefined` (поле не отдаём): пул без
 * времени жизни всё равно показывается, «битая» дата наружу не пойдёт.
 */
function toIsoTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

/** Непустая строка из неизвестного значения либо `undefined`. */
function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Список ресурсов профиля из ответа provisioner'а (только строки, `undefined` — пусто). */
function toProfileResourceList(raw: unknown): ExecutionProfileResourceList | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const list: ExecutionProfileResourceList = {};
  const cpu = toOptionalString(record.cpu);
  const memory = toOptionalString(record.memory);
  const ephemeralStorage = toOptionalString(record.ephemeralStorage);
  if (cpu !== undefined) list.cpu = cpu;
  if (memory !== undefined) list.memory = memory;
  if (ephemeralStorage !== undefined) list.ephemeralStorage = ephemeralStorage;
  return Object.keys(list).length > 0 ? list : undefined;
}

/** Ресурсы профиля (`requests`/`limits`); пустой блок не отдаётся. */
function toProfileResources(raw: unknown): ExecutionProfileResources | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const requests = toProfileResourceList(record.requests);
  const limits = toProfileResourceList(record.limits);
  if (requests === undefined && limits === undefined) return undefined;
  return {
    ...(requests !== undefined ? { requests } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

/**
 * Запись `GET /v1/profiles` → метаданные профиля.
 *
 * Неизвестная/битая запись пропускается, если у неё нет имени (нечего
 * показывать). Значения нормализуются к строкам: чужой/старый provisioner не
 * должен ломать admin-API.
 */
function toProfileInfo(entry: unknown): ExecutionProfileInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const name = toOptionalString(record.name);
  if (name === undefined) return null;
  const description = toOptionalString(record.description);
  const image = toOptionalString(record.image);
  const runtimeClass = toOptionalString(record.runtimeClass);
  const network =
    record.network === 'none' || record.network === 'restricted' || record.network === 'full'
      ? record.network
      : undefined;
  const resources = toProfileResources(record.resources);
  const mcpServers = Array.isArray(record.mcpServers)
    ? record.mcpServers
        .map((item) => toOptionalString(item))
        .filter((item): item is string => item !== undefined)
    : [];
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(runtimeClass !== undefined ? { runtimeClass } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  };
}

/** Адрес (и необязательный токен) пула исполнения. */
export interface ExecutionPoolRef {
  /** Адрес исполнителя пула (`http://…`). */
  url: string;
  /** Токен доступа к пулу (значение, не путь) — если провайдер его выдал. */
  token?: string;
}

/** Список ресурсов профиля (`requests`/`limits` контейнера пула). */
export interface ExecutionProfileResourceList {
  /** CPU (`500m`, `1`). */
  cpu?: string;
  /** Память (`2Gi`). */
  memory?: string;
  /** Эфемерное хранилище (`1Gi`). */
  ephemeralStorage?: string;
}

/** Ресурсы профиля исполнения (как в PodSpec). */
export interface ExecutionProfileResources {
  requests?: ExecutionProfileResourceList;
  limits?: ExecutionProfileResourceList;
}

/**
 * Метаданные профиля исполнения для admin-API/UI.
 *
 * **Без секретов**: env профиля, команды/аргументы/env MCP-серверов, адреса и
 * токены пулов не отдаются (инвариант 13). `mcpServers` — только имена.
 * Незаданное поле — «неизвестно» (у `static` известны лишь имя и описание).
 */
export interface ExecutionProfileInfo {
  /** Имя профиля. */
  name: string;
  /** Человекочитаемое описание (если задано). */
  description?: string;
  /** Образ пула. */
  image?: string;
  /** Сетевой класс профиля. */
  network?: 'none' | 'restricted' | 'full';
  /** Ресурсы контейнера пула. */
  resources?: ExecutionProfileResources;
  /** `runtimeClassName` пода. */
  runtimeClass?: string;
  /** **Имена** MCP-серверов профиля. */
  mcpServers?: string[];
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
  /**
   * PROP-135 Ф6b-1: список известных пулов для диагностики (без адресов и
   * токенов). Не задан — провайдер не умеет перечислять пулы (admin-API
   * ответит `503 EXECUTION_PROVIDER_UNAVAILABLE`).
   */
  list?(): Promise<PoolInfo[]>;
  /** Диагностика: имя провайдера и известные профили. */
  capabilities?(): Promise<{ provider: string; profiles: string[] }>;
  /**
   * Метаданные профилей (образ/сеть/ресурсы/runtimeClass, имена MCP-серверов)
   * для admin-API/UI. Не задан — провайдер их не умеет (admin-API покажет
   * только имена из каталога конфигурации).
   */
  profilesInfo?(): Promise<ExecutionProfileInfo[]>;
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

  /**
   * Метаданные профилей static-провайдера: каталог конфигурации знает только
   * имена — образа, сети и ресурсов у статического адреса нет.
   */
  async profilesInfo(): Promise<ExecutionProfileInfo[]> {
    return Object.keys(this._profiles).map((name) => ({ name }));
  }

  /**
   * PROP-135 Ф6b-1: пулы статического провайдера — профили конфигурации.
   *
   * Ключа пула нет (адресация по профилю), состояние — `configured`:
   * физического пула с жизненным циклом у `static` не существует.
   */
  async list(): Promise<PoolInfo[]> {
    return Object.keys(this._profiles).map((profile) => ({
      profile,
      state: 'configured' as const,
    }));
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
 * - `GET {url}/v1/pools` — список пулов (диагностика, без адресов и токенов);
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

  /**
   * PROP-135 Ф6b-1: список пулов у provisioner'а (`GET /v1/pools`).
   *
   * Ответ провайдера несёт `url` пула — в DTO он **не попадает** (секрет
   * доступа к исполнителю): наружу идут только ключ, профиль, состояние и
   * метки времени. Записи без профиля пропускаются (нечего показать).
   */
  async list(): Promise<PoolInfo[]> {
    const response = await this._request('GET', '/v1/pools', undefined, true);
    const payload = (await response.json().catch(() => null)) as { pools?: unknown } | null;
    const raw = Array.isArray(payload?.pools) ? payload.pools : [];
    const pools: PoolInfo[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as {
        key?: unknown;
        profile?: unknown;
        state?: unknown;
        createdAt?: unknown;
        lastUsedAt?: unknown;
      };
      const profile = typeof record.profile === 'string' ? record.profile.trim() : '';
      if (profile === '') continue;
      const key = typeof record.key === 'string' ? record.key.trim() : '';
      const createdAt = toIsoTime(record.createdAt);
      const lastUsedAt = toIsoTime(record.lastUsedAt);
      pools.push({
        ...(key !== '' ? { key } : {}),
        profile,
        state:
          record.state === 'draining' ? 'draining' : record.state === 'ready' ? 'ready' : 'configured',
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      });
    }
    return pools;
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
   * Метаданные профилей у provisioner'а (`GET /v1/profiles`).
   *
   * Ответ — **только метаданные** (образ/сеть/ресурсы/runtimeClass и имена
   * MCP-серверов); env, команды MCP и токены provisioner не отдаёт. Записи без
   * имени и неизвестные поля при разборе отбрасываются.
   */
  async profilesInfo(): Promise<ExecutionProfileInfo[]> {
    const response = await this._request('GET', '/v1/profiles', undefined, true);
    const payload = (await response.json().catch(() => null)) as { profiles?: unknown } | null;
    const raw = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const profiles: ExecutionProfileInfo[] = [];
    for (const entry of raw) {
      const info = toProfileInfo(entry);
      if (info !== null) profiles.push(info);
    }
    return profiles;
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
