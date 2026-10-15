/**
 * @itphx/synth-sdk — типизированный клиент публичного API Synth (ADR-052).
 *
 * Runtime-agnostic: использует глобальный `fetch` (инъекция — для тестов и
 * кастомных рантаймов), ESM-only, без Node-only импортов на верхнем уровне.
 * Публичный контракт — `packages/core/src/server/openapi/public-openapi.ts`.
 */
import {
  HTTP_ERROR_CODE,
  NETWORK_ERROR_CODE,
  SynthApiError,
  parseErrorBody,
} from './errors.js';
import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
  EventBinding,
  EventBindingApiKey,
  EventBindingApiKeyCreateRequest,
  EventBindingApiKeyCreated,
  EventBindingApiKeyUpdateRequest,
  EventBindingInputRequest,
  EventIngestRequest,
  EventIngestResponse,
  EventJournalEntry,
  EventRouteRule,
  EventRouteRuleUpsertRequest,
  Schedule,
  ScheduleInput,
  ScheduleJob,
  SerializedSession,
  SessionCreateInput,
  SessionMessagesResponse,
  SessionPatch,
  SessionPromptInput,
  SessionStatusResponse,
} from './types.js';

/** Базовый путь API v2 по умолчанию. */
export const DEFAULT_API_PATH = '/api/v2';

/** Значения query-параметров (`null`/`undefined` пропускаются). */
export type SynthQuery = Record<string, string | number | boolean | undefined | null>;

/** Опции создания клиента. */
export interface SynthClientOptions {
  /** Базовый URL инстанса, напр. `http://localhost:5000` (без `/api/v2`). */
  baseUrl: string;
  /** JWT/OIDC-токен (интерактивные креды). */
  token?: string;
  /** API-ключ инстанса (`SYNTH_API_KEY`). */
  apiKey?: string;
  /** Scoped service-key `synth_svc_…` (ADR-052). */
  serviceKey?: string;
  /** Инъекция fetch (тесты/нестандартные рантаймы); по умолчанию — глобальный `fetch`. */
  fetch?: typeof fetch;
  /** Базовый путь API (по умолчанию `/api/v2`). */
  apiPath?: string;
}

/** Внутренние опции одного запроса. */
interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: SynthQuery;
  headers?: Record<string, string>;
  /** `true` — вернуть `Response` как есть (например, SSE-поток `prompt`). */
  raw?: boolean;
}

/** Query-параметры списка сессий. */
export interface SessionsListParams {
  project_id?: string;
}

/** Query-параметры журнала событий. */
export interface EventJournalParams {
  limit?: number;
}

/** Query-параметры Job-истории расписания. */
export interface ScheduleJobsParams {
  limit?: number;
}

/** Namespace `events` (ADR-089). */
export interface EventsNamespace {
  /** Приём внешнего события (`POST /events`). */
  ingest(body: EventIngestRequest): Promise<EventIngestResponse>;
  /** Журнал решений Router (`GET /events/journal`). */
  journal(params?: EventJournalParams): Promise<EventJournalEntry[]>;
  bindings: {
    list(): Promise<EventBinding[]>;
    create(body: EventBindingInputRequest): Promise<EventBinding>;
    remove(id: string): Promise<void>;
    keys: {
      list(bindingId: string): Promise<EventBindingApiKey[]>;
      create(bindingId: string, body: EventBindingApiKeyCreateRequest): Promise<EventBindingApiKeyCreated>;
      update(
        bindingId: string,
        keyId: string,
        body: EventBindingApiKeyUpdateRequest,
      ): Promise<EventBindingApiKey>;
      revoke(bindingId: string, keyId: string): Promise<EventBindingApiKey>;
      remove(bindingId: string, keyId: string): Promise<void>;
    };
  };
  routes: {
    list(): Promise<EventRouteRule[]>;
    create(body: EventRouteRuleUpsertRequest): Promise<EventRouteRule>;
    remove(id: string): Promise<void>;
  };
}

