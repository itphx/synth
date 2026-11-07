import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthKit } from '../auth/middleware.js';
import type { McpManager, McpRegistryRepository } from '@itphx/synth-core';
import type {
  McpRemoteAttachment,
  RemoteMcpCallResult,
  RemoteMcpServerInfo,
  RemoteMcpToolsResponse,
} from '@itphx/synth-shared';
import { requireScopeForServiceKey } from '../auth/guards.js';

/**
 * PROP-125 §1: backend-контракт удалённого MCP в режиме `tools`.
 *
 * Локальный core гибрида ходит сюда вместо прямого egress к MCP-серверу:
 * секреты и сеть остаются на сервере (ADR-105/ADR-099), а локальная сессия
 * получает тот же шейп результата, что и протокол исполнителя 5.
 *
 * Маршруты:
 * - `GET /remote/servers` — состав серверов реестра (все записи, решение 10);
 * - `GET /remote/tools?server=…` — схемы инструментов + `instructions`;
 * - `POST /remote/call` — вызов инструмента `{server, tool, arguments?, meta?}`.
 *
 * Авторизация: интерактивный пользователь — `requireAuth` (ADR-043);
 * service-key — scope `mcp:invoke` (решение 9 владельца).
 */

export interface McpRemoteRoutesOptions {
  /** Единый реестр MCP-серверов (ADR-071 §2.5) — источник истины для `/remote/*`. */
  registry: McpRegistryRepository;
}

/** Тело `POST /remote/call` — поля контракта `RemoteMcpCallRequest`. */
const remoteCallSchema = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Текст ошибки: только текст исключения — без конфига, URL и секретов. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMcpRemoteRoutes(
  kit: AuthKit,
  mcpManager: McpManager | null,
  options: McpRemoteRoutesOptions,
): Hono {
  const app = new Hono();
  const registry = options.registry;

  /**
   * Транспортный статус сервера для локального клиента:
   * `connected` → `up`, `disconnected` → `idle`, `error`/`circuit-open` → `down`.
   */
  const remoteStatus = (name: string): RemoteMcpServerInfo['status'] => {
    if (!mcpManager) return 'idle';
    const status = mcpManager.getServerStatus(name);
    if (status === 'connected') return 'up';
    if (status === 'disconnected') return 'idle';
    return 'down';
  };

  /** Подключить сервер, если он ещё не подключён (иначе — успех). */
  const ensureConnected = async (name: string): Promise<void> => {
    if (!mcpManager) return;
    if (mcpManager.getServerStatus(name) === 'connected') return;
    await mcpManager.connectServer(name);
  };

  // --- Список серверных MCP-серверов (все записи реестра) ---
  app.get('/remote/servers', kit.requireAuth, requireScopeForServiceKey('mcp:invoke'), async (c) => {
    const entries = await registry.list();
    const servers: RemoteMcpServerInfo[] = entries.map((entry) => {
      const instructions = mcpManager?.getServerInstructions(entry.name);
      return {
        name: entry.name,
        type: entry.config.type,
        origin: entry.origin,
        trust: entry.trust,
        enabled: entry.enabled,
        enabledByDefault: entry.enabledByDefault,
        remoteMode: entry.remoteMode ?? 'auto',
        status: remoteStatus(entry.name),
        toolCount: mcpManager?.getServerTools(entry.name)?.length ?? 0,
        ...(instructions ? { instructions } : {}),
      };
    });
    return c.json(servers);
  });

  // --- Схемы инструментов сервера ---
  app.get('/remote/tools', kit.requireAuth, requireScopeForServiceKey('mcp:invoke'), async (c) => {
    // Имя сервера ищем в реестре **как есть** (без trim): имя записи реестра —
    // точный ключ. Пустое/пробельное значение — «параметр не задан».
    const name = c.req.query('server') ?? '';
    if (!name.trim()) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Параметр server обязателен' },
      }, 400);
    }

    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({
        error: { code: 'MCP_REMOTE_SERVER_NOT_FOUND', message: `MCP-сервер "${name}" не найден` },
      }, 404);
    }

    if (!mcpManager) {
      return c.json({
        error: { code: 'MCP_REMOTE_UNAVAILABLE', message: 'MCP-менеджер недоступен' },
      }, 503);
    }

    try {
      await ensureConnected(name);
    } catch (err) {
      return c.json({
        error: { code: 'MCP_REMOTE_SERVER_DOWN', message: errorMessage(err) },
      }, 502);
    }

    const body: RemoteMcpToolsResponse = {
      server: name,
      instructions: mcpManager.getServerInstructions(name),
      tools: (mcpManager.getServerTools(name) ?? []).map((tool) => ({ server: name, ...tool })),
    };
    return c.json(body);
  });

  // --- Вызов инструмента серверного MCP-сервера ---
  app.post('/remote/call', kit.requireAuth, requireScopeForServiceKey('mcp:invoke'), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = remoteCallSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      }, 400);
    }
    const { server, tool, arguments: args, meta } = parsed.data;

    const entry = await registry.getByName(server);
    if (!entry) {
      return c.json({
        error: { code: 'MCP_REMOTE_SERVER_NOT_FOUND', message: `MCP-сервер "${server}" не найден` },
      }, 404);
    }

    // Системный мастер-флаг: выключенный администратором сервер недоступен нигде.
    if (entry.enabled === false) {
      return c.json({
        error: { code: 'MCP_SERVER_DISABLED', message: 'MCP-сервер отключён администратором' },
      }, 409);
    }

    if (!mcpManager) {
      return c.json({
        error: { code: 'MCP_REMOTE_UNAVAILABLE', message: 'MCP-менеджер недоступен' },
      }, 503);
    }

    try {
      await ensureConnected(server);
    } catch (err) {
      return c.json({
        error: { code: 'MCP_REMOTE_SERVER_DOWN', message: errorMessage(err) },
      }, 502);
    }

    try {
      const result = await mcpManager.callServerTool(server, tool, args ?? {}, meta);
      const attachments: McpRemoteAttachment[] | undefined = result.attachments?.map((item) => ({
        mime: item.mime,
        ...(item.name ? { name: item.name } : {}),
        base64: item.base64,
      }));
      const payload: RemoteMcpCallResult = {
        content: result.content,
        isError: result.isError,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      return c.json(payload);
    } catch (err) {
      return c.json({
        error: { code: 'MCP_REMOTE_CALL_FAILED', message: errorMessage(err) },
      }, 502);
    }
  });

  return app;
}
