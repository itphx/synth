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
 *
 * ## Пул под цель вызова (PROP-135 слайс 5b-2)
 *
 * Discovery (`/mcp/tools`, `/mcp/servers`) идёт **с инстанс-пула** — как
 * раньше. А **вызов** инструмента (`/mcp/call`) может идти с **проектного**
 * пула: у пула есть резолвер (`resolve`), который по `projectId` отдаёт
 * адреса и токен другого пула (браузерный пул — `project:<id>:browser:<profile>`,
 * ADR-077 шаг B2 + PROP-135 слайс 5b-1). Резолв кэшируется на 60 с.
 *
 * Правила:
 *
 * - `target.projectId` не задан → адреса/токен **инстанс-пула** (прежнее
 *   поведение);
 * - задан → резолв; **тихого фоллбэка на инстанс-пул нет**: нет пула —
 *   ошибка вызова (`isError`), а не вызов чужого пула;
 * - ошибка резолва не ломает discovery: discovery всегда идёт с инстанс-пула.
 *
 * ## Вложения (ADR-115, протокол 5)
 *
 * Исполнитель отдаёт нетекстовые блоки MCP-результата (`image`/`audio`/
 * `resource.blob`) полем `attachments[]` в ответе `POST /mcp/call`
 * (`features.mcpAttachments`, протокол 5). Здесь они разбираются и
 * пробрасываются в `McpToolResult.attachments` без декодирования — в
 * blob-хранилище их пишет `McpManager` через `AttachmentService`.
 * **Деградация:** исполнитель протокола ≤ 4 поля не отдаёт — результат
 * остаётся текстовым, вызов не падает (проверять версию для этого не нужно:
 * поле аддитивное).
 */

import type { McpAttachmentPayload, McpClientLike, McpToolDef, McpToolResult } from './client.js';
import { MAX_TOOL_RESULT_CHARS } from './client.js';
import { egressFetch } from '../../security/tls.js';
import { error as logError } from '../../logger.js';

/** Таймаут HTTP-запроса при подключении (как у `McpClient` — 60 c). */
export const EXECUTOR_MCP_CONNECT_TIMEOUT_MS = 60_000;

/** Таймаут вызова инструмента (как у `McpClient` — 120 c). */
export const EXECUTOR_MCP_TOOL_TIMEOUT_MS = 120_000;

/** Транспорт запросов (тесты подменяют, боевой путь — `egressFetch`). */
export type ExecutorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Резолв адресов/токена пула под цель вызова (PROP-135 слайс 5b-2).
 *
 * Вызывается только при заданном `target.projectId`: возвращает адреса и
 * токен **проектного** пула (браузерный — `project:<id>:browser:<profile>`).
 * `undefined` — пула нет (инстанс без удалённого пула): вызов падает с
 * ошибкой, **без** тихого фоллбэка на инстанс-пул.
 */
export type ExecutorMcpPoolResolver = (
  target: { projectId?: string },
) => Promise<{ urls: string[]; token: string } | undefined>;

/**
 * TTL кэша резолва пула, мс.
 *
 * Столько же, сколь у `POOL_REF_TTL_MS` роутера (PROP-135 слайс 5b-1): адрес
 * пула меняется редко, а устаревшая ссылка на минуту не ломает вызов (пул
 * пересоздастся у provisioner'а).
 */
export const EXECUTOR_MCP_POOL_RESOLVE_TTL_MS = 60_000;

/** Ошибка резолва пула под цель вызова (нет пула/адреса). */
export class ExecutorMcpPoolResolveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutorMcpPoolResolveError';
  }
}

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
  /**
   * Резолв пула под цель вызова (PROP-135 слайс 5b-2): по `projectId` —
   * адреса и токен **проектного** пула (браузерного).
   *
   * Не задан — вызовы идут с инстанс-пула (прежнее поведение). Задан, но
   * резолв не удался → **ошибка вызова**, без отката на инстанс-пул.
   */
  resolve?: ExecutorMcpPoolResolver;
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
  /**
   * ADR-115 (протокол 5): нетекстовые вложения MCP-результата. Старый
   * исполнитель поля не отдаёт — работаем как прежде (только текст).
   */
  attachments?: unknown;
}

