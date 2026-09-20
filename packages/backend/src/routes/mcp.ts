import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager, McpRegistryStore } from '@itphx/synth-core';
import { evaluateMcpNetworkAccess } from '@itphx/synth-core';
import type { McpServerConfig, McpNetworkPolicy, User } from '@itphx/synth-shared';
import { mcpServerConfigSchema } from '@itphx/synth-shared/config';

const addServerSchema = z.object({
  name: z.string().min(1),
  config: mcpServerConfigSchema,
});

const updateServerSchema = mcpServerConfigSchema;

const sessionMcpSchema = z
  .object({
    /** Явно включённые в сессии серверы (session level). */
    mcpServers: z.array(z.string()).optional(),
    /** AD-071 §2.4: явные opt-out сессии (включая системные). */
    mcpDisabledServers: z.array(z.string()).optional(),
  })
  .refine(
    (v) => v.mcpServers !== undefined || v.mcpDisabledServers !== undefined,
    { message: 'Требуется mcpServers или mcpDisabledServers' },
  );

// AD-071 §2.5: единый реестр MCP-серверов.
const registryAddSchema = z.object({
  name: z.string().min(1).max(200),
  config: mcpServerConfigSchema,
  enabledByDefault: z.boolean().optional(),
  /** Только admin может явно запросить instance-запись; иначе — user/community. */
  origin: z.enum(['instance', 'user']).optional(),
});

const registryUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: mcpServerConfigSchema.optional(),
  enabledByDefault: z.boolean().optional(),
});

export interface McpConfigStore {
  getServers(): Record<string, McpServerConfig>;
  addServer(name: string, config: McpServerConfig): Promise<void>;
  updateServer(name: string, config: McpServerConfig): Promise<void>;
  deleteServer(name: string): Promise<void>;
  hasServer(name: string): boolean;
  getServer(name: string): McpServerConfig | undefined;
}

export interface McpRoutesOptions {
  /** AD-071 §2.5: реестр MCP-серверов (если не задан — только legacy-роуты). */
  registry?: McpRegistryStore;
  /** AD-071 §2.3.1: политика сетевого доступа HTTP-серверов. */
  networkPolicy?: McpNetworkPolicy;
}

