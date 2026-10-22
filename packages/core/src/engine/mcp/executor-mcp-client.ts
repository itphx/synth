/**
 * MCP-клиент пула исполнителей (ADR-077, шаг B2).
 *
 * В split-топологии MCP-серверы (браузерные Playwright-тулы, tier-4
 * MCP-серверы SCM-хостингов) поднимаются **в исполнителе** — в образе
 * control plane их бинарей нет (шаг B1, `packages/executor/src/mcp.ts`).
 * Поэтому core говорит не по MCP-протоколу, а по HTTP API исполнителя:
 *
 * | Метод | Путь | Назначение |
 * |---|---|---|
 * | `GET` | `/mcp/tools` | инструменты поднятых серверов (ленивый старт) |
 * | `GET` | `/mcp/servers` | состояние серверов (`idle`/`up`/`down`) |
 * | `POST` | `/mcp/call` | вызов инструмента `{server, tool, arguments}` |
 *
 * ## Поверхность — как у `McpClient`
 *
 * Класс реализует `McpClientLike` (`connect()`/`tools`/`callTool()`/
 * `isConnected`/`name`/`instructions`/`disconnect()`), чтобы `McpManager`
 * регистрировал тулы исполнителя **штатным путём** (`{server}_{tool}`,
 * `source:'mcp'`) и не заводил второго пути вызова/permissions (инвариант 5).
 *
 * ## Пул адресов и failover
 *
 * Адреса берутся из `execution.remote.url`. Каждый запрос начинается с
 * очередного адреса (round-robin) и при недоступности (сеть/таймаут/5xx)
 * повторяется на **следующем** — не более одного раза на адрес. Если не
 * ответил никто — ошибка `ExecutorMcpUnavailableError` (никакого «тихого
 * успеха» с пустым результатом). Ответ 4xx — **не** повод для failover:
 * запрос дошёл до исполнителя, повтор лишь задублировал бы вызов.
 *
 * ## Доверие TLS/CA и секреты
 *
 * Все запросы — через `egressFetch` (ADR-099, инвариант 22), а не `fetch`.
 * Bearer-токен исполнителя не логируется и вычищается из текстов ошибок
 * (сервер мог его отразить в теле).
 */

import type { McpClientLike, McpToolDef, McpToolResult } from './client.js';
import { MAX_TOOL_RESULT_CHARS } from './client.js';
import { egressFetch } from '../../security/tls.js';
import { error as logError } from '../../logger.js';

/** Таймаут HTTP-запроса при подключении (как у `McpClient` — 60 c). */
export const EXECUTOR_MCP_CONNECT_TIMEOUT_MS = 60_000;

/** Таймаут вызова инструмента (как у `McpClient` — 120 c). */
export const EXECUTOR_MCP_TOOL_TIMEOUT_MS = 120_000;

/** Транспорт запросов (тесты подменяют, боевой путь — `egressFetch`). */
export type ExecutorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Ошибка недоступности пула исполнителей (все адреса не ответили). */
export class ExecutorMcpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorMcpUnavailableError';
  }
}

/** HTTP-ошибка одного адреса (статус — для решения о failover). */
export class ExecutorMcpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutorMcpHttpError';
  }
}

/** Параметры пула адресов исполнителей. */
export interface ExecutorMcpPoolOptions {
  /** Адреса исполнителей (`execution.remote.url`). */
  urls: string[];
  /** Bearer-токен исполнителя (в ошибки/логи не попадает). */
  token: string;
  /** Транспорт (по умолчанию `egressFetch`, ADR-099). */
  fetchImpl?: ExecutorFetch;
}

/** Статус MCP-сервера у исполнителя (`GET /mcp/servers`). */
export interface ExecutorMcpServerStatus {
  name: string;
  status: 'idle' | 'up' | 'down';
  toolCount: number;
  error?: string;
}

/** Инструмент в плоском виде (`GET /mcp/tools`). */
export interface ExecutorMcpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Ответ `POST /mcp/call`. */
interface ExecutorMcpCallResult {
  content?: unknown;
  isError?: unknown;
}

