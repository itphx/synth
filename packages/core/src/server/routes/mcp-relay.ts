import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ContentBlock,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SYNTH_VERSION, type McpRegistryEntry } from '@itphx/synth-shared';
import type { McpManager } from '../../engine/mcp/manager.js';
import type { McpToolResult } from '../../engine/mcp/client.js';

/**
 * PROP-125 §1: серверный MCP-relay (режим `relay`).
 *
 * Локальный core гибрида не ходит к серверным MCP-серверам напрямую: он
 * поднимает обычный MCP-клиент на `/api/v2/mcp/relay/:name` (Streamable HTTP),
 * а backend мостит его к MCP-клиенту реального сервера. Секреты и сеть
 * остаются на сервере (ADR-105/ADR-099) — как и в режиме `tools`
 * (`/api/v2/mcp/remote/*`).
 *
 * Фабрика живёт в core, монтирует её **только backend** — на локальном
 * инстансе маршрута нет (PROP-125 §1, «relay»).
 *
 * **Ограничения текущей реализации (этап T4a):**
 * - **stateless**: `sessionIdGenerator: undefined` — MCP-сессии не заводим,
 *   `GET`/`DELETE` отвечают `405 MCP_RELAY_SESSIONLESS`;
 * - **JSON-режим** (`enableJsonResponse: true`): без SSE-стриминга, без
 *   server-initiated уведомлений (`notifications/progress` не транслируется);
 * - один HTTP-запрос — один инстанс MCP-сервера: подписки не копим, сервер
 *   закрывается сразу после сбора ответа.
 */

/** Минимальный auth-контракт фабрики (структурно совместим с backend `AuthKit`). */
export interface McpRelayRoutesAuth {
  requireAuth: MiddlewareHandler;
}

/** Опции фабрики релея. */
export interface McpRelayRoutesOptions {
  /** Менеджер MCP-серверов: клиенты реальных серверов (реестр/config). */
  mcpManager: McpManager | null;
  /** Запись единого реестра MCP по имени (backend — `McpRegistryRepository.getByName`). */
  getEntry: (name: string) => Promise<McpRegistryEntry | null>;
  /** Доп. middleware после auth (backend: scope service-key `mcp:invoke`). */
  authorize?: MiddlewareHandler;
}

/** Текст ошибки: только текст исключения — без конфига, URL и секретов. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Имя файла вложения для URI ресурса — без path traversal.
 *
 * Имя приходит от внешнего MCP-сервера: оставляем только последний сегмент
 * пути, выкидываем управляющие символы и `..`. Пустое/непригодное имя →
 * `attachment`.
 */
function safeAttachmentName(name: string | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw) return 'attachment';
  const last = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.{2,}/g, '.')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned;
}

/**
 * Конвертация результата MCP-вызова в content-блоки MCP.
 *
 * Текст результата → блок `text`; вложения (`image/*` → `image`, прочее →
 * `resource.blob`) — только при успешном вызове: у сбойного вызова вложения
 * не собираются (ADR-115, тот же контракт, что у `McpManager`).
 *
 * Пустой результат (без текста и вложений) → текстовая заглушка, чтобы
 * ответ MCP-клиента не был без содержимого.
 */
export function toMcpContent(result: McpToolResult): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  const text = typeof result.content === 'string' ? result.content : '';
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }

  if (!result.isError) {
    for (const attachment of result.attachments ?? []) {
      const mime = attachment.mime || 'application/octet-stream';
      if (mime.startsWith('image/')) {
        blocks.push({ type: 'image', data: attachment.base64, mimeType: mime });
        continue;
      }
      blocks.push({
        type: 'resource',
        resource: {
          uri: `file:///${safeAttachmentName(attachment.name)}`,
          mimeType: mime,
          blob: attachment.base64,
        },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      text: result.isError ? 'Инструмент вернул ошибку' : 'Инструмент выполнен (пустой результат)',
    });
  }

  return blocks;
}

/**
 * MCP-сервер релея одного upstream-сервера (общий для initialize/tools).
 *
 * `tools/list` и `tools/call` проксируются в `McpManager`: тот же клиент
 * (stdio/HTTP/…), тот же circuit breaker, тот же лимит времени вызова.
 * `instructions` upstream-сервера (ADR-071 §2.2) отдаются MCP-клиенту при
 * initialize.
 */
