// HTTP-клиент к API v2 удалённого backend (гибридный режим).
// Сетевые ошибки → RemoteError('OFFLINE'), 401 → RemoteError('UNAUTHORIZED'),
// остальные не-OK → RemoteError('HTTP_<status>').

import { RemoteError } from './types.js';
import { CURRENCIES, type Currency } from '@itphx/synth-shared';
// ADR-099: запросы к удалённому backend — через единый транспорт доверия TLS/CA.
import { egressFetch } from '../security/tls.js';

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
}

export interface RemoteAuthStatus {
  oidc_enabled: boolean;
  authenticated: boolean;
  user?: { id: string; username: string; roles: string[] } | null;
}

/** Плоская запись провайдера с удалённого backend (GET /api/v2/providers). */
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
  /** Таймаут конкретного запроса в мс (переопределяет дефолт); 0 — без таймаута. */
  timeoutMs?: number;
  /** Сырое тело вместо JSON-сериализации (multipart/FormData и т.п.). */
  rawBody?: RequestInit['body'];
}

export class RemoteBackendClient {
  private readonly _backendUrl: string;
  private readonly _getToken: () => Promise<string | null>;
  private readonly _timeoutMs: number;

  constructor(options: RemoteClientOptions) {
    this._backendUrl = options.backendUrl.replace(/\/+$/, '');
    this._getToken = options.getToken;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = new URL(path, this._backendUrl).toString();

    const token = await this._getToken();
    const headers: Record<string, string> = {};
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
      throw new RemoteError(`Сервер недоступен: ${reason}`, 'OFFLINE');
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (res.status === 401) {
      throw new RemoteError('Не авторизован на удалённом сервере', 'UNAUTHORIZED');
    }
    if (!res.ok) {
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

  // --- Методы для будущей агрегации миров (Part 2) ---

  /** Статус аутентификации на backend (GET /auth/status). */
  getAuthStatus(opts?: RequestOptions): Promise<RemoteAuthStatus> {
    return this.request<RemoteAuthStatus>('GET', '/auth/status', undefined, opts);
  }

  /** Модель на удалённом backend (плоская запись из групп /api/v2/models). */
  listModels(opts?: RequestOptions): Promise<RemoteModelInfo[]> {
    return this.request<{ groups?: Array<{ models?: Array<Record<string, unknown>> }> }>(
      'GET',
      '/api/v2/models',
      undefined,
      opts,
    ).then((data) =>
      (data?.groups ?? []).flatMap((g) => g.models ?? []).map((m) => ({
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
      })).filter((m) => m.id !== ''),
    );
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

  listProjects(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/api/v2/projects');
  }

  listSessions(projectId?: string): Promise<unknown[]> {
    const path = projectId
      ? `/api/v2/sessions?project_id=${encodeURIComponent(projectId)}`
      : '/api/v2/sessions';
    return this.request<unknown[]>('GET', path);
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

  summarizeSession(id: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/sessions/${encodeURIComponent(id)}/summarize`);
  }

  getSessionMessages(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/messages`);
  }

  /** Полный экспорт сессии для переноса между мирами (publish/fork). */
  exportSession(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/sessions/${encodeURIComponent(id)}/export`);
  }

  /** Импорт сессии: body = экспорт + { import: { project_id } }. Создаёт сессию с историей. */
  importSession(body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/sessions/import', body);
  }

  // Проекты
  getProject(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/projects/${encodeURIComponent(id)}`);
  }

  updateProject(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('PUT', `/api/v2/projects/${encodeURIComponent(id)}`, body);
  }

  deleteProject(id: string): Promise<void> {
    return this.request<void>('DELETE', `/api/v2/projects/${encodeURIComponent(id)}`);
  }

  // Сообщения
  messagesBatch(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/messages/${encodeURIComponent(sessionId)}/batch`, body);
  }

  messageToggle(sessionId: string, index: number): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/v2/messages/${encodeURIComponent(sessionId)}/${index}/toggle`);
  }

  messagePin(sessionId: string, index: number): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/v2/messages/${encodeURIComponent(sessionId)}/${index}/pin`);
  }

  messageDelete(sessionId: string, index: number): Promise<unknown> {
    return this.request<unknown>('DELETE', `/api/v2/messages/${encodeURIComponent(sessionId)}/${index}`);
  }

  messageRetry(sessionId: string, index: number): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/messages/${encodeURIComponent(sessionId)}/${index}/retry`);
  }

  messageDebug(sessionId: string, index: number): Promise<unknown> {
    return this.request<unknown>('GET', `/api/v2/messages/${encodeURIComponent(sessionId)}/${index}/debug`);
  }

  // Очередь
  queueClear(sessionId: string): Promise<unknown> {
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/clear`);
  }

  queueReturn(sessionId: string, index?: number): Promise<unknown> {
    const qs = index !== undefined ? `?index=${index}` : '';
    return this.request<unknown>('POST', `/api/v2/queue/${encodeURIComponent(sessionId)}/return${qs}`);
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

  fsWrite(body: { projectId: string; path: string; content: string }): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/write', body);
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

  /** Загрузка файла: multipart FormData пробрасывается как есть (rawBody). */
  fsUpload(formData: FormData): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/upload', undefined, { rawBody: formData });
  }

  /** Создать каталог в корне workspace backend (для проекта без существующего workspace). */
  fsWorkspaceMkdir(body: { path: string }): Promise<unknown> {
    return this.request<unknown>('POST', '/api/v2/fs/workspace-root/mkdir', body);
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