/** Namespace `sessions`. */
export interface SessionsNamespace {
  list(params?: SessionsListParams): Promise<SerializedSession[]>;
  create(body: SessionCreateInput): Promise<SerializedSession>;
  get(id: string): Promise<SerializedSession>;
  patch(id: string, body: SessionPatch): Promise<SerializedSession>;
  remove(id: string): Promise<void>;
  /** Отправка сообщения; возвращает SSE-поток (`text/event-stream`) как `Response`. */
  prompt(id: string, body: SessionPromptInput): Promise<Response>;
  messages(id: string): Promise<SessionMessagesResponse>;
  status(id: string): Promise<SessionStatusResponse>;
}

/** Namespace `schedules` (ADR-051). */
export interface SchedulesNamespace {
  list(): Promise<Schedule[]>;
  create(body: ScheduleInput): Promise<Schedule>;
  update(id: string, body: ScheduleInput): Promise<Schedule>;
  remove(id: string): Promise<void>;
  run(id: string): Promise<Schedule>;
  jobs(id: string, params?: ScheduleJobsParams): Promise<ScheduleJob[]>;
}

/** Namespace `llm` (OpenAI-совместимый прокси, ADR-036). */
export interface LlmNamespace {
  chatCompletions(body: ChatCompletionsRequest): Promise<ChatCompletionsResponse>;
}

/** Нормализация базового пути: гарантируем ведущий `/`, убираем завершающий. */
function normalizeApiPath(path: string): string {
  if (!path || path === '/') return '';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+$/, '');
}

/**
 * Клиент публичного API Synth.
 *
 * Приоритет аутентификации: **`serviceKey` → `apiKey` → `token`** — первое
 * заданное значение уходит в `Authorization: Bearer <cred>`.
 */
export class SynthClient {
  /** Базовый URL инстанса без завершающего слэша. */
  readonly baseUrl: string;
  /** Базовый путь API (по умолчанию `/api/v2`). */
  readonly apiPath: string;

  readonly events: EventsNamespace;
  readonly sessions: SessionsNamespace;
  readonly schedules: SchedulesNamespace;
  readonly llm: LlmNamespace;

  private readonly _fetch?: typeof fetch;
  private readonly _token?: string;