/**
 * Пул адресов исполнителей: round-robin + failover для HTTP-запросов.
 *
 * Общий для клиента сервера и источника состава серверов — один экземпляр на
 * приложение (без process-глобальных синглтонов, инвариант 24).
 */
export class ExecutorMcpPool {
  private readonly _urls: string[];
  private readonly _token: string;
  private readonly _fetch: ExecutorFetch;
  private _cursor = 0;

  constructor(opts: ExecutorMcpPoolOptions) {
    this._urls = opts.urls.map((url) => url.trim().replace(/\/+$/, '')).filter((url) => url.length > 0);
    this._token = opts.token;
    this._fetch = opts.fetchImpl ?? egressFetch;
  }

  /** Настроенные адреса (без токена). */
  get urls(): string[] {
    return [...this._urls];
  }

  /** Порядок адресов для запроса: очередной первым (round-robin). */
  rotation(): string[] {
    if (this._urls.length === 0) return [];
    const start = this._cursor % this._urls.length;
    this._cursor = (this._cursor + 1) % Math.max(1, this._urls.length);
    return [...this._urls.slice(start), ...this._urls.slice(0, start)];
  }

  /** Запрос к **конкретному** адресу; ошибки не переадресуются. */
  async requestAt<T>(
    baseUrl: string,
    path: string,
    init: { method?: string; body?: string } | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this._fetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this._token}`,
          accept: 'application/json',
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init?.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new ExecutorMcpUnavailableError(
        aborted
          ? `таймаут запроса к исполнителю (${baseUrl}, ${timeoutMs} мс)`
          : this.redact(`исполнитель ${baseUrl} недоступен: ${describeError(err)}`),
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new ExecutorMcpHttpError(
        response.status,
        this.redact(
          `исполнитель ${baseUrl} ответил ${response.status}${extractServerMessage(text)}`,
        ),
      );
    }
    try {
      return (text.length > 0 ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new ExecutorMcpUnavailableError(
        this.redact(`исполнитель ${baseUrl} вернул не-JSON ответ (${path})`),
      );
    }
  }

  /**
   * Запрос с failover по пулу: не более одной попытки на адрес.
   *
   * @throws ExecutorMcpUnavailableError — не ответил ни один адрес;
   * @throws ExecutorMcpHttpError — исполнитель ответил 4xx (повтор не поможет).
   */
  async request<T>(
    path: string,
    init: { method?: string; body?: string } | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const order = this.rotation();
    if (order.length === 0) {
      throw new ExecutorMcpUnavailableError(
        'пул исполнителей не настроен: нет ни одного адреса (execution.remote.url)',
      );
    }
    const failures: string[] = [];
    for (const baseUrl of order) {
      try {
        return await this.requestAt<T>(baseUrl, path, init, timeoutMs);
      } catch (err) {
        if (err instanceof ExecutorMcpHttpError && !isRetryableStatus(err.status)) {
          throw err;
        }
        failures.push(describeError(err));
      }
    }
    throw new ExecutorMcpUnavailableError(
      this.redact(
        `ни один исполнитель пула не ответил (${failures.length} из ${order.length}): ` +
          failures.join('; '),
      ),
    );
  }

  /** Вычистить значение токена из текста (сервер мог его отразить). */
  redact(text: string): string {
    if (this._token.length < 4) return text;
    return text.split(this._token).join('***');
  }
}

/** 5xx/429 — повод попробовать другой адрес; прочие 4xx — нет. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Текст ошибки исполнителя (`{error:{message}}`) — без разбора всего тела. */
function extractServerMessage(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === 'string' && message.length > 0) return `: ${message}`;
  } catch {
    // не JSON — детали не добавляем
  }
  return '';
}

/**
 * MCP-клиент одного сервера исполнителя (поверхность `McpClientLike`).
 *
 * `_meta` (`synth/session_id`) в API исполнителя **не передаётся**: протокол
 * шага B1 (`McpCallRequestBody`) полей кроме `server`/`tool`/`arguments` не
 * принимает, а выдумывать поле нельзя. Остаток зафиксирован в отчёте задачи.
 */
export class ExecutorMcpClient implements McpClientLike {
  private readonly _name: string;
  private readonly _pool: ExecutorMcpPool;
  private readonly _connectTimeoutMs: number;
  private readonly _toolTimeoutMs: number;
  private _tools: McpToolDef[] = [];
  private _connected = false;
  private _status: 'idle' | 'up' | 'down' = 'idle';
  private _serverError: string | undefined;

  constructor(
    name: string,
    pool: ExecutorMcpPool,
    opts: { connectTimeoutMs?: number; toolTimeoutMs?: number } = {},
  ) {
    this._name = name;
    this._pool = pool;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? EXECUTOR_MCP_CONNECT_TIMEOUT_MS;
    this._toolTimeoutMs = opts.toolTimeoutMs ?? EXECUTOR_MCP_TOOL_TIMEOUT_MS;
  }

  get name(): string {
    return this._name;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get tools(): McpToolDef[] {
    return this._tools;
  }

  /** Инструкции MCP-сервера: API исполнителя их не отдаёт (шаг B1). */
  get instructions(): string | undefined {
    return undefined;
  }

  /** Статус сервера у исполнителя (последний `GET /mcp/servers`). */
  get serverStatus(): 'idle' | 'up' | 'down' {
    return this._status;
  }

  /** Причина падения сервера у исполнителя (без секретов). */
  get serverError(): string | undefined {
    return this._serverError;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    // `/mcp/tools` поднимает серверы лениво; `/mcp/servers` даёт их состояние.
    // Запросы независимы — идём параллельно (каждый со своим failover).
    const [tools, servers] = await Promise.all([
      this._pool.request<ExecutorMcpToolInfo[]>(
        '/mcp/tools',
        { method: 'GET' },
        this._connectTimeoutMs,
      ),
      this._pool.request<ExecutorMcpServerStatus[]>(
        '/mcp/servers',
        { method: 'GET' },
        this._connectTimeoutMs,
      ),
    ]);

    const status = Array.isArray(servers)
      ? servers.find((item) => item?.name === this._name)
      : undefined;
    this._status = status?.status ?? 'idle';
    this._serverError = typeof status?.error === 'string' ? status.error : undefined;

    this._tools = (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool?.server === this._name)
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));

    if (this._status === 'down') {
      throw new Error(
        this._pool.redact(
          `MCP-сервер "${this._name}" у исполнителя недоступен: ` +
            `${this._serverError ?? 'сервер не поднят'}`,
        ),
      );
    }

    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._tools = [];
    this._connected = false;
    this._status = 'idle';
    this._serverError = undefined;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    // API исполнителя не принимает `_meta` — параметр оставлен для совместимости
    // поверхности `McpClient` (см. докстринг класса).
    void meta;

    if (!this._connected) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }

    try {
      const result = await this._pool.request<ExecutorMcpCallResult>(
        '/mcp/call',
        {
          method: 'POST',
          body: JSON.stringify({ server: this._name, tool: name, arguments: args }),
        },
        this._toolTimeoutMs,
      );

      const raw = typeof result?.content === 'string' ? result.content : '';
      const isError = result?.isError === true;
      let content = raw;
      if (!content) {
        content = isError ? 'Инструмент вернул ошибку' : 'Инструмент выполнен (пустой результат)';
      }
      if (content.length > MAX_TOOL_RESULT_CHARS) {
        content =
          content.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n\n...(усечено, полный размер: ${content.length} символов)`;
      }
      return { content, isError };
    } catch (err) {
      const msg =
        err instanceof ExecutorMcpHttpError && err.status === 404
          ? `MCP-сервер "${this._name}" или инструмент "${name}" не найден у исполнителя`
          : this._pool.redact(describeError(err));
      logError(`MCP`, `Ошибка вызова "${name}" на сервере "${this._name}" (исполнитель): ${msg}`);
      return { content: `Ошибка: ${msg}`, isError: true };
    }
  }
}
