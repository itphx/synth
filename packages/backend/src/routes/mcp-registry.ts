import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, McpManager, McpRegistryStore } from '@itphx/synth-core';
import { evaluateMcpNetworkAccess } from '@itphx/synth-core';
import type { McpServerConfig, McpNetworkPolicy, User } from '@itphx/synth-shared';
import { sessionMcpScopeSchema } from '@itphx/synth-shared';
import { mcpServerConfigSchema } from '@itphx/synth-shared/config';

// Backend-only MCP-роуты (AD-071 §2.5): legacy `/servers*`, `/session/:id` и
// единый реестр `/registry*`. Probe (`POST /probe`) — общая логика core,
// монтируется в `routes/mcp.ts` ПЕРЕД этим роутером.

const addServerSchema = z.object({
  name: z.string().min(1),
  config: mcpServerConfigSchema,
});

const updateServerSchema = mcpServerConfigSchema;

// AD-071 §2.5: единый реестр MCP-серверов.
const registryAddSchema = z.object({
  name: z.string().min(1).max(200),
  config: mcpServerConfigSchema,
  /** Системный мастер-флаг (дефолт `true`). */
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  /** Только admin может явно запросить instance-запись; иначе — user/community. */
  origin: z.enum(['instance', 'user']).optional(),
});

const registryUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: mcpServerConfigSchema.optional(),
  /** Системный мастер-флаг. */
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
});

export interface McpRoutesOptions {
  /** AD-071 §2.5: единый реестр MCP-серверов (источник истины для `/servers` и `/registry`). */
  registry: McpRegistryStore;
  /** AD-071 §2.3.1: политика сетевого доступа HTTP-серверов. */
  networkPolicy?: McpNetworkPolicy;
  /**
   * AD-071 §2.3.1: динамический источник политики (runtime-настройка из админки).
   * Приоритетнее статической `networkPolicy`; читается на каждый запрос.
   */
  getNetworkPolicy?: () => McpNetworkPolicy | undefined;
}