export function createRelayServer(mcpManager: McpManager, name: string): Server {
  const instructions = mcpManager.getServerInstructions(name);

  const server = new Server(
    { name: 'synth-hybrid-mcp', version: SYNTH_VERSION },
    {
      capabilities: { tools: {} },
      ...(instructions ? { instructions } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await mcpManager.connectServer(name);
    const tools = mcpManager.getServerTools(name) ?? [];
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Схема инструмента в MCP — всегда объектная; `type` принудительно
        // нормализуется, остальные поля приходят как есть от сервера.
        inputSchema: { ...tool.inputSchema, type: 'object' } as Tool['inputSchema'],
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
    const result = await mcpManager.callServerTool(
      name,
      params.name,
      (params.arguments ?? {}) as Record<string, unknown>,
      params._meta,
    );
    return {
      content: toMcpContent(result),
      ...(result.isError ? { isError: true } : {}),
    };
  });

  return server;
}

/**
 * HTTP-фабрика релея (монтируется в backend на `/api/v2/mcp`).
 *
 * Маршруты:
 * - `POST /relay/:name` — MCP Streamable HTTP (stateless, JSON-режим);
 * - `GET`/`DELETE /relay/:name` — `405 MCP_RELAY_SESSIONLESS` (сессий нет).
 *
 * Авторизация: интерактивный пользователь — `requireAuth` (ADR-043);
 * service-key — scope `mcp:invoke` (`opts.authorize`, решение 9 владельца).
 */
export function createMcpRelayRoutes(auth: McpRelayRoutesAuth, opts: McpRelayRoutesOptions): Hono {
  const app = new Hono();

  // Guard не задан (core/standalone) — пропускаем запрос как есть.
  const authorize: MiddlewareHandler =
    opts.authorize ?? (async (_c: Context, next) => { await next(); });

  const sessionless = async (c: Context): Promise<Response> =>
    c.json(
      {
        error: {
          code: 'MCP_RELAY_SESSIONLESS',
          message: 'Relay работает без сессий (stateless)',
        },
      },
      405,
    );

  app.post('/relay/:name', auth.requireAuth, authorize, async (c) => {
    const name = c.req.param('name');

    const entry = await opts.getEntry(name);
    if (!entry) {
      return c.json(
        {
          error: {
            code: 'MCP_RELAY_SERVER_NOT_FOUND',
            message: `MCP-сервер "${name}" не найден`,
          },
        },
        404,
      );
    }

    // Системный мастер-флаг: выключенный администратором сервер недоступен нигде.
    if (entry.enabled === false) {
      return c.json(
        {
          error: {
            code: 'MCP_SERVER_DISABLED',
            message: 'MCP-сервер отключён администратором',
          },
        },
        409,
      );
    }

    const mcpManager = opts.mcpManager;
    if (!mcpManager) {
      return c.json(
        {
          error: {
            code: 'MCP_REMOTE_UNAVAILABLE',
            message: 'MCP-менеджер недоступен',
          },
        },
        503,
      );
    }

    try {
      await mcpManager.connectServer(name);
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'MCP_REMOTE_SERVER_DOWN',
            message: errorMessage(err),
          },
        },
        502,
      );
    }

    const server = createRelayServer(mcpManager, name);
    // Stateless: sessionIdGenerator не задан — MCP-сессия не заводится,
    // `Mcp-Session-Id` в ответах не появляется.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      // JSON-режим: тело ответа уже собрано — сервер можно закрыть сразу
      // (подписки/сессии релей не копит).
      void server.close().catch(() => {});
      return response;
    } catch (err) {
      void server.close().catch(() => {});
      return c.json(
        {
          error: {
            code: 'MCP_RELAY_ERROR',
            message: errorMessage(err),
          },
        },
        500,
      );
    }
  });

  app.get('/relay/:name', auth.requireAuth, authorize, sessionless);
  app.delete('/relay/:name', auth.requireAuth, authorize, sessionless);

  return app;
}
