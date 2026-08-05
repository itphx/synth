import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { McpManager } from '../../engine/mcp/index.js';

export interface McpRoutesDeps {
  /** Менеджер MCP-серверов (конфиг из config.yaml mcp.servers). */
  mcpManager: McpManager;
}

/**
 * MCP: проверка подключения к серверу (probe).
 *
 * POST /api/v2/mcp/probe body { name } → 200 { name, tools: [{ name, description }] }.
 * Сервер не настроен → 400 VALIDATION_ERROR, ошибка подключения → 500 MCP_CONNECT_ERROR.
 */
export function createMcpRoutes(auth: AuthKit, deps: McpRoutesDeps): Hono {
  const app = new Hono();

  app.post('/probe', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === 'string'
      ? ((body as { name: string }).name).trim()
      : '';

    if (!name) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Поле name обязательно и не может быть пустым' },
      }, 400);
    }

    if (!deps.mcpManager.isServerConfigured(name)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${name}" не настроен` },
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
