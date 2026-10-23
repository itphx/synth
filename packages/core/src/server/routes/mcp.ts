import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  findForbiddenMcpSecretHeaders,
  mcpSecretHeaderErrorMessage,
  MCP_SECRET_HEADER_ERROR_CODE,
} from '@itphx/synth-shared';
import type { McpManager } from '../../engine/mcp/index.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface McpRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface McpRouteMessages {
  nameRequired: (c: Context) => string;
  serverNotConfigured: (c: Context, name: string) => string;
  managerNotConfigured: (c: Context) => string;
}

export interface McpRoutesDeps {
  /** Менеджер MCP-серверов (config.yaml mcp.servers / единый реестр). */
  mcpManager: McpManager | null;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<McpRouteMessages>;
}

const DEFAULT_MESSAGES: McpRouteMessages = {
  nameRequired: () => 'Поле name обязательно и не может быть пустым',
  serverNotConfigured: (_c, name) => `MCP-сервер "${name}" не настроен`,
  managerNotConfigured: () => 'McpManager не настроен',
};

/**
 * MCP: проверка подключения к серверу (probe).
 *
 * POST /api/v2/mcp/probe body { name } → 200 { name, tools: [{ name, description }] }.
 * Сервер не настроен → 400 VALIDATION_ERROR, ошибка подключения → 500 MCP_CONNECT_ERROR.
 * Коннектор с plaintext-секретом в заголовках → 400 MCP_SECRET_HEADER_FORBIDDEN
 * (ADR-105 Ф3: авторизация — только через слой внешних доступов).
 * Общая логика для core (standalone) и backend (монтирует probe из этой фабрики).
 */
export function createMcpRoutes(auth: McpRoutesAuth, deps: McpRoutesDeps): Hono {
  const app = new Hono();
  const messages: McpRouteMessages = { ...DEFAULT_MESSAGES, ...deps.messages };

  app.post('/probe', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === 'string'
      ? ((body as { name: string }).name).trim()
      : '';

    if (!name) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: messages.nameRequired(c) },
      }, 400);
    }

    if (!deps.mcpManager) {
      return c.json({
        error: { code: 'INTERNAL_ERROR', message: messages.managerNotConfigured(c) },
      }, 500);
    }

    if (!deps.mcpManager.isServerConfigured(name)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: messages.serverNotConfigured(c, name) },
      }, 400);
    }

    // ADR-105 (Ф3): probe не подключается к коннектору с plaintext-секретом
    // в заголовках — авторизация только через слой внешних доступов
    // (`auth.kind='credential'`), иначе секрет ушёл бы в чужой origin.
    const serverConfig = deps.mcpManager.getServerConfig(name);
    const forbidden = findForbiddenMcpSecretHeaders(serverConfig?.headers);
    if (forbidden.length > 0) {
      return c.json({
        error: {
          code: MCP_SECRET_HEADER_ERROR_CODE,
          message: mcpSecretHeaderErrorMessage(forbidden),
        },
      }, 400);
    }

    try {
      const tools = await deps.mcpManager.probeServer(name);
      return c.json({
        name,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    } catch (err) {
      return c.json({
        error: {
          code: 'MCP_CONNECT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      }, 500);
    }
  });

  return app;
}
