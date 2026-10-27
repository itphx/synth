import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '@itphx/synth-shared';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import { info, warning, error } from '../../logger.js';
import { egressFetch, getTlsCaPath } from '../../security/tls.js';
import { mcpProxyEnv } from '../../security/proxy-state.js';
import { createCredentialFetch, type McpCredentialSource } from './credential-auth.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Вложение MCP-результата (ADR-115 §«Медиа из инструментов», ADR-077).
 *
 * Байты в памяти клиента: `base64` — **без** префикса `data:`. Блоб пишет
 * `McpManager` через `AttachmentService` — у клиента нет порта хранения, и
 * смешивать транспорт с записью байтов нельзя.
 */
export interface McpAttachmentPayload {
  /** MIME из блока MCP (`mimeType`); сервис вложений переопределит по сигнатуре. */
  mime: string;
  /** Имя файла (у `image`/`audio` в MCP его нет; у `resource` — из `uri`). */
  name?: string;
  /** Содержимое блока в base64 (без `data:`-префикса). */
  base64: string;
}

export interface McpToolResult {
  content: string;
  isError: boolean;
  /**
   * ADR-115: нетекстовые блоки результата (`image`/`audio`/`resource.blob`).
   * `isError` → вложения **не** собираются (в контекст не тащим мусор сбоя).
   */
  attachments?: McpAttachmentPayload[];
}

/** Потолок длины текста результата MCP-вызова, символов (общий с исполнителем). */
export const MAX_TOOL_RESULT_CHARS = 30_000;

/**
 * Потолок одного вложения MCP-результата, байт (ADR-115).
 *
 * Значение по умолчанию — разумный 25 МиБ: в клиенте нет доступа к
 * `attachments.maxBytesPerFile` (конфиг живёт в сервисе вложений), поэтому
 * истинный лимит применяет `AttachmentService.upload` уже при записи. Здесь —
 * отсечка «явно не медиа, а дамп» до декодирования/пересылки.
 */
export const MCP_ATTACHMENT_MAX_BYTES_PER_FILE = 25 * 1024 * 1024;

/**
 * Суммарный потолок вложений одного MCP-вызова, байт (ADR-115).
 *
 * Блоков может быть много (Playwright отдаёт скриншоты пачками): суммарный
 * кап защищает контекст хода и память процесса.
 */
export const MCP_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Пределы вложений MCP-результата (значения по умолчанию — константы выше). */
export interface McpAttachmentLimits {
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

/** Параметры MCP-клиента. */
export interface McpClientOptions {
  /**
   * ADR-105 (Ф3): источник access-токена для коннектора с
   * `auth: { kind: 'credential' }`. Без него такой коннектор не подключится
   * (явная ошибка, а не молчаливая работа без авторизации).
   */
  credentialSource?: McpCredentialSource | undefined;
  /**
   * ADR-115: пределы вложений MCP-результата. Не заданы — константы
   * `MCP_ATTACHMENT_MAX_BYTES_PER_FILE`/`MCP_ATTACHMENT_MAX_TOTAL_BYTES`.
   */
  attachmentLimits?: McpAttachmentLimits | undefined;
}

/**
 * Поверхность MCP-клиента (ADR-077, шаг B2).
 *
 * `McpManager` работает с клиентом через этот интерфейс, а не через конкретный
 * класс: транспорт может быть локальным (`McpClient` — stdio/HTTP) или
 * удалённым (`ExecutorMcpClient` — HTTP API исполнителя). Регистрация тулов,
 * вызов, circuit breaker и permissions — **один** путь для обоих (инвариант 5).
 */
export interface McpClientLike {
  readonly name: string;
  readonly isConnected: boolean;
  readonly tools: McpToolDef[];
  /** ADR-071 §2.2: `instructions` из MCP initialize (если сервер отдал). */
  readonly instructions?: string | undefined;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult>;
}

// ─── ADR-115: вложения MCP-результата ───────────────────────────────────────
//
// MCP отдаёт результат **блоками**: `text`, `image`, `audio`, `resource`
// (`{uri, mimeType, blob|text}`). Раньше брались только `text` — скриншоты
// Playwright (`image`) и бинарные ресурсы выбрасывались молча, и модель не
// видела того, что инструмент реально вернул.
//
// Теперь нетекстовые блоки складываются в `McpToolResult.attachments`
// (base64), а `McpManager` пишет их в blob-хранилище и возвращает
// `ToolResult.attachments` (ADR-115 §«Медиа из инструментов»). Лимиты здесь —
// **транспортные**: сколько можно протащить через ход, не раздувая память.
// Истинный лимит файла применит `AttachmentService.upload` (конфиг
// `attachments.maxBytesPerFile`, модальности, allowlist MIME).

/** Разобранные блоки MCP-результата: текст и нетекстовые вложения. */
export interface McpContentParts {
  /** Текстовые блоки в порядке следования (`text` + `resource.text`). */
  texts: string[];
  /** Нетекстовые блоки, прошедшие лимиты (base64 без `data:`-префикса). */
  attachments: McpAttachmentPayload[];
}

/**
 * Строгий разбор base64.
 *
 * `Buffer.from(data, 'base64')` в Node **молча игнорирует** мусор и обрезает
 * хвост — «битый» блок превратился бы в случайные байты в контексте. Поэтому
 * проверяем алфавит/длину и сверяем обратное кодирование.
 */
function decodeBase64Strict(data: string): Buffer | null {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.length === 0) return null;
    if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Имя файла из `uri` ресурса (последний сегмент пути); иначе — нет имени. */
function resourceNameFromUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || uri.length === 0) return undefined;
  const segment = uri.split(/[\\/]/).filter((part) => part.length > 0).pop();
  if (!segment) return undefined;
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return segment;
  }
}

