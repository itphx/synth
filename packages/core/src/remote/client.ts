// HTTP-клиент к API v2 удалённого backend (гибридный режим).
// Сетевые ошибки → RemoteError('OFFLINE'), 401 → RemoteError('UNAUTHORIZED'),
// остальные не-OK → RemoteError('HTTP_<status>').

import { RemoteError } from './types.js';
import { CURRENCIES, type Currency } from '@itphx/synth-shared';
// PROP-125: контракт удалённого MCP (сервер гибрида → локальный core).
import type {
  InstanceCapabilities,
  RemoteMcpCallRequest,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';
import type { RemoteRequestInfo } from '../metrics/collectors/hybrid.js';
// ADR-099: запросы к удалённому backend — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';
import { describeTransportError } from './transport-error.js';

/** Валидирует валюту по списку RUB/USD/CNY; иначе — undefined. */
function asCurrency(value: unknown): Currency | undefined {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
    ? (value as Currency)
    : undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Короткий таймаут для быстрой проверки доступности. */
const HEALTH_TIMEOUT_MS = 3_000;

export interface RemoteClientOptions {
  backendUrl: string;
  getToken: () => Promise<string | null>;
  timeoutMs?: number;
  /** ADR-094: метрики запроса (вызывается в `finally`, включая ошибки). */
  onRequest?: (info: RemoteRequestInfo) => void;
}

export interface RemoteAuthStatus {
  oidc_enabled: boolean;
  authenticated: boolean;
  user?: { id: string; username: string; roles: string[] } | null;
}

/**
 * Страница списка сессий удалённого мира (гибрид).
 *
 * `paginationSupported: false` — удалённый сервер отдал **массив** (старый
 * контракт без пагинации): тогда список полный, а `next_offset` всегда `null`.
 */
export interface RemoteSessionList {
  sessions: Array<Record<string, unknown>>;
  /** Число сессий на удалённой стороне (для старого формата — длина массива). */
  total: number;
  /** Удалённый сервер понимает пагинацию списка. */
  paginationSupported: boolean;
  /** Курсор следующей страницы удалённого списка (`null` — последняя). */
  next_offset: number | null;
}

/**
 * Страница списка проектов удалённого мира (гибрид).
 *
 * `paginationSupported: false` — удалённый сервер отдал **массив** (старый
 * контракт без пагинации): тогда список полный, а `next_offset` всегда `null`.
 */
export interface RemoteProjectList {
  projects: Array<Record<string, unknown>>;
  /** Число проектов на удалённой стороне (для старого формата — длина массива). */
  total: number;
  /** Удалённый сервер понимает пагинацию списка. */
  paginationSupported: boolean;
  /** Курсор следующей страницы удалённого списка (`null` — последняя). */
  next_offset: number | null;
}

/**
 * Размер страницы при обходе удалённого списка целиком (merge гибрида).
 * Совпадает с максимумом `limit` на сервере (`MAX_SESSIONS_LIMIT`/`MAX_PROJECTS_LIMIT`).
 */
export const REMOTE_LIST_PAGE_LIMIT = 500;

/**
 * Кап числа страниц при обходе удалённого списка целиком.
 * Защита от гигантского ответа и от «курсора, который не двигается».
 */
export const REMOTE_LIST_MAX_PAGES = 20;

/**
 * Результат обхода удалённого списка целиком (merge гибрида).
 *
 * `truncated: true` — список получен **не полностью** (сработал кап страниц):
 * вызывающий обязан не выдавать курсор сквозной пагинации (часть записей
 * удалённой стороны неизвестна).
 */
export interface RemoteAllList {
  /** Все полученные записи удалённого списка (в порядке сервера). */
  items: Array<Record<string, unknown>>;
  /** Всего записей на удалённой стороне (по данным сервера). */
  total: number;
  /** Список получен не полностью (кап страниц) — пагинация невозможна. */
  truncated: boolean;
}

/**
 * Страница истории сообщений удалённой сессии.
 *
 * Старый сервер может проигнорировать `limit`/`before` и вернуть **всю**
 * историю — тогда `messages` длиннее запрошенного `limit`, а нарезку обязан
 * сделать вызывающий (роут `GET /sessions/:id/messages`).
 */
export interface RemoteMessagePage {
  /** Сообщения страницы (DTO удалённого сервера). */
  messages: Array<Record<string, unknown>>;
  /** id сессии на удалённой стороне (если сервер его прислал). */
  session_id?: string;
  /** Удалённый сервер знает, что есть более старые сообщения. */
  has_more?: boolean;
  /** Курсор следующей (более старой) страницы. */
  next_before?: number | null;
}

/** Плохая запись провайдера с удалённого backend (GET /api/v2/providers). */
export interface RemoteProviderInfo {
  name: string;
  type: string;
  url: string;
  model: string;
  enabled: boolean;
  is_default: boolean;
  icon?: string;
  icon_url?: string;
  /** Валюта по умолчанию для моделей провайдера. */
  currency?: Currency;
}

/**
 * Плоская запись модели с удалённого backend (для CLI/инъекции remote-моделей).
 * Несёт полные метаданные модели (контекстное окно, цены), чтобы локальный core
 * мог считать контекст-окна и стоимость — как если бы модель была локальной.
 */
export interface RemoteModelInfo {
  id: string;
  name: string;
  provider: string;
  description: string;
  enabled: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  contextSource?: string;
  maxOutputTokens?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  /** Валюта цен модели. Отсутствует → валюта провайдера → USD. */
  currency?: Currency;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Вернуть сырой Response вместо разобранного JSON (для стримов/SSE). */
  raw?: boolean;
  /**
   * Не бросать на HTTP-ошибку — вернуть `Response` как есть, чтобы вызывающий
   * прочитал `code`/`details` тела (гибрид: проброс 4xx приёма сообщения).
   * `401` не переопределяется — всегда `UNAUTHORIZED`.
   */
  allowHttpError?: boolean;
  /** Таймаут конкретного запроса в мс (переопределяет дефолт); 0 — без таймаута. */
  timeoutMs?: number;
  /** Сырое тело вместо JSON-сериализации (multipart/FormData и т.п.). */
  rawBody?: RequestInit['body'];
  /**
   * Дополнительные заголовки запроса (например `Range` для `/api/v2/fs/raw`).
   * `Authorization`/`Content-Type` переопределяются клиентом — ими нельзя
   * подменить креды запроса.
   */
  headers?: Record<string, string>;
}

/**
 * Адресация элемента очереди для `return`/`steer` (ADR-104): `id` приоритетнее
 * `index`; число — обратная совместимость (= `index`).
 */
export type QueueTarget = number | { id?: string; index?: number };

/** Индекс очереди — неотрицательное целое (иначе запрос не отправляем). */
function assertQueueIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index должен быть неотрицательным целым');
  }
}