/**
 * Разобрать `attachments` ответа исполнителя.
 *
 * Валидация структурная (mime/base64 — непустые строки): байты заново не
 * декодируются, кап объёма уже применён исполнителем, а настоящий лимит файла
 * проверит `AttachmentService.upload` на стороне control plane (единственная
 * точка записи). Некорректные записи пропускаются — результат вызова важнее.
 */
function parseAttachments(raw: unknown): McpAttachmentPayload[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attachments: McpAttachmentPayload[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const mime = typeof item.mime === 'string' && item.mime.length > 0 ? item.mime : undefined;
    const base64 = typeof item.base64 === 'string' && item.base64.length > 0 ? item.base64 : undefined;
    if (!mime || !base64) continue;
    const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : undefined;
    attachments.push({ mime, base64, ...(name ? { name } : {}) });
  }
  return attachments.length > 0 ? attachments : undefined;
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
  /** Резолв проектного пула (PROP-135 слайс 5b-2); не задан — инстанс-пул. */
  private readonly _resolve: ExecutorMcpPoolResolver | undefined;
  /** Кэш резолва по `projectId` (TTL — `EXECUTOR_MCP_POOL_RESOLVE_TTL_MS`). */
  private readonly _resolved = new Map<string, { urls: string[]; token: string; at: number }>();
  private _cursor = 0;

  constructor(opts: ExecutorMcpPoolOptions) {
    this._urls = opts.urls.map((url) => url.trim().replace(/\/+$/, '')).filter((url) => url.length > 0);
    this._token = opts.token;
    this._fetch = opts.fetchImpl ?? egressFetch;
    this._resolve = opts.resolve;
  }

  /** Настроенные адреса (без токена). */
  get urls(): string[] {
    return [...this._urls];
  }

  /** Порядок адресов для запроса: очередной первым (round-robin). */
  rotation(urls: string[] = this._urls): string[] {
    if (urls.length === 0) return [];
    const start = this._cursor % urls.length;
    this._cursor = (this._cursor + 1) % Math.max(1, urls.length);
    return [...urls.slice(start), ...urls.slice(0, start)];
  }

  /** Запрос к **конкретному** адресу; ошибки не переадресуются. */
  async requestAt<T>(
    baseUrl: string,
    path: string,
    init: { method?: string; body?: string } | undefined,
    timeoutMs: number,
    token?: string,
  ): Promise<T> {
    const authToken = token ?? this._token;
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this._fetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          authorization: `Bearer ${authToken}`,
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
          : this.redact(`исполнитель ${baseUrl} недоступен: ${describeError(err)}`, authToken),
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
          authToken,
        ),
      );
    }
    try {
      return (text.length > 0 ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new ExecutorMcpUnavailableError(
        this.redact(`исполнитель ${baseUrl} вернул не-JSON ответ (${path})`, authToken),
      );
    }
  }

  /**
   * Запрос с failover по пулу: не более одной попытки на адрес.
   *
   * `target` (PROP-135 слайс 5b-2) — цель вызова: при заданном `projectId`
   * адреса и токен берутся у **резолвера** (проектный пул), иначе — у
   * инстанс-пула (прежнее поведение).
   *
   * @throws ExecutorMcpUnavailableError — не ответил ни один адрес;
   * @throws ExecutorMcpHttpError — исполнитель ответил 4xx (повтор не поможет);
   * @throws ExecutorMcpPoolResolveError — не удалось получить пул цели.
   */
  async request<T>(
    path: string,
    init: { method?: string; body?: string } | undefined,
    timeoutMs: number,
    target?: { projectId?: string },
  ): Promise<T> {
    const resolved = await this._resolveTarget(target);
    const urls = resolved.urls;
    const token = resolved.token;
    const order = this.rotation(urls);
    if (order.length === 0) {
      throw new ExecutorMcpUnavailableError(
        'пул исполнителей не настроен: нет ни одного адреса (execution.remote.url)',
      );
    }
    const failures: string[] = [];
    for (const baseUrl of order) {
      try {
        return await this.requestAt<T>(baseUrl, path, init, timeoutMs, token);
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
        token,
      ),
    );
  }

  /**
   * Адреса и токен пула под цель вызова (PROP-135 слайс 5b-2).
   *
   * Без `target.projectId` (или без резолвера) — инстанс-пул. С `projectId` —
   * резолв (с кэшем на 60 с). Резолв не удался → **ошибка**: тихого отката
   * на инстанс-пул нет (иначе вызов браузерного тула ушёл бы в чужой пул).
   */
  private async _resolveTarget(target?: { projectId?: string }): Promise<{ urls: string[]; token: string }> {
    const projectId = (target?.projectId ?? '').trim();
    const resolver = this._resolve;
    if (!resolver || projectId === '') {
      return { urls: this._urls, token: this._token };
    }
    const cached = this._resolved.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < EXECUTOR_MCP_POOL_RESOLVE_TTL_MS) {
      return { urls: cached.urls, token: cached.token };
    }
    let ref: { urls: string[]; token: string } | undefined;
    try {
      ref = await resolver({ projectId });
    } catch (err) {
      throw new ExecutorMcpPoolResolveError(
        `не удалось получить пул исполнителя для проекта "${projectId}": ` +
          describeError(err),
        { cause: err },
      );
    }
    const urls = (ref?.urls ?? [])
      .map((url) => url.trim().replace(/\/+$/, ''))
      .filter((url) => url.length > 0);
    if (urls.length === 0) {
      throw new ExecutorMcpPoolResolveError(
        `пул исполнителя для проекта "${projectId}" недоступен: адрес не выдан`,
      );
    }
    const info = { urls, token: ref?.token ?? '', at: Date.now() };
    this._resolved.set(projectId, info);
    return { urls: info.urls, token: info.token };
  }

  /**
   * Вычистить значение токена из текста (сервер мог его отразить).
   *
   * Вычищаются **все** известные пулу токены: инстанс-пула и уже зарезолвленных
   * проектных пулов (их токены выдаёт provisioner'а — они тоже секреты).
   */
  redact(text: string, token?: string): string {
    const tokens = [token ?? this._token];
    for (const entry of this._resolved.values()) tokens.push(entry.token);
    let out = text;
    for (const value of tokens) {
      if (!value || value.length < 4) continue;
      out = out.split(value).join('***');
    }
    return out;
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
    target?: { projectId?: string },
  ): Promise<McpToolResult> {
    // API исполнителя не принимает `_meta` — параметр оставлен для совместимости
    // поверхности `McpClient` (см. докстринг класса).
    void meta;

    if (!this._connected) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }

    try {
      // PROP-135 слайс 5b-2: с `projectId` вызов уходит в **проектный**
      // (браузерный) пул; без него — в инстанс-пул (прежнее поведение).
      const result = await this._pool.request<ExecutorMcpCallResult>(
        '/mcp/call',
        {
          method: 'POST',
          body: JSON.stringify({ server: this._name, tool: name, arguments: args }),
        },
        this._toolTimeoutMs,
        target,
      );

      const raw = typeof result?.content === 'string' ? result.content : '';
      const isError = result?.isError === true;
      const attachments = isError ? undefined : parseAttachments(result?.attachments);
      let content = raw;
      if (!content) {
        content = isError
          ? 'Инструмент вернул ошибку'
          : attachments
            ? `Инструмент вернул ${attachments.length} вложений (текста нет)`
            : 'Инструмент выполнен (пустой результат)';
      }
      if (content.length > MAX_TOOL_RESULT_CHARS) {
        content =
          content.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n\n...(усечено, полный размер: ${content.length} символов)`;
      }
      return { content, isError, ...(attachments ? { attachments } : {}) };
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
