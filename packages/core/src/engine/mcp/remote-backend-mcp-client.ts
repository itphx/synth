/**
 * PROP-125 §2: MCP-клиент **серверного** MCP-сервера в режиме `tools`.
 *
 * В гибриде локальный core не ходит к upstream MCP (секреты и сеть остаются
 * на сервере — ADR-105/ADR-099, §5 PROP-125). Вместо этого он говорит с
 * backend'ом по его HTTP-контракту:
 *
 * | Метод | Путь | Назначение |
 * |---|---|---|
 * | `GET` | `/api/v2/mcp/remote/servers` | состав серверов реестра |
 * | `GET` | `/api/v2/mcp/remote/tools?server=…` | схемы инструментов + `instructions` |
 * | `POST` | `/api/v2/mcp/remote/call` | вызов инструмента `{server, tool, arguments?}` |
 *
 * ## Поверхность — как у `McpClient`
 *
 * Класс реализует `McpClientLike` (`connect()`/`tools`/`callTool()`/
 * `isConnected`/`name`/`instructions`/`disconnect()`), чтобы `McpManager`
 * регистрировал тулы **штатным путём** (`{server}_{tool}`, `source:'mcp'`) и
 * не заводил второго пути вызова/permissions (инвариант 5). По образцу
 * `ExecutorMcpClient` (ADR-077) — второй «MCP вне процесса», но с тем же
 * форматом результата (протокол исполнителя 5).
 *
 * ## Вложения (ADR-115)
 *
 * Backend отдаёт нетекстовые блоки MCP-результата (`image`/`audio`/
 * `resource.blob`) полем `attachments[]` (base64). Здесь они разбираются и
 * пробрасываются в `McpToolResult.attachments` без декодирования — в
 * blob-хранилище их пишет `McpManager` через `AttachmentService`.
 * **Деградация:** сервер без поля `attachments` — результат остаётся
 * текстовым, вызов не падает (поле аддитивное).
 */

import type {
  RemoteMcpCallRequest,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';
import type { McpAttachmentPayload, McpClientLike, McpToolDef, McpToolResult } from './client.js';
import { MAX_TOOL_RESULT_CHARS, mcpAttachmentsOnlyText } from './client.js';

/**
 * Минимальная поверхность backend'а, нужная клиенту.
 *
 * Структурно совместима с `RemoteBackendClient` (`remote/client.ts`) — импорт
 * класса здесь **не** нужен и не делается: модуль не должен тянуть HTTP-клиент
 * гибрида (иначе получится цикл `remote → engine/mcp → remote`).
 */
export interface RemoteMcpBackendApi {
  /** Адрес backend'а гибрида (PROP-125 §2: адрес релея `/api/v2/mcp/relay/:name`). */
  readonly backendUrl: string;
  /**
   * Текущий access-токен гибрида (`null` — токена нет).
   *
   * Relay-клиент подставляет Bearer **на каждый запрос**: токен обновляется
   * в рантайме, статический заголовок протух бы.
   */
  getAccessToken(): Promise<string | null>;
  getRemoteMcpServers(): Promise<RemoteMcpServerInfo[]>;
  getRemoteMcpTools(server: string): Promise<RemoteMcpToolsResponse>;
  callRemoteMcp(body: RemoteMcpCallRequest): Promise<RemoteMcpCallResult>;
}

/** Таймаут подключения к серверному MCP-серверу (как у `McpClient` — 60 c). */
export const REMOTE_MCP_CONNECT_TIMEOUT_MS = 60_000;

/** Таймаут вызова инструмента серверного MCP-сервера (как у `McpClient` — 120 c). */
export const REMOTE_MCP_TOOL_TIMEOUT_MS = 120_000;

/**
 * Разобрать `attachments` ответа сервера.
 *
 * Валидация структурная (mime/base64 — непустые строки): байты заново не
 * декодируются, кап объёма уже применён сервером, а настоящий лимит файла
 * проверит `AttachmentService.upload` на стороне control plane (единственная
 * точка записи). Некорректные записи пропускаются — результат вызова важнее.
 *
 * Правила — те же, что у клиента исполнителя (`executor-mcp-client.ts`):
 * формат результата у двух «MCP вне процесса» один (протокол 5).
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
 * MCP-клиент одного серверного MCP-сервера (поверхность `McpClientLike`).
 *
 * `_meta` вызова уходит в тело `POST /api/v2/mcp/remote/call` полем `meta` —
 * контракт сервера его принимает (PROP-125 §1), в отличие от API исполнителя.
 */
export class RemoteBackendMcpClient implements McpClientLike {
  private readonly _name: string;
  private readonly _api: RemoteMcpBackendApi;
  private _tools: McpToolDef[] = [];
  private _connected = false;
  /** ADR-071 §2.2: `instructions` сервера (backend отдаёт их в `tools`). */
  private _instructions: string | undefined;

  constructor(name: string, api: RemoteMcpBackendApi) {
    this._name = name;
    this._api = api;
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

  /** Инструкции MCP-сервера (`instructions` из ответа `GET /remote/tools`). */
  get instructions(): string | undefined {
    return this._instructions;
  }

  /**
   * Подключение: загрузка схем инструментов сервера.
   *
   * Ошибка **пробрасывается** — её записывает `McpManager` (сервер помечается
   * `error`, тулы не регистрируются).
   */
  async connect(): Promise<void> {
    const res = await this._api.getRemoteMcpTools(this._name);
    this._tools = (Array.isArray(res?.tools) ? res.tools : []).map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));
    this._instructions = res?.instructions;
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._tools = [];
    this._connected = false;
    this._instructions = undefined;
  }

  /**
   * Вызов инструмента серверного MCP-сервера.
   *
   * Ошибка транспорта (backend недоступен) **пробрасывается**: слой тулов
   * (`engine/tools/tool-execution.ts`) превращает её в результат с
   * `isError` — так же, как ошибку любого другого инструмента.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (!this._connected) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }

    const result = await this._api.callRemoteMcp({
      server: this._name,
      tool: name,
      arguments: args,
      ...(meta ? { meta } : {}),
    });

    const raw = typeof result?.content === 'string' ? result.content : '';
    const isError = result?.isError === true;
    // ADR-115: при ошибке вложения не собираются (мусор сбоя в контекст не тащим).
    const attachments = isError ? undefined : parseAttachments(result?.attachments);
    let content = raw;
    if (!content) {
      content = isError
        ? 'Инструмент вернул ошибку'
        : attachments
          ? mcpAttachmentsOnlyText(attachments.length)
          : 'Инструмент выполнен (пустой результат)';
    }
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content =
        content.slice(0, MAX_TOOL_RESULT_CHARS) +
        `\n\n...(усечено, полный размер: ${content.length} символов)`;
    }
    return { content, isError, ...(attachments ? { attachments } : {}) };
  }
}