  constructor(options: SynthClientOptions) {
    if (!options || typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
      throw new Error('SynthClient: обязателен baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiPath = normalizeApiPath(options.apiPath ?? DEFAULT_API_PATH);
    this._fetch = options.fetch;
    // Приоритет: service-key → apiKey → token.
    this._token = options.serviceKey ?? options.apiKey ?? options.token;

    this.events = {
      ingest: (body) => this._request<EventIngestResponse>('/events', { method: 'POST', body }),
      journal: (params) =>
        this._request<{ entries: EventJournalEntry[] }>('/events/journal', {
          query: params as SynthQuery | undefined,
        }).then((r) => r.entries ?? []),
      bindings: {
        list: () =>
          this._request<{ bindings: EventBinding[] }>('/events/bindings').then(
            (r) => r.bindings ?? [],
          ),
        create: (body) =>
          this._request<EventBinding>('/events/bindings', { method: 'POST', body }),
        remove: (id) =>
          this._request<void>(`/events/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        keys: {
          list: (bindingId) =>
            this._request<{ keys: EventBindingApiKey[] }>(
              `/events/bindings/${encodeURIComponent(bindingId)}/keys`,
            ).then((r) => r.keys ?? []),
          create: (bindingId, body) =>
            this._request<EventBindingApiKeyCreated>(
              `/events/bindings/${encodeURIComponent(bindingId)}/keys`,
              { method: 'POST', body },
            ),
          update: (bindingId, keyId, body) =>
            this._request<EventBindingApiKey>(
              `/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}`,
              { method: 'PATCH', body },
            ),
          revoke: (bindingId, keyId) =>
            this._request<EventBindingApiKey>(
              `/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}/revoke`,
              { method: 'POST' },
            ),
          remove: (bindingId, keyId) =>
            this._request<void>(
              `/events/bindings/${encodeURIComponent(bindingId)}/keys/${encodeURIComponent(keyId)}`,
              { method: 'DELETE' },
            ),
        },
      },
      routes: {
        list: () =>
          this._request<{ rules: EventRouteRule[] }>('/events/routes').then((r) => r.rules ?? []),
        create: (body) =>
          this._request<EventRouteRule>('/events/routes', { method: 'POST', body }),
        remove: (id) =>
          this._request<void>(`/events/routes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      },
    };

    this.sessions = {
      list: (params) =>
        this._request<SerializedSession[]>('/sessions', {
          query: params as SynthQuery | undefined,
        }),
      create: (body) => this._request<SerializedSession>('/sessions', { method: 'POST', body }),
      get: (id) => this._request<SerializedSession>(`/sessions/${encodeURIComponent(id)}`),
      patch: (id, body) =>
        this._request<SerializedSession>(`/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body,
        }),
      remove: (id) =>
        this._request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      prompt: (id, body) =>
        this._request<Response>(`/sessions/${encodeURIComponent(id)}/prompt`, {
          method: 'POST',
          body,
          raw: true,
        }),
      messages: (id) =>
        this._request<SessionMessagesResponse>(`/sessions/${encodeURIComponent(id)}/messages`),
      status: (id) =>
        this._request<SessionStatusResponse>(`/sessions/${encodeURIComponent(id)}/status`),
    };

    this.schedules = {
      list: () =>
        this._request<{ schedules: Schedule[] }>('/schedules').then((r) => r.schedules ?? []),
      create: (body) =>
        this._request<{ schedule: Schedule }>('/schedules', { method: 'POST', body }).then(
          (r) => r.schedule,
        ),
      update: (id, body) =>
        this._request<{ schedule: Schedule }>(`/schedules/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body,
        }).then((r) => r.schedule),
      remove: (id) =>
        this._request<void>(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      run: (id) =>
        this._request<{ schedule: Schedule }>(`/schedules/${encodeURIComponent(id)}/run`, {
          method: 'POST',
        }).then((r) => r.schedule),
      jobs: (id, params) =>
        this._request<{ jobs: ScheduleJob[] }>(`/schedules/${encodeURIComponent(id)}/jobs`, {
          query: params as SynthQuery | undefined,
        }).then((r) => r.jobs ?? []),
    };

    this.llm = {
      chatCompletions: (body) =>
        this._request<ChatCompletionsResponse>('/llm/chat/completions', {
          method: 'POST',
          body,
        }),
    };
  }

  private _resolveFetch(): typeof fetch {
    const impl = this._fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new SynthApiError({
        status: 0,
        code: NETWORK_ERROR_CODE,
        message: 'fetch недоступен: передайте опцию `fetch` в SynthClient',
      });
    }
    return impl;
  }

  private _buildUrl(path: string, query?: SynthQuery): string {
    const base = `${this.baseUrl}${this.apiPath}${path}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async _request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this._buildUrl(path, options.query);
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this._token) headers.Authorization = `Bearer ${this._token}`;

    const fetchImpl = this._resolveFetch();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new SynthApiError({
        status: 0,
        code: NETWORK_ERROR_CODE,
        message: error instanceof Error ? error.message : String(error),
        body: error,
      });
    }

    if (!response.ok) {
      throw await this._httpError(response);
    }
    if (options.raw) {
      return response as unknown as T;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  }

  private async _httpError(response: Response): Promise<SynthApiError> {
    let rawText = '';
    try {
      rawText = await response.text();
    } catch {
      rawText = '';
    }
    let body: unknown;
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    }
    const parsed = parseErrorBody(body);
    return new SynthApiError({
      status: response.status,
      code: parsed.code || HTTP_ERROR_CODE,
      message: parsed.message || `HTTP ${response.status}`,
      body,
    });
  }
}

/** Создать клиент публичного API Synth. */
export function createSynthClient(options: SynthClientOptions): SynthClient {
  return new SynthClient(options);
}