export function createMcpRegistryRoutes(
  kit: AuthKit,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
  options: McpRoutesOptions,
): Hono {
  const app = new Hono();
  const registry = options.registry;
  const resolveNetworkPolicy = (): McpNetworkPolicy | undefined =>
    options.getNetworkPolicy?.() ?? options.networkPolicy;

  /** Синхронизировать конфиг менеджера из реестра — одно чтение на все карты. */
  const syncManagerConfig = async (): Promise<void> => {
    if (!mcpManager) return;
    const maps = await registry.toManagerMaps();
    mcpManager.setConfig(maps.servers);
    mcpManager.setServerOrigins(maps.origins);
    mcpManager.setServerTrusts(maps.trusts);
    mcpManager.setServerAuthors(maps.authors);
    mcpManager.setDefaultServers(maps.defaults);
    mcpManager.setServerSystemEnabled(maps.systemEnabled);
  };

  const isConnected = (name: string): boolean =>
    mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;

  const currentUser = (c: { get(key: 'user'): unknown }): User | null =>
    (c.get('user') as User | undefined) ?? null;

  const checkNetwork = async (
    config: McpServerConfig,
    origin: 'instance' | 'user',
  ): Promise<{ code: string; message: string } | null> => {
    // AD-071 §2.3.1: политика — для пользовательских HTTP-серверов; instance
    // (в т.ч. приватные сети инстанса) доверенные.
    if (origin !== 'user' || config.type === 'stdio' || !config.url) return null;
    const policy = resolveNetworkPolicy();
    if (!policy) return null;
    const result = await evaluateMcpNetworkAccess(config.url, policy);
    if (result.allowed) return null;
    return { code: 'NETWORK_POLICY_VIOLATION', message: result.reason ?? 'Адрес запрещён сетевой политикой' };
  };

  // ---------------------------------------------------------------------------
  // Legacy `/servers*` — тонкие адаптеры над единым реестром (AD-071 §2.5).
  // Второго хранилища (config.yaml) больше нет: источник истины — McpRegistryStore.
  // ---------------------------------------------------------------------------

  // --- Список настроенных серверов ---
  app.get('/servers', kit.requireAuth, async (c) => {
    const entries = await registry.list();
    const result: Record<string, { name: string; config: McpServerConfig; connected: boolean }> = {};
    for (const entry of entries) {
      result[entry.name] = { name: entry.name, config: entry.config, connected: isConnected(entry.name) };
    }
    return c.json(result);
  });

  // --- Добавить сервер (instance-запись; ADMIN) ---
  app.post('/servers', kit.requireAdmin, async (c) => {
    const body = await c.req.json();
    const parsed = addServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, config } = parsed.data;
    if (await registry.getByName(name)) {
      return c.json({ error: { code: 'CONFLICT', message: `Сервер "${name}" уже существует` } }, 409);
    }

    const networkError = await checkNetwork(config, 'instance');
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    // ADMIN-роут: сервер трактуется как instance/builtin (как config.mcp.servers).
    await registry.add({ name, config, origin: 'instance', trust: 'builtin' });
    await syncManagerConfig();

    return c.json({ name, config, connected: isConnected(name) }, 201);
  });

  // --- Получить сервер ---
  app.get('/servers/:name', kit.requireAuth, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }
    return c.json({ name: entry.name, config: entry.config, connected: isConnected(entry.name) });
  });

  // --- Обновить сервер (ADMIN) ---
  app.put('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const networkError = await checkNetwork(parsed.data, entry.origin);
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    await registry.update(entry.id, { config: parsed.data });
    await syncManagerConfig();

    return c.json({ name, config: parsed.data, connected: isConnected(name) });
  });

  // --- Удалить сервер (ADMIN) ---
  app.delete('/servers/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (mcpManager) {
      await mcpManager.disconnectServer(name);
    }
    await registry.remove(entry.id);
    await syncManagerConfig();

    return c.json({ success: true });
  });

  // --- Проверить подключение (ADMIN) ---
  app.post('/servers/:name/test', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');

    // Принимаем опциональный конфиг в теле — для теста до сохранения.
    let config: McpServerConfig | undefined;
    try {
      const body = await c.req.json();
      const bodyConfig = body?.config as McpServerConfig | undefined;
      if (bodyConfig) config = bodyConfig;
    } catch {
      // тело не JSON — используем конфиг из реестра
    }
    config ??= (await registry.getByName(name))?.config;

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

  // --- Список инструментов сервера ---
  app.get('/servers/:name/tools', kit.requireAuth, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Сервер "${name}" не найден` } }, 404);
    }

    if (!mcpManager) {
      return c.json({ tools: [] });
    }

    const configured = mcpManager.getConfiguredServers().find((s) => s.name === name);
    if (!configured?.connected) {
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
    /** Известные серверы — единый реестр. */
    const knownServerNames = async (): Promise<Set<string>> =>
      new Set((await registry.list()).map((e) => e.name));

    app.get('/session/:sessionId', kit.requireAuth, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
      }

      const entries = await registry.list();
      const allServers = entries.map((entry) => ({
        name: entry.name,
        active: (session.settings.mcpServers || []).includes(entry.name),
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
      const parsed = sessionMcpScopeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      const { mcpServers, mcpDisabledServers } = parsed.data;
      const known = await knownServerNames();

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

      const entries = await registry.list();
      return c.json({
        mcpServers: session.settings.mcpServers || [],
        mcpDisabledServers: session.settings.mcpDisabledServers || [],
        allServers: entries.map((entry) => ({
          name: entry.name,
          active: (session.settings.mcpServers || []).includes(entry.name),
        })),
      });
    });
  }

  // --- Единый реестр MCP-серверов (AD-071 §2.5) ---

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

    const { name, config, enabled, enabledByDefault, origin } = parsed.data;
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
      enabled,
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

  return app;
}