/**
 * Разложить `content` MCP-вызова на текст и вложения.
 *
 * Правила:
 * - `text` и `resource.text` → текст (как раньше);
 * - `image`/`audio` (`{data, mimeType}`) и `resource.blob` → вложение;
 * - битый base64, пустой блок, превышение `maxBytesPerFile` или суммарного
 *   `maxTotalBytes` → блок **пропускается** с логом (вызов не падает);
 * - `resource` без `blob` и без `text` игнорируется.
 */
export function collectMcpContent(
  content: unknown,
  limits: McpAttachmentLimits = {},
  log: (message: string) => void = (message) => warning('MCP', message),
): McpContentParts {
  const maxPerFile = limits.maxBytesPerFile ?? MCP_ATTACHMENT_MAX_BYTES_PER_FILE;
  const maxTotal = limits.maxTotalBytes ?? MCP_ATTACHMENT_MAX_TOTAL_BYTES;

  const texts: string[] = [];
  const attachments: McpAttachmentPayload[] = [];
  let total = 0;

  const addAttachment = (mime: string, data: string, name?: string): void => {
    const bytes = decodeBase64Strict(data);
    if (!bytes) {
      log(`вложение ${mime} пропущено: base64 не разбирается`);
      return;
    }
    if (bytes.length > maxPerFile) {
      log(`вложение ${mime} пропущено: ${bytes.length} Б больше предела ${maxPerFile} Б`);
      return;
    }
    if (total + bytes.length > maxTotal) {
      log(
        `вложение ${mime} пропущено: суммарный объём вложений превысил предел ${maxTotal} Б`,
      );
      return;
    }
    total += bytes.length;
    // Перекодируем из байтов: base64 нормализуется (пробелы/паддинг не едут дальше).
    attachments.push({ mime, base64: bytes.toString('base64'), ...(name ? { name } : {}) });
  };

  if (!Array.isArray(content)) return { texts, attachments };

  for (const raw of content as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type;

    if (type === 'text') {
      if (typeof raw.text === 'string' && raw.text.length > 0) texts.push(raw.text);
      continue;
    }

    if (type === 'image' || type === 'audio') {
      if (typeof raw.data !== 'string' || raw.data.length === 0) continue;
      const mime =
        typeof raw.mimeType === 'string' && raw.mimeType.length > 0
          ? raw.mimeType
          : 'application/octet-stream';
      addAttachment(mime, raw.data);
      continue;
    }

    if (type === 'resource') {
      const resource = raw.resource;
      if (!resource || typeof resource !== 'object') continue;
      const fields = resource as Record<string, unknown>;
      const mime =
        typeof fields.mimeType === 'string' && fields.mimeType.length > 0
          ? fields.mimeType
          : 'application/octet-stream';
      if (typeof fields.blob === 'string' && fields.blob.length > 0) {
        addAttachment(mime, fields.blob, resourceNameFromUri(fields.uri));
        continue;
      }
      // Текстовый ресурс — тот же канал, что `text` (поведение прежнее).
      if (typeof fields.text === 'string' && fields.text.length > 0) texts.push(fields.text);
    }
  }

  return { texts, attachments };
}