export function createMcpRoutes(
  kit: AuthKit,
  configStore: McpConfigStore,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
  options: McpRoutesOptions = {},
): Hono {
  const app = new Hono();

  // --- Список настроенных серверов ---
  app.get('/servers', kit.requireAuth, (c) => {
    const servers = configStore.getServers();
    const result: Record<string, { name: string; config: McpServerConfig; connected: boolean }> = {};

    for (const [name, config] of Object.entries(servers)) {
      const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
      result[name] = { name, config, connected };
    }

    return c.json(result);
  });

  // --- Добавить сервер ---
  app.post('/servers', kit.requireAdmin, async (c) => {
    const body = await c.req.json();
    const parsed = addServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, config } = parsed.data;
    if (configStore.hasServer(name)) {
      return c.json({ error: { code: 'CONFLICT', message: `Сервер "${name}" уже существует` } }, 409);
    }

    await configStore.addServer(name, config);

    // Синхронизируем конфиг менеджера, чтобы сервер сразу был доступен probe
    if (mcpManager) {
      mcpManager.setConfig({
        ...mcpManager.getConfig(),
        [name]: config,
      });
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config, connected }, 201);
  });

  // --- Получить сервер ---
  app.get('/servers/:name', kit.requireAuth, (c) => {
    const name = c.req.param('name');
    const config = configStore.getServer(name);
    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config, connected });
  });

  // --- Обновить сервер ---
  app.put('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    if (!configStore.hasServer(name)) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    await configStore.updateServer(name, parsed.data);

    // Если сервер был подключён — переподключаем
    if (mcpManager) {
      mcpManager.setConfig({
        ...mcpManager.getConfig(),
        [name]: parsed.data,
      });
    }

    const connected = mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;
    return c.json({ name, config: parsed.data, connected });
  });

  // --- Удалить сервер ---
  app.delete('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    if (!configStore.hasServer(name)) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (mcpManager) {
      await mcpManager.disconnectServer(name);
    }
    await configStore.deleteServer(name);

    return c.json({ success: true });
  });

  // --- Проверить подключение ---
  app.post('/servers/:name/test', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');

    // Принимаем опциональный конфиг в теле — для теста до сохранения
    let config = configStore.getServer(name);
    try {
      const body = await c.req.json();
      const bodyConfig = body?.config as McpServerConfig | undefined;
      if (bodyConfig) {
        config = bodyConfig;
      }
    } catch {
      // тело не JSON — используем конфиг из хранилища
    }

    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (!mcpManager) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'McpManager не настроен' } }, 500);
    }

    try {
      mcpManager.setConfig({ ...mcpManager.getConfig(), [name]: config });
      const tools = await mcpManager.probeServer(name);
      return c.json({ success: true, toolCount: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ success: false, error: message });
    }
  });

  // --- Probe по имени (алиас для UI; core-совместимый формат) ---
  // POST /api/v2/mcp/probe body { name } → 200 { name, tools: [{ name, description }] }.
  // Сервер не настроен → 400 VALIDATION_ERROR, ошибка подключения → 500 MCP_CONNECT_ERROR.
  app.post('/probe', kit.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === 'string'
      ? ((body as { name: string }).name).trim()
      : '';

    if (!name) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Поле name обязательно и не может быть пустым' },
      }, 400);
    }

    if (!mcpManager) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'McpManager не настроен' } }, 500);
    }

    if (!mcpManager.isServerConfigured(name)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${name}" не настроен` },
      }, 400);
    }

    try {
      const tools = await mcpManager.probeServer(name);
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

  // --- Список инструментов сервера ---
  app.get('/servers/:name/tools', kit.requireAuth, async (c) => {
    const name = c.req.param('name');
    const config = configStore.getServer(name);
    if (!config) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (!mcpManager) {
      return c.json({ tools: [] });
    }

    const entry = mcpManager.getConfiguredServers().find((s) => s.name === name);
    if (!entry?.connected) {
      try {
        const tools = await mcpManager.probeServer(name);
        return c.json({ server: name, tools, connected: false, probed: true });
      } catch (err) {
        return c.json({ server: name, tools: [], connected: false, probed: true, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const tools = mcpManager.getServerTools(name) ?? [];

    return c.json({
      server: name,
      tools,
      connected: true,
    });
  });

  // --- MCP-серверы сессии (legacy; канонический эндпоинт — /api/v2/sessions/:id/mcp) ---
  if (sessionManager) {
    /** Известные серверы: YAML-конфиг + синхронизированный реестр. */
    const knownServerNames = (): Set<string> => new Set([
      ...Object.keys(configStore.getServers()),
      ...Object.keys(mcpManager?.getConfig() ?? {}),
    ]);

    app.get('/session/:sessionId', kit.requireAuth, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
      }

      const configuredServers = configStore.getServers();
      const allServers = Object.keys(configuredServers).map((name) => ({
        name,
        active: (session.settings.mcpServers || []).includes(name),
      }));

      return c.json({
        mcpServers: session.settings.mcpServers || [],
        mcpDisabledServers: session.settings.mcpDisabledServers || [],
        allServers,
      });
    });

    app.put('/session/:sessionId', kit.requireAuth, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
      }

      const body = await c.req.json().catch(() => ({}));
      const parsed = sessionMcpSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      const { mcpServers, mcpDisabledServers } = parsed.data;
      const known = knownServerNames();

      for (const name of [...(mcpServers ?? []), ...(mcpDisabledServers ?? [])]) {
        if (!known.has(name)) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: `Сервер "${name}" не настроен` } }, 400);
        }
      }

      // Legacy-совместимость: `mcpServers` — явно включённые; `mcpDisabledServers`
      // — явные opt-out. Оба поля независимы (новый opt-out доступен и здесь).
      if (mcpServers !== undefined) session.settings.mcpServers = mcpServers;
      if (mcpDisabledServers !== undefined) session.settings.mcpDisabledServers = mcpDisabledServers;
      await sessionManager.saveSession(session);

      const configured = configStore.getServers();
      return c.json({
        mcpServers: session.settings.mcpServers || [],
        mcpDisabledServers: session.settings.mcpDisabledServers || [],
        allServers: Object.keys(configured).map((name) => ({
          name,
          active: (session.settings.mcpServers || []).includes(name),
        })),
      });
    });
  }

  // --- Единый реестр MCP-серверов (AD-071 §2.5) ---
  if (options.registry) {
    const registry = options.registry;
    const networkPolicy = options.networkPolicy;

    const syncManagerConfig = async (): Promise<void> => {
      if (!mcpManager) return;
      mcpManager.setConfig(await registry.toServerConfigMap());
      mcpManager.setServerOrigins(await registry.toOriginMap());
      mcpManager.setServerTrusts(await registry.toTrustMap());
      mcpManager.setDefaultServers(await registry.toDefaultServers());
    };

    const currentUser = (c: { get(key: 'user'): unknown }): User | null =>
      (c.get('user') as User | undefined) ?? null;

    const checkNetwork = async (
      config: McpServerConfig,
      origin: 'instance' | 'user',
    ): Promise<{ code: string; message: string } | null> => {
      // AD-071 §2.3.1: политика — для пользовательских HTTP-серверов; instance
      // (в т.ч. приватные сети инстанса) доверенные.
      if (origin !== 'user' || config.type === 'stdio' || !config.url || !networkPolicy) return null;
      const result = await evaluateMcpNetworkAccess(config.url, networkPolicy);
      if (result.allowed) return null;
      return { code: 'NETWORK_POLICY_VIOLATION', message: result.reason ?? 'Адрес запрещён сетевой политикой' };
    };

    // Список записей реестра (auth).
    app.get('/registry', kit.requireAuth, async (c) => {
      const entries = await registry.list();
      return c.json({ entries });
    });

    // Добавить запись (auth): HTTP — любой пользователь, stdio — только ADMIN.
    app.post('/registry', kit.requireAuth, async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = registryAddSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      const { name, config, enabledByDefault, origin } = parsed.data;
      const admin = kit.isAdmin(c);

      let entryOrigin: 'instance' | 'user';
      let trust: 'builtin' | 'community';
      if (config.type === 'stdio') {
        if (!admin) {
          return c.json({
            error: { code: 'FORBIDDEN', message: 'stdio-серверы может добавлять только ADMIN' },
          }, 403);
        }
        entryOrigin = 'instance';
        trust = 'builtin';
      } else {
        entryOrigin = admin && origin === 'instance' ? 'instance' : 'user';
        trust = entryOrigin === 'instance' ? 'builtin' : 'community';
      }

      const networkError = await checkNetwork(config, entryOrigin);
      if (networkError) {
        return c.json({ error: networkError }, 400);
      }

      if (await registry.getByName(name)) {
        return c.json({ error: { code: 'CONFLICT', message: `Сервер "${name}" уже существует в реестре` } }, 409);
      }

      const user = currentUser(c);
      const author = user ? { userId: user.id, username: user.username } : null;

      const entry = await registry.add({
        name,
        config,
        origin: entryOrigin,
        trust,
        author,
        enabledByDefault,
      });
      await syncManagerConfig();
      return c.json(entry, 201);
    });

    // Обновить запись (автор или ADMIN).
    app.put('/registry/:id', kit.requireAuth, async (c) => {
      const id = c.req.param('id');
      const existing = await registry.get(id);
      if (!existing) {
        return c.json({ error: { code: 'NOT_FOUND', message: `Запись "${id}" не найдена` } }, 404);
      }

      const admin = kit.isAdmin(c);
      const user = currentUser(c);
      if (!admin && existing.author?.userId !== user?.id) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Обновлять запись может автор или ADMIN' } }, 403);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = registryUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      const nextConfig = parsed.data.config ?? existing.config;
      if (nextConfig.type === 'stdio' && !admin) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'stdio-серверы может изменять только ADMIN' } }, 403);
      }

      const networkError = await checkNetwork(nextConfig, existing.origin);
      if (networkError) {
        return c.json({ error: networkError }, 400);
      }

      if (
        parsed.data.name
        && parsed.data.name !== existing.name
        && await registry.getByName(parsed.data.name)
      ) {
        return c.json({
          error: { code: 'CONFLICT', message: `Сервер "${parsed.data.name}" уже существует в реестре` },
        }, 409);
      }

      const updated = await registry.update(id, parsed.data);
      await syncManagerConfig();
      return c.json(updated);
    });

    // Удалить запись (автор или ADMIN).
    app.delete('/registry/:id', kit.requireAuth, async (c) => {
      const id = c.req.param('id');
      const existing = await registry.get(id);
      if (!existing) {
        return c.json({ error: { code: 'NOT_FOUND', message: `Запись "${id}" не найдена` } }, 404);
      }

      const admin = kit.isAdmin(c);
      const user = currentUser(c);
      if (!admin && existing.author?.userId !== user?.id) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Удалять запись может автор или ADMIN' } }, 403);
      }

      if (mcpManager) await mcpManager.disconnectServer(existing.name);
      await registry.remove(id);
      await syncManagerConfig();
      return c.json({ success: true });
    });
  }

  return app;
}