export class RemoteBackendClient {
  private readonly _backendUrl: string;
  private readonly _getToken: () => Promise<string | null>;
  private readonly _timeoutMs: number;
  private readonly _onRequest?: (info: RemoteRequestInfo) => void;

  constructor(options: RemoteClientOptions) {
    this._backendUrl = options.backendUrl.replace(/\/+$/, '');
    this._getToken = options.getToken;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._onRequest = options.onRequest;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    if (!this._onRequest) {
      return this._requestImpl<T>(method, path, body, opts);
    }
    const startedAt = Date.now();
    const info: RemoteRequestInfo = { method, path, durationMs: 0 };
    try {
      return await this._requestImpl<T>(method, path, body, opts, info);
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      info.durationMs = Date.now() - startedAt;
      try {
        this._onRequest(info);
      } catch {
        // метрики не должны ломать запрос
      }
    }
  }

  private async _requestImpl<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: RequestOptions,
    info?: RemoteRequestInfo,
  ): Promise<T> {
    const url = new URL(path, this._backendUrl).toString();

    const token = await this._getToken();
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    let fetchBody: RequestInit['body'] | undefined;
    if (opts?.rawBody !== undefined) {
      // Форма/Multipart: Content-Type (включая boundary) ставит сам fetch.
      fetchBody = opts.rawBody;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    const timeoutMs = opts?.timeoutMs ?? this._timeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    let res: Response;
    try {
      res = await egressFetch(url, {
        method,
        headers,
        body: fetchBody,
        signal: controller.signal,
      });
    } catch (err) {
      // Отмена вызывающей стороной — пробрасываем как есть (не наша ошибка).
      if (opts?.signal?.aborted) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RemoteError(`Таймаут запроса к серверу (${timeoutMs} мс): ${method} ${path}`, 'OFFLINE');
      }
      const reason = err instanceof Error ? err.message : String(err);
      // ADR-099: настоящая причина (TLS/DNS/отказ соединения) — в `cause.code`;
      // без неё сообщение «fetch failed» бесполезно для диагностики.
      const detail = describeTransportError(err);
      // Лог без query/кредов: только метод и путь эндпоинта.
      console.warn(`[hybrid] ${method} ${path.split('?')[0]}: ${reason}${detail}`);
      throw new RemoteError(`Сервер недоступен: ${reason}${detail}`, 'OFFLINE');
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (info) info.status = res.status;
    if (res.status === 401) {
      throw new RemoteError('Не авторизован на удалённом сервере', 'UNAUTHORIZED');
    }
    if (!res.ok && !opts?.allowHttpError) {
      throw new RemoteError(await this._extractError(res, path), `HTTP_${res.status}`);
    }
    if (opts?.raw) {
      return res as unknown as T;
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private async _extractError(res: Response, path: string): Promise<string> {
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) {
        return `${data.error.message} (${path})`;
      }
    } catch {
      // не-JSON тело — используем статус
    }
    return `HTTP ${res.status} (${path})`;
  }

  /** URL удалённого backend (для UI: индикатор подключения, тултипы). */
  get backendUrl(): string {
    return this._backendUrl;
  }

  /**
   * PROP-125 §2: текущий access-токен гибрида (или `null`).
   *
   * Нужен relay-клиенту локального core: он ходит в `/api/v2/mcp/relay/:name`
   * обычным MCP-транспортом и подставляет Bearer **на каждый запрос** —
   * токен обновляется в рантайме (`RemoteSession.getToken()`), поэтому
   * статический заголовок протух бы.
   */
  async getAccessToken(): Promise<string | null> {
    return this._getToken();
  }

  // --- Методы для будущей агрегации миров (Part 2) ---

  /** Статус аутентификации на backend (GET /auth/status). */
  getAuthStatus(opts?: RequestOptions): Promise<RemoteAuthStatus> {
    return this.request<RemoteAuthStatus>('GET', '/auth/status', undefined, opts);
  }

  /**
   * Модели на удалённом backend.
   *
   * Контракт ответа — **страница** `{models, total, offset, limit, next_offset}`
   * (ADR-052, пагинация обязательна). Старый сервер отдаёт группы
   * `{groups: [{models: [...]}]}` — он нормализуется в плоский список
   * (гибрид может быть подключён к инстансу предыдущей версии).
   */
  listModels(opts?: RequestOptions): Promise<RemoteModelInfo[]> {
    return this.request<{
      models?: Array<Record<string, unknown>>;
      groups?: Array<{ models?: Array<Record<string, unknown>> }>;
    }>(
      'GET',
      // `limit=500` — максимальная страница: зеркалирование каталога моделей
      // должно видеть весь каталог, а не первые 100 записей.
      '/api/v2/models?limit=500',
      undefined,
      opts,
    ).then((data) => {
      const flat: Array<Record<string, unknown>> = Array.isArray(data?.models)
        ? data.models
        : (data?.groups ?? []).flatMap((g) => g.models ?? []);
      return flat.map((m) => ({
        id: String(m.id ?? ''),
        name: String(m.name ?? m.id ?? ''),
        provider: String(m.provider ?? ''),
        description: String(m.description ?? ''),
        enabled: m.enabled !== false,
        isDefault: m.isDefault === true,
        contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : undefined,
        contextSource: typeof m.contextSource === 'string' && m.contextSource !== 'unknown' ? m.contextSource : undefined,
        maxOutputTokens: typeof m.maxOutputTokens === 'number' ? m.maxOutputTokens : undefined,
        inputPrice: typeof m.inputPrice === 'number' ? m.inputPrice : undefined,
        outputPrice: typeof m.outputPrice === 'number' ? m.outputPrice : undefined,
        cacheReadPrice: typeof m.cacheReadPrice === 'number' ? m.cacheReadPrice : undefined,
        cacheWritePrice: typeof m.cacheWritePrice === 'number' ? m.cacheWritePrice : undefined,
        currency: asCurrency(m.currency),
      })).filter((m) => m.id !== '');
    });
  }

  /** Провайдеры на удалённом backend (GET /api/v2/providers) — для зеркалирования. */
  listProviders(opts?: RequestOptions): Promise<RemoteProviderInfo[]> {
    return this.request<{ providers?: Array<Record<string, unknown>> }>(
      'GET',
      '/api/v2/providers',
      undefined,
      opts,
    ).then((data) =>
      (data?.providers ?? []).map((p) => ({
        name: String(p.name ?? ''),
        type: String(p.type ?? ''),
        url: String(p.url ?? ''),
        model: String(p.model ?? ''),
        enabled: p.enabled !== false,
        is_default: p.is_default === true,
        ...(p.currency ? { currency: asCurrency(p.currency) } : {}),
        ...(p.icon ? { icon: String(p.icon) } : {}),
        ...(p.icon_url ? { icon_url: String(p.icon_url) } : {}),
      })).filter((p) => p.name !== ''),
    );
  }

  /**
   * Страница списка проектов удалённого мира.
   *
   * Контракт ответа — объект `{projects, total, offset, limit, next_offset}`
   * (пагинация списка). Старый сервер отдаёт **массив** — он нормализуется в
   * `{projects, total, paginationSupported: false, next_offset: null}`: список
   * полный, но постранично его взять нельзя.
   *
   * `limit`/`offset` — параметры пагинации списка (пробрасываются в query).
   */
  async listProjects(params?: { limit?: number; offset?: number }): Promise<RemoteProjectList> {
    const query: string[] = [];
    if (params?.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.offset !== undefined) query.push(`offset=${encodeURIComponent(String(params.offset))}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    const raw = await this.request<unknown>('GET', `/api/v2/projects${suffix}`);
    if (Array.isArray(raw)) {
      const projects = raw as Array<Record<string, unknown>>;
      return { projects, total: projects.length, paginationSupported: false, next_offset: null };
    }
    const body = (raw ?? {}) as { projects?: unknown; total?: unknown; next_offset?: unknown };
    const projects = Array.isArray(body.projects)
      ? (body.projects as Array<Record<string, unknown>>)
      : [];
    return {
      projects,
      total: typeof body.total === 'number' ? body.total : projects.length,
      paginationSupported: true,
      next_offset: typeof body.next_offset === 'number' ? body.next_offset : null,
    };
  }

  /**
   * Страница списка сессий удалённого мира.
   *
   * Контракт ответа — объект `{sessions, total, offset, limit, next_offset}`
   * (пагинация списка). Старый сервер отдаёт **массив** — он нормализуется в
   * `{sessions, total, paginationSupported: false, next_offset: null}`: список
   * полный, но постранично его взять нельзя.
   *
   * `projectId` — фильтр по проекту (пробрасывается в query); `limit`/`offset`
   * — параметры пагинации списка.
   */
  async listSessions(
    projectId?: string,
    params?: { limit?: number; offset?: number },
  ): Promise<RemoteSessionList> {
    const query: string[] = [];
    if (projectId) query.push(`project_id=${encodeURIComponent(projectId)}`);
    if (params?.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.offset !== undefined) query.push(`offset=${encodeURIComponent(String(params.offset))}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    const raw = await this.request<unknown>('GET', `/api/v2/sessions${suffix}`);
    if (Array.isArray(raw)) {
      const sessions = raw as Array<Record<string, unknown>>;
      return { sessions, total: sessions.length, paginationSupported: false, next_offset: null };
    }
    const body = (raw ?? {}) as { sessions?: unknown; total?: unknown; next_offset?: unknown };
    const sessions = Array.isArray(body.sessions)
      ? (body.sessions as Array<Record<string, unknown>>)
      : [];
    return {
      sessions,
      total: typeof body.total === 'number' ? body.total : sessions.length,
      paginationSupported: true,
      next_offset: typeof body.next_offset === 'number' ? body.next_offset : null,
    };
  }

  /**
   * Полный список проектов удалённого мира (обход страниц) — для merge гибрида.
   *
   * Старый сервер (массив) отдаёт весь список одним ответом — обход
   * заканчивается сразу. Новый сервер — страницы по `REMOTE_LIST_PAGE_LIMIT`
   * до `next_offset: null`; число страниц ограничено капом
   * (`REMOTE_LIST_MAX_PAGES`): при превышении `truncated = true`, и вызывающий
   * обязан не выдавать курсор сквозной пагинации.
   */
  listAllProjects(opts?: { maxPages?: number }): Promise<RemoteAllList> {
    return this._listAll(
      async (params) => {
        const page = await this.listProjects(params);
        return {
          items: page.projects,
          total: page.total,
          paginationSupported: page.paginationSupported,
          next_offset: page.next_offset,
        };
      },
      opts,
    );
  }

  /**
   * Полный список сессий удалённого мира (обход страниц) — для merge гибрида.
   * Семантика cap'а — как в `listAllProjects`.
   */
  listAllSessions(projectId?: string, opts?: { maxPages?: number }): Promise<RemoteAllList> {
    return this._listAll(
      async (params) => {
        const page = await this.listSessions(projectId, params);
        return {
          items: page.sessions,
          total: page.total,
          paginationSupported: page.paginationSupported,
          next_offset: page.next_offset,
        };
      },
      opts,
    );
  }

  /** Общий обход страниц удалённого списка (см. `listAllProjects`). */
  private async _listAll(
    fetchPage: (params: { limit: number; offset: number }) => Promise<{
      items: Array<Record<string, unknown>>;
      total: number;
      paginationSupported: boolean;
      next_offset: number | null;
    }>,
    opts?: { maxPages?: number },
  ): Promise<RemoteAllList> {
    const maxPages = Math.max(1, opts?.maxPages ?? REMOTE_LIST_MAX_PAGES);
    const items: Array<Record<string, unknown>> = [];
    let total = 0;
    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const res = await fetchPage({ limit: REMOTE_LIST_PAGE_LIMIT, offset });
      items.push(...res.items);
      total = res.total;
      if (!res.paginationSupported) {
        // Старый сервер: вернул весь список одним ответом — обход окончен.
        return { items, total, truncated: false };
      }
      if (res.next_offset === null) {
        return { items, total, truncated: false };
      }
      if (res.next_offset <= offset) {
        // Сервер вернул недвижущийся курсор — дальнейший обход бессмысленен.
        return { items, total, truncated: true };
      }
      offset = res.next_offset;
    }
    // Кап страниц: список получен не полностью — сквозная пагинация невозможна.
    return { items, total, truncated: true };
  }

  getSession(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}`);
  }

  /** Создать сессию. Body: { name|title, project_id, settings } (SessionCreateRequest). */
  createSession(body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/sessions', body);
  }

  /** Создать проект. Body: { name, description, icon, color, workspace, repos } (ProjectCreateRequest). */
  createProject(body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/projects', body);
  }

  // --- Форвардинг операций для удалённых сущностей (Part 3) ---

  // Сессии
  updateSession(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/v2/sessions/${encodeURIComponent(id)}`, body);
  }

  deleteSession(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v2/sessions/${encodeURIComponent(id)}`);
  }

  /** Промпт удалённой сессии: raw Response (SSE-стрим backend) без локального оркестратора. */
  promptSession(id: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<Response> {
    return this.request<Response>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/prompt`, body, {
      raw: true,
      // SSE-стрим живёт дольше обычного запроса: таймаут не применяем,
      // обрыв клиента отслеживаем через signal.
      timeoutMs: 0,
      ...opts,
    });
  }

  abortSession(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/abort`);
  }

  /**
   * Ответ на подтверждение прав удалённой сессии (гибрид).
   *
   * Ответ удалённой стороны возвращается как есть (`status` + разобранное тело):
   * вызывающий сам решает, пробросить `4xx` клиенту (WS/HTTP-путь) или
   * преобразовать в ошибку. `allowHttpError` не даёт `request` бросить на
   * `4xx`; `401` по-прежнему `UNAUTHORIZED` (общая политика клиента).
   */
  async permissionReply(
    sessionId: string,
    approvalId: string,
    body: { action: 'allow' | 'deny' | 'hold'; once?: boolean; turn_id?: string; digest?: string },
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.request<Response>(
      'POST',
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(approvalId)}`,
      body,
      { raw: true, allowHttpError: true },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  summarizeSession(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/summarize`);
  }

  /**
   * История сообщений удалённой сессии.
   *
   * `limit`/`before` — пагинация (`before` — непрозрачный курсор из `next_before`,
   * не обязательно `seq`). Старый сервер их игнорирует и отдаёт **всю** историю —
   * это ограничение гибрида: клиент возвращает ответ как есть, а нарезку по
   * ключу/`before`/`limit` делает вызывающий (роут `GET /sessions/:id/messages`).
   */
  async getSessionMessages(
    id: string,
    params?: { limit?: number; before?: number },
  ): Promise<RemoteMessagePage> {
    const query: string[] = [];
    if (params?.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.before !== undefined) query.push(`before=${encodeURIComponent(String(params.before))}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    const raw = await this.request<unknown>(
      'GET',
      `/api/v2/sessions/${encodeURIComponent(id)}/messages${suffix}`,
    );
    // Очень старый сервер мог отдать голый массив сообщений.
    if (Array.isArray(raw)) {
      return { messages: raw as Array<Record<string, unknown>> };
    }
    const body = (raw ?? {}) as {
      messages?: unknown;
      session_id?: unknown;
      has_more?: unknown;
      next_before?: unknown;
    };
    return {
      messages: Array.isArray(body.messages)
        ? (body.messages as Array<Record<string, unknown>>)
        : [],
      ...(typeof body.session_id === 'string' ? { session_id: body.session_id } : {}),
      ...(typeof body.has_more === 'boolean' ? { has_more: body.has_more } : {}),
      ...(typeof body.next_before === 'number' ? { next_before: body.next_before } : {}),
    };
  }

  /** Полный экспорт сессии для переноса между мирами (publish/fork). */
  exportSession(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/export`);
  }

  /**
   * Импорт сессии: body = экспорт + { import: { project_id } }. Создаёт сессию с историей.
   * `opts.timeoutMs` — перенос проекта задаёт увеличенный таймаут (клиент не
   * угадывает: значение передаёт вызывающий, большая история — долгая операция).
   */
  importSession(body: Record<string, unknown>, opts?: RequestOptions): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/sessions/import', body, opts);
  }

  /**
   * Пакетный импорт сессий одним запросом (backend ≥ 0.14): тело
   * `{ sessions: [...элементы экспорта с import { project_id, source_session_id }] }`.
   * Ответ — по элементу: `{source_session_id, id, updated}`. Старый backend без
   * маршрута отвечает 404/405 — вызывающий переключается на `importSession`.
   * `opts.timeoutMs` — перенос проекта задаёт увеличенный таймаут (клиент не
   * угадывает: значение передаёт вызывающий; размер пачки ограничивает он же).
   */
  importSessions(
    sessions: Record<string, unknown>[],
    opts?: RequestOptions,
  ): Promise<{
    sessions: Array<{ id?: string; source_session_id?: string; updated?: boolean }>;
  }> {
    return this.request<{
      sessions: Array<{ id?: string; source_session_id?: string; updated?: boolean }>;
    }>('POST', '/api/v2/sessions/import-batch', { sessions }, opts);
  }

  // Проекты
  getProject(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/projects/${encodeURIComponent(id)}`);
  }

  updateProject(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PUT', `/api/v2/projects/${encodeURIComponent(id)}`, body);
  }

  /**
   * Страница журнала удалённого проекта (PROP-054): журнал вынесен из детали
   * проекта, единственный источник записей — `GET /api/v2/projects/:id/log`
   * (постранично, новые сверху).
   */
  getProjectLog(id: string, params?: { limit?: number; offset?: number }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<unknown>(
      'GET',
      `/api/v2/projects/${encodeURIComponent(id)}/log${suffix}`,
    );
  }

  deleteProject(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v2/projects/${encodeURIComponent(id)}`);
  }

  // Память сессии (ADR-107): агрегаты вкладки «Память» удалённой сессии.
  // Ответ — DTO `GET /api/v2/sessions/:id/memory`; id внутри него принадлежат
  // удалённому миру и переписываются вызывающим (`remote:`).
  getSessionMemory(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/memory`);
  }

  // Оптимизация контекста (ADR-119) удалённой сессии: настройки вкладки
  // «Контекст» живут в мире этой сессии.
  getSessionOptimization(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/optimization`);
  }

  updateSessionOptimization(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/v2/sessions/${encodeURIComponent(id)}/optimization`, body);
  }

  checkSessionOptimization(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/optimization/check`);
  }

  cancelSessionSummarization(id: string): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/sessions/${encodeURIComponent(id)}/optimization/cancel-summarization`,
    );
  }

  // MCP-скоуп сессии (ADR-071 §2.4) удалённой сессии.
  getSessionMcp(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/mcp`);
  }

  updateSessionMcp(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PUT', `/api/v2/sessions/${encodeURIComponent(id)}/mcp`, body);
  }

  // Карта обфускации Gateway (ADR-036) удалённой сессии: право проверяет
  // удалённая сторона (ADMIN/AUDITOR в managed).
  getSessionSecrets(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/secrets`);
  }

  // Панельные `:id`-маршруты удалённой сессии (ADR-042): вкладки «Сессия»,
  // «Статистика», «Контекст», «Ссылки», док вопросов. Идентификаторы внутри
  // ответа принадлежат удалённому миру — префикс `remote:` ставит вызывающий.
  getSessionStatus(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/status`);
  }

  getSessionPrompt(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/prompt`);
  }

  getSessionStats(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/stats`);
  }

  getSessionNotes(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/notes`);
  }

  createSessionNote(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/notes`, body);
  }

  updateSessionNote(id: string, noteId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'PATCH',
      `/api/v2/sessions/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
      body,
    );
  }

  deleteSessionNote(id: string, noteId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/api/v2/sessions/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
    );
  }

  getSessionMessage(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'GET',
      `/api/v2/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  clearSession(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/clear`);
  }

  resumeSubagent(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/resume-subagent`);
  }

  getSessionChildren(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/children`);
  }

  getSessionTree(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/tree`);
  }

  forkSession(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/fork`, body);
  }

  getSessionReferences(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/references`);
  }

  addSessionReference(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/references`, body);
  }

  removeSessionReference(id: string, refSessionId: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/api/v2/sessions/${encodeURIComponent(id)}/references/${encodeURIComponent(refSessionId)}`,
    );
  }

  mergeSessionMessages(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/messages/merge`, body);
  }

  listSessionQuestions(
    id: string,
    params?: { status?: string; limit?: number | string },
  ): Promise<unknown> {
    const query = new URLSearchParams();
    if (params?.status !== undefined) query.set('status', params.status);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/questions${suffix}`);
  }

  answerSessionQuestion(id: string, questionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/answer`,
      body,
    );
  }

  cancelSessionQuestion(id: string, questionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/cancel`,
      body,
    );
  }

  // Проектный скоуп MCP (ADR-071 §2.4) удалённого проекта.
  getProjectMcp(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/projects/${encodeURIComponent(id)}/mcp`);
  }

  updateProjectMcp(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PUT', `/api/v2/projects/${encodeURIComponent(id)}/mcp`, body);
  }

  // Проектный скоуп скиллов (ADR-046 §4.5) удалённого проекта.
  getProjectSkills(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/projects/${encodeURIComponent(id)}/skills`);
  }

  updateProjectSkills(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PUT', `/api/v2/projects/${encodeURIComponent(id)}/skills`, body);
  }

  // Worktree'ы удалённого проекта (ADR-114): операции исполняются сервером
  // (в managed backend — тот же `WorktreeService`).
  listProjectWorktrees(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/projects/${encodeURIComponent(id)}/worktrees`);
  }

  createProjectWorktree(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/projects/${encodeURIComponent(id)}/worktrees`, body);
  }

  pruneProjectWorktrees(id: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/projects/${encodeURIComponent(id)}/worktrees/prune`, body ?? {});
  }

  removeProjectWorktree(id: string, worktreeId: string, opts?: { force?: boolean }): Promise<void> {
    const suffix = opts?.force ? '?force=true' : '';
    return this.request<void>(
      'DELETE',
      `/api/v2/projects/${encodeURIComponent(id)}/worktrees/${encodeURIComponent(worktreeId)}${suffix}`,
    );
  }

  // Пайплайны проекта (ADR-101): список/деталь/публикация.
  listProjectPipelines(
    id: string,
    params?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const query: string[] = [];
    if (params?.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.offset !== undefined) query.push(`offset=${encodeURIComponent(String(params.offset))}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    return this.request<unknown>(
      'GET',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines${suffix}`,
    );
  }

  createProjectPipeline(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/projects/${encodeURIComponent(id)}/pipelines`, body);
  }

  getProjectPipeline(id: string, pipelineId: string): Promise<unknown> {
    return this.request<unknown>(
      'GET',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}`,
    );
  }

  updateProjectPipeline(
    id: string,
    pipelineId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(
      'PUT',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}`,
      body,
    );
  }

  deleteProjectPipeline(id: string, pipelineId: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}`,
    );
  }

  publishProjectPipeline(id: string, pipelineId: string): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}/publish`,
    );
  }

  // Прогоны пайплайнов проекта (ADR-101).
  listPipelineRuns(
    id: string,
    pipelineId: string,
    params?: { limit?: number; offset?: number; status?: string },
  ): Promise<unknown> {
    const query: string[] = [];
    if (params?.limit !== undefined) query.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.offset !== undefined) query.push(`offset=${encodeURIComponent(String(params.offset))}`);
    if (params?.status) query.push(`status=${encodeURIComponent(params.status)}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    return this.request<unknown>(
      'GET',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}/runs${suffix}`,
    );
  }

  startPipelineRun(
    id: string,
    pipelineId: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/projects/${encodeURIComponent(id)}/pipelines/${encodeURIComponent(pipelineId)}/runs`,
      body ?? {},
    );
  }

  getPipelineRun(
    runId: string,
    params?: { eventsLimit?: number; eventsBefore?: string },
  ): Promise<unknown> {
    const query: string[] = [];
    if (params?.eventsLimit !== undefined) {
      query.push(`events_limit=${encodeURIComponent(String(params.eventsLimit))}`);
    }
    if (params?.eventsBefore) query.push(`events_before=${encodeURIComponent(params.eventsBefore)}`);
    const suffix = query.length > 0 ? `?${query.join('&')}` : '';
    return this.request<unknown>('GET', `/api/v2/pipeline-runs/${encodeURIComponent(runId)}${suffix}`);
  }

  resumePipelineRun(runId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/pipeline-runs/${encodeURIComponent(runId)}/resume`,
      body,
    );
  }

  cancelPipelineRun(runId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/pipeline-runs/${encodeURIComponent(runId)}/cancel`);
  }

  /**
   * Шаблоны пайплайнов инстанса (ADR-101).
   *
   * `projectId` — необязательная подсказка: если он указывает на удалённый
   * проект, вызывающий проксирует запрос сюда (сервер проигнорирует параметр
   * `project_id` — шаблоны инстансные).
   */
  listPipelineTemplates(): Promise<unknown> {
    return this.request<unknown>('GET', '/api/v2/pipeline-templates');
  }

  instantiatePipelineTemplate(templateId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/pipeline-templates/${encodeURIComponent(templateId)}/instantiate`,
      body,
    );
  }

  // Портал памяти удалённого инстанса (ADR-107): только мутации индексов —
  // чтение портала (`GET /indexes|/facts|/graph|/status`) остаётся локальным.

  createMemoryIndex(body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/memory/indexes', body);
  }

  updateMemoryIndex(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/v2/memory/indexes/${encodeURIComponent(id)}`, body);
  }

  rebuildMemoryIndex(id: string, body?: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/memory/indexes/${encodeURIComponent(id)}/rebuild`,
      body ?? {},
    );
  }

  deleteMemoryIndex(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v2/memory/indexes/${encodeURIComponent(id)}`);
  }

  // Сообщения
  messagesBatch(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/messages/${encodeURIComponent(sessionId)}/batch`, body);
  }

  messageToggle(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'PATCH',
      `/api/v2/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/toggle`,
    );
  }

  messagePin(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'PATCH',
      `/api/v2/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/pin`,
    );
  }

  messageDelete(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'DELETE',
      `/api/v2/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`,
    );
  }

  messageRetry(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/v2/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/retry`,
    );
  }

  messageDebug(sessionId: string, messageId: string): Promise<unknown> {
    return this.request<unknown>(
      'GET',
      `/api/v2/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/debug`,
    );
  }

  // Очередь
  queueClear(sessionId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/clear`);
  }

  async queueReturn(sessionId: string, target?: QueueTarget): Promise<unknown> {
    const base = `/api/v2/queue/${encodeURIComponent(sessionId)}/return`;
    let qs = '';
    if (typeof target === 'number') {
      assertQueueIndex(target);
      qs = `?index=${target}`;
    } else if (target && typeof target === 'object') {
      if (typeof target.id === 'string' && target.id !== '') {
        qs = `?id=${encodeURIComponent(target.id)}`;
      } else if (target.index !== undefined) {
        assertQueueIndex(target.index);
        qs = `?index=${target.index}`;
      }
    }
    return this.request<unknown>('POST', `${base}${qs}`);
  }

  /** ADR-104: отправить сообщение из очереди «в разрыв» активного хода. */
  async queueSteer(sessionId: string, target?: QueueTarget): Promise<unknown> {
    let body: { id: string } | { index: number } | Record<string, never> = {};
    if (typeof target === 'number') {
      assertQueueIndex(target);
      body = { index: target };
    } else if (target && typeof target.id === 'string' && target.id !== '') {
      body = { id: target.id };
    } else if (target && target.index !== undefined) {
      assertQueueIndex(target.index);
      body = { index: target.index };
    }
    return this.request<unknown>(
      'POST',
      `/api/v2/queue/${encodeURIComponent(sessionId)}/steer`,
      body,
    );
  }

  queueResume(sessionId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/resume`);
  }

  queueRetryNow(sessionId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/retry-now`);
  }

  queueCancelRetry(sessionId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/cancel-retry`);
  }

  // Файлы (контракт backend routes/fs.ts: query `project_id`+`path`; body `projectId`)
  fsList(params: { projectId: string; path?: string }): Promise<unknown> {
    const qs = new URLSearchParams({ project_id: params.projectId });
    if (params.path) qs.set('path', params.path);
    return this.request<unknown>('GET', `/api/v2/fs?${qs.toString()}`);
  }

  fsRead(params: { projectId: string; path: string }): Promise<unknown> {
    const qs = new URLSearchParams({ project_id: params.projectId, path: params.path });
    return this.request<unknown>('GET', `/api/v2/fs/read?${qs.toString()}`);
  }

  /**
   * Запись текстового файла. `opts.timeoutMs` — перенос проекта задаёт
   * увеличенный таймаут (крупный файл на медленном канале не влезает в дефолт).
   */
  fsWrite(
    body: { projectId: string; path: string; content: string },
    opts?: RequestOptions,
  ): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/write', body, opts);
  }

  fsDelete(params: { projectId: string; path: string }): Promise<unknown> {
    const qs = new URLSearchParams({ project_id: params.projectId, path: params.path });
    return this.request<unknown>('DELETE', `/api/v2/fs?${qs.toString()}`);
  }

  fsMkdir(body: { projectId: string; path: string }): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/mkdir', body);
  }

  fsMove(body: { projectId: string; sourcePath: string; targetPath: string }): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/move', body);
  }

  /** Скачивание файла: raw Response (бинарный поток с Content-Disposition). */
  fsDownload(params: { projectId: string; path: string }, opts?: RequestOptions): Promise<Response> {
    const qs = new URLSearchParams({ project_id: params.projectId, path: params.path });
    return this.request<Response>('GET', `/api/v2/fs/download?${qs.toString()}`, undefined, {
      raw: true,
      ...opts,
    });
  }

  /**
   * Предпросмотр файла: raw Response (байты потоком, inline-MIME, `Range`/`206`).
   * Заголовок `Range` пробрасывается как есть (`opts.headers`) — иначе seek в
   * видео на удалённом мире не работал бы.
   */
  fsRaw(params: { projectId: string; path: string }, opts?: RequestOptions): Promise<Response> {
    const qs = new URLSearchParams({ project_id: params.projectId, path: params.path });
    return this.request<Response>('GET', `/api/v2/fs/raw?${qs.toString()}`, undefined, {
      raw: true,
      ...opts,
    });
  }

  /**
   * Загрузка файла: multipart FormData пробрасывается как есть (rawBody).
   * `opts.timeoutMs` — перенос проекта задаёт увеличенный таймаут (большой
   * бинарь на медленном канале не влезает в дефолт).
   */
  fsUpload(formData: FormData, opts?: RequestOptions): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/upload', undefined, {
      rawBody: formData,
      ...opts,
    });
  }

  /** Создать каталог в корне workspace backend (для проекта без существующего workspace). */
  fsWorkspaceMkdir(body: { path: string }): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/workspace-root/mkdir', body);
  }

  // --- PROP-125: серверные MCP-серверы гибрида (режим `tools`) ---

  /**
   * Состав серверных MCP-серверов (`GET /api/v2/mcp/remote/servers`).
   *
   * Отдаёт **все** записи реестра сервера (решение 10 владельца) без секретов
   * и URL с креденшелами (ADR-105) — их в выдаче нет по построению.
   *
   * Таймаут 60 с — как у подключения MCP-сервера (`McpClient.connect`).
   */
  getRemoteMcpServers(): Promise<RemoteMcpServerInfo[]> {
    return this.request<RemoteMcpServerInfo[]>('GET', '/api/v2/mcp/remote/servers', undefined, {
      timeoutMs: 60_000,
    });
  }

  /**
   * Схемы инструментов серверного MCP-сервера (`GET /api/v2/mcp/remote/tools`).
   *
   * Имя сервера — query-параметр `server` (экранируется): в реестре имя —
   * точный ключ, пробелы и спецсимволы допустимы.
   */
  getRemoteMcpTools(server: string): Promise<RemoteMcpToolsResponse> {
    return this.request<RemoteMcpToolsResponse>(
      'GET',
      `/api/v2/mcp/remote/tools?server=${encodeURIComponent(server)}`,
      undefined,
      { timeoutMs: 60_000 },
    );
  }

  /**
   * Вызов инструмента серверного MCP-сервера (`POST /api/v2/mcp/remote/call`).
   *
   * Формат результата — тот же, что у протокола исполнителя 5
   * (`{content, isError, attachments?}`), таймаут вызова — 120 с (как у
   * `McpClient.callTool`).
   */
  callRemoteMcp(body: RemoteMcpCallRequest): Promise<RemoteMcpCallResult> {
    return this.request<RemoteMcpCallResult>('POST', '/api/v2/mcp/remote/call', body, {
      timeoutMs: 120_000,
    });
  }

  /**
   * Возможности инстанса (`GET /api/v2/meta`).
   *
   * PROP-125 §3: `features.remoteMcp` — признак поддержки
   * `/api/v2/mcp/remote/*`; у старого backend'а поля нет — фича молча
   * выключена (fail-closed, без шума в UI).
   */
  getCapabilities(): Promise<InstanceCapabilities> {
    return this.request<InstanceCapabilities>('GET', '/api/v2/meta', undefined, {
      timeoutMs: 5_000,
    });
  }

  /** Быстрая проверка доступности backend (GET /health, короткий таймаут). */
  async isReachable(): Promise<boolean> {
    try {
      const res = await egressFetch(new URL('/health', this._backendUrl), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