/**
 * Текст-заглушка, когда инструмент вернул **только** вложения.
 *
 * i18n-ключ будущего перевода блока MCP на `shared/i18n` —
 * `tool.mcp_attachments_only`; соседние строки модуля пока тоже литеральные
 * («Инструмент вернул ошибку»), поэтому расхождения в поведении нет.
 */
export function mcpAttachmentsOnlyText(count: number): string {
  return `Инструмент вернул ${count} вложений (текста нет)`;
}

export class McpClient {
  private _name: string;
  private _config: McpServerConfig;
  private _client: Client | null = null;
  private _transport: Transport | null = null;
  private _tools: McpToolDef[] = [];
  private _connected = false;
  private _toolTimeout: number;
  /** ADR-071 §2.2: `instructions` из MCP initialize (getInstructions()). */
  private _instructions: string | undefined;
  /** ADR-105 (Ф3): источник токена доступа (для `auth.kind='credential'`). */
  private readonly _credentialSource: McpCredentialSource | undefined;
  /** ADR-115: пределы вложений MCP-результата (транспортные, не конфиг вложений). */
  private readonly _attachmentLimits: McpAttachmentLimits;

  constructor(name: string, config: McpServerConfig, opts: McpClientOptions = {}) {
    this._name = name;
    this._config = config;
    this._toolTimeout = (config.timeout || 120) * 1000;
    this._credentialSource = opts.credentialSource;
    this._attachmentLimits = opts.attachmentLimits ?? {};
  }

  get name(): string {
    return this._name;
  }

  get isConnected(): boolean {
    return this._connected && this._client !== null;
  }

  get tools(): McpToolDef[] {
    return this._tools;
  }

  /** ADR-071 §2.2: инструкции сервера из MCP initialize (если сервер отдал). */
  get instructions(): string | undefined {
    return this._instructions;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    const connectTimeout = (this._config.connectTimeout || 60) * 1000;

    try {
      if (this._config.type === 'stdio') {
        await this._connectStdio();
      } else {
        await this._connectStreamableHttp();
      }

      // ADR-071 §2.2: `instructions` доступны сразу после initialize (connect);
      // сохраняем до загрузки тулов, чтобы блок `mcp.servers` их видел.
      this._instructions = this._client?.getInstructions();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Таймаут подключения к MCP-серверу "${this._name}"`)), connectTimeout),
      );

      const toolsPromise = this._loadTools();
      this._tools = await Promise.race([toolsPromise, timeoutPromise]);
      this._connected = true;
      info(`MCP`, `Подключён сервер "${this._name}", инструментов: ${this._tools.length}`);
    } catch (err) {
      await this._cleanup();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this._cleanup();
    this._tools = [];
    this._connected = false;
    info(`MCP`, `Отключён сервер "${this._name}"`);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    if (!this._client || !this._connected) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }

    try {
      const timeoutPromise = new Promise<McpToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Таймаут вызова инструмента "${name}" (${this._toolTimeout}ms)`)), this._toolTimeout),
      );

      const callPromise = (async (): Promise<McpToolResult> => {
        // `_meta` запроса `tools/call` (не путать с transport session id
        // Streamable HTTP): контекст Synth-сессии для внешних MCP-серверов.
        const result = await this._client!.callTool({
          name,
          arguments: args,
          ...(meta ? { _meta: meta } : {}),
        });

        if (result.isError) {
          const errorText = (result.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('\n');
          return {
            content: errorText || 'Инструмент вернул ошибку',
            isError: true,
          };
        }

        // ADR-115: нетекстовые блоки (`image`/`audio`/`resource.blob`) — во вложения.
        // Текст собираем тем же проходом (`text` + `resource.text`), чтобы не читать
        // результат дважды и не разойтись в правилах.
        const parts = collectMcpContent(result.content, this._attachmentLimits);

        let content =
          parts.texts.join('\n') ||
          (parts.attachments.length > 0
            ? mcpAttachmentsOnlyText(parts.attachments.length)
            : 'Инструмент выполнен (пустой результат)');
        if (content.length > MAX_TOOL_RESULT_CHARS) {
          content = content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n...(усечено, полный размер: ${content.length} символов)`;
        }

        return {
          content,
          isError: false,
          ...(parts.attachments.length > 0 ? { attachments: parts.attachments } : {}),
        };
      })();

      return await Promise.race([callPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`MCP`, `Ошибка вызова "${name}" на сервере "${this._name}": ${msg}`);
      return { content: `Ошибка: ${msg}`, isError: true };
    }
  }

  private async _connectStdio(): Promise<void> {
    const command = this._config.command;
    if (!command) {
      throw new Error(`MCP-сервер "${this._name}": не указана команда для stdio`);
    }

    // ADR-099 (D1): прокси и CA — в окружение дочернего процесса.
    // SDK (`StdioClientTransport`) мержит `getDefaultEnvironment()` (whitelist
    // HOME/PATH/…) с переданным `env` без фильтрации, поэтому HTTP_PROXY/
    // HTTPS_PROXY/ALL_PROXY/NO_PROXY/NODE_EXTRA_CA_CERTS реально доезжают до
    // MCP-сервера. Приоритет: config.env < resolved proxy/CA (управляется
    // инстансом, не сервером).
    const caFile = getTlsCaPath();
    const managedEnv: Record<string, string> = {
      ...mcpProxyEnv(),
      ...(caFile ? { NODE_EXTRA_CA_CERTS: caFile } : {}),
    };
    const transport = new StdioClientTransport({
      command,
      args: this._config.args || [],
      env: { ...(this._config.env ?? {}), ...managedEnv },
    });

    const client = new Client(
      { name: 'synth-core', version: SYNTH_VERSION },
      { capabilities: {} },
    );

    await client.connect(transport);
    this._client = client;
    this._transport = transport;
  }

  private async _connectStreamableHttp(): Promise<void> {
    const url = this._config.url;
    if (!url) {
      throw new Error(`MCP-сервер "${this._name}": не указан URL`);
    }

    // ADR-090: конфиг допускает `headers` (auth/tenant-заголовки) — прокидываем
    // их в транспорт. `requestInit` применяется SDK ко всем HTTP-запросам
    // (initialize/tools/list/tools/call).
    //
    // ADR-099: явно передаём `fetch` с единым доверием TLS/CA — иначе SDK ходит
    // собственным (глобальным) транспортом и настройка `security.tls.caFile`/`caPem`
    // к MCP-серверу не применялась бы.
    const headers = this._config.headers;
    const hasHeaders = !!headers && Object.keys(headers).length > 0;
    const auth = this._config.auth;

    // ADR-105 (Ф3): коннектор с `auth.kind='credential'` авторизуется токеном
    // из слоя доступов — он подставляется в **каждый** запрос транспорта
    // (не в статический `requestInit`), при `401` токен обновляется один раз
    // и запрос повторяется. Значение токена не логируется.
    let fetchImpl: typeof fetch = egressFetch;
    if (auth?.kind === 'credential') {
      if (!this._credentialSource) {
        throw new Error(
          `MCP-сервер "${this._name}": доступ "${auth.credentialId}" задан, но источник токена недоступен`,
        );
      }
      fetchImpl = createCredentialFetch({
        source: this._credentialSource,
        credentialId: auth.credentialId,
        serverName: this._name,
        baseFetch: egressFetch,
        onRefresh: ({ serverName, credentialId }) =>
          info('MCP', `Токен доступа "${credentialId}" обновлён для сервера "${serverName}"`),
      });
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: fetchImpl,
      ...(hasHeaders ? { requestInit: { headers: { ...headers } } } : {}),
    });

    const client = new Client(
      { name: 'synth-core', version: SYNTH_VERSION },
      { capabilities: {} },
    );

    await client.connect(transport);
    this._client = client;
    this._transport = transport;
  }

  private async _loadTools(): Promise<McpToolDef[]> {
    if (!this._client) return [];

    try {
      const result = await this._client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    } catch (err) {
      warning(`MCP`, `Не удалось загрузить инструменты сервера "${this._name}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async _cleanup(): Promise<void> {
    try {
      if (this._client) {
        await this._client.close();
      }
    } catch {
      // игнорируем ошибки при закрытии
    }
    this._client = null;
    this._transport = null;
    this._instructions = undefined;
  }
}
