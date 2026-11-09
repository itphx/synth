import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { McpServerConfig, McpNetworkPolicy, McpRegistryEntry, User } from '@itphx/synth-shared';
import {
  sessionMcpScopeSchema,
  hasServiceScope,
  findForbiddenMcpSecretHeaders,
  mcpSecretHeaderErrorMessage,
  MCP_REMOTE_MODES,
  MCP_SECRET_HEADER_ERROR_CODE,
} from '@itphx/synth-shared';
import { mcpServerConfigSchema } from '@itphx/synth-shared/config';
import type { McpManager } from '../../engine/mcp/index.js';
import { evaluateMcpNetworkAccess } from '../../engine/mcp/network-policy.js';
import { syncMcpManagerFromRegistry } from '../../engine/mcp/manager-sync.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { ExternalCredentialRepository } from '../../storage/ports/external-credential-repository.js';
import { McpRegistryValidationError } from '../../storage/mcp-registry-store.js';
import { createCredentialBindGuard } from '../credential-bind-guard.js';
import { getServiceCredential, requireScope, requireScopeOrAdminRole } from '../service-scope.js';

/**
 * ADR-071 §2.5: единый реестр MCP-серверов — HTTP-контур (core + managed).
 *
 * Фабрика общая для standalone (core) и managed (backend): backend передаёт
 * свои guard'ы (RBAC/service-scope) и i18n-сообщения через `opts`, core —
 * core-дефолты и русские литералы. Логика здесь одна — расхождение правил
 * между режимами невозможно (инвариант «общая логика — в core»).
 *
 * В standalone реестр — **источник истины** для конфигурации серверов
 * (паритет с managed): `config.mcp.servers` сидируются в реестр при старте
 * (`seedFromConfig`), менеджер заполняется картами реестра, а любая мутация
 * реестра перечитывает их (`syncMcpManagerFromRegistry`).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface McpRegistryRoutesAuth {
  requireAuth: Middleware;
  /**
   * Роль `ADMIN` у пользователя запроса. Не задана — определяется по
   * `user.roles` (локальный пользователь standalone — `ADMIN`).
   */
  isAdmin?: (c: Context) => boolean;
}

/** Локализуемые сообщения: backend передаёт `t()`, core — русские литералы. */
export interface McpRegistryRouteMessages {
  serverExists: (c: Context, name: string) => string;
  serverExistsInRegistry: (c: Context, name: string) => string;
  serverNotFound: (c: Context, name: string) => string;
  serverNotConfigured: (c: Context, name: string) => string;
  entryNotFound: (c: Context, id: string) => string;
  sessionNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
  credentialNotFound: (c: Context) => string;
  stdioAdminOnlyAdd: (c: Context) => string;
  stdioAdminOnlyUpdate: (c: Context) => string;
  updateForbidden: (c: Context) => string;
  deleteForbidden: (c: Context) => string;
  networkPolicyViolation: (c: Context, reason?: string) => string;
  managerNotConfigured: (c: Context) => string;
}

const DEFAULT_MESSAGES: McpRegistryRouteMessages = {
  serverExists: (_c, name) => `Сервер "${name}" уже существует`,
  serverExistsInRegistry: (_c, name) => `Сервер "${name}" уже существует в реестре`,
  serverNotFound: (_c, name) => `Сервер "${name}" не найден`,
  serverNotConfigured: (_c, name) => `Сервер "${name}" не настроен`,
  entryNotFound: (_c, id) => `Запись "${id}" не найдена`,
  sessionNotFound: () => 'Сессия не найдена',
  forbidden: () => 'Недостаточно прав',
  credentialNotFound: () => 'Внешний доступ не найден',
  stdioAdminOnlyAdd: () => 'stdio-серверы может добавлять только ADMIN',
  stdioAdminOnlyUpdate: () => 'stdio-серверы может изменять только ADMIN',
  updateForbidden: () => 'Обновлять запись может автор или ADMIN',
  deleteForbidden: () => 'Удалять запись может автор или ADMIN',
  networkPolicyViolation: (_c, reason) => reason ?? 'Адрес запрещён сетевой политикой',
  managerNotConfigured: () => 'McpManager не настроен',
};

export interface McpRegistryRoutesOptions {
  /** ADR-071 §2.5: единый реестр MCP-серверов (источник истины). */
  registry: McpRegistryRepository;
  /** ADR-071 §2.3.1: политика сетевого доступа HTTP-серверов. */
  networkPolicy?: McpNetworkPolicy;
  /**
   * ADR-071 §2.3.1: динамический источник политики (runtime-настройка из админки).
   * Приоритетнее статической `networkPolicy`; читается на каждый запрос.
   */
  getNetworkPolicy?: () => Promise<McpNetworkPolicy | undefined>;
  /**
   * ADR-105 (Ф3): порт слоя внешних доступов — право привязать доступ
   * к коннектору проверяется на границе (инвариант 16). Не задан — привязка
   * запрещена (fail-closed).
   */
  credentials?: ExternalCredentialRepository;
  /**
   * ADR-105 (Ф3): право участника проекта **изменять содержимое** проекта
   * (`OWNER`/`EDITOR`, а также `LEAD`/`ADMIN`) — для доступа уровня проекта.
   */
  canEditProject?: (c: Context, projectId: string) => boolean | Promise<boolean>;
  /** Guard «только ADMIN» (`POST /servers`). Core-дефолт — проверка роли. */
  requireAdmin?: Middleware;
  /**
   * Guard «ADMIN или scope `addons:install`» (`PUT/DELETE /servers/:name`,
   * `POST /servers/:name/test`). Core-дефолт — `requireScopeOrAdminRole`.
   */
  requireAdminOrScope?: Middleware;
  /**
   * Guard «service-key → scope `addons:install`» (`POST /registry`);
   * интерактивные креды — без изменений. Core-дефолт — `requireScope`.
   */
  requireScopeForServiceKey?: Middleware;
  /** Сообщения об отказах (backend — i18n, core — русские литералы). */
  messages?: Partial<McpRegistryRouteMessages>;
}

const addServerSchema = z.object({
  name: z.string().min(1),
  config: mcpServerConfigSchema,
});

const updateServerSchema = mcpServerConfigSchema;

// ADR-071 §2.5: единый реестр MCP-серверов.
const registryAddSchema = z.object({
  name: z.string().min(1).max(200),
  config: mcpServerConfigSchema,
  /** Системный мастер-флаг (дефолт `true`). */
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  /** PROP-125: режим доставки сервера в локальные сессии гибрида (дефолт `auto`). */
  remoteMode: z.enum(MCP_REMOTE_MODES).optional(),
  /** Только admin может явно запросить instance-запись; иначе — user/community. */
  origin: z.enum(['instance', 'user']).optional(),
});

const registryUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: mcpServerConfigSchema.optional(),
  /** Системный мастер-флаг. */
  enabled: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  /** PROP-125: режим доставки сервера в локальные сессии гибрида. */
  remoteMode: z.enum(MCP_REMOTE_MODES).optional(),
});

/** Роль `ADMIN` у пользователя запроса (core-дефолт проверки `isAdmin`). */
function userHasAdminRole(c: Context): boolean {
  const user = c.get('user') as { roles?: string[] } | undefined;
  return !!user && Array.isArray(user.roles) && user.roles.includes('ADMIN');
}

/**
 * Core-дефолт guard'а «только ADMIN»: нет аутентификации → 401, нет роли →
 * 403 (семантика HTTP, как у backend `requireAdmin`).
 */
const requireAdminRole: Middleware = createMiddleware(async (c, next) => {
  // `c.get` в middleware-контексте — с узким набором ключей (как в
  // `server/service-scope.ts`).
  const user = c.get('user' as never) as { roles?: string[] } | undefined;
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Требуется аутентификация' } }, 401);
  }
  if (!Array.isArray(user.roles) || !user.roles.includes('ADMIN')) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } }, 403);
  }
  await next();
});

/**
 * ADR-105 (Ф3): plaintext-секрет в заголовках коннектора запрещён —
 * авторизация только через слой внешних доступов (`auth.kind='credential'`).
 *
 * Значений заголовков в тексте ошибки нет — только их имена.
 */
function secretHeaderError(
  config: McpServerConfig | undefined | null,
): { code: string; message: string } | null {
  const forbidden = findForbiddenMcpSecretHeaders(config?.headers);
  if (forbidden.length === 0) return null;
  return { code: MCP_SECRET_HEADER_ERROR_CODE, message: mcpSecretHeaderErrorMessage(forbidden) };
}

/**
 * ADR-105 (Ф3): хранилище реестра — последний ругеж запрета plaintext-секрета.
 * Ошибка валидации → 400 с тем же кодом (иначе роут отдал бы 500).
 */
function secretHeaderStoreError(err: unknown): { code: string; message: string } | null {
  if (err instanceof McpRegistryValidationError && err.code === MCP_SECRET_HEADER_ERROR_CODE) {
    return { code: err.code, message: err.message };
  }
  return null;
}

export function createMcpRegistryRoutes(
  auth: McpRegistryRoutesAuth,
  mcpManager: McpManager | null,
  sessionManager: SessionManager | null,
  options: McpRegistryRoutesOptions,
): Hono {
  const app = new Hono();
  const registry = options.registry;
  const messages: McpRegistryRouteMessages = { ...DEFAULT_MESSAGES, ...options.messages };
  const isAdmin = auth.isAdmin ?? userHasAdminRole;
  const adminGuard = options.requireAdmin ?? requireAdminRole;
  const adminOrScopeGuard = options.requireAdminOrScope ?? requireScopeOrAdminRole('addons:install');
  const scopeForServiceKeyGuard = options.requireScopeForServiceKey ?? requireScope('addons:install');

  const resolveNetworkPolicy = async (): Promise<McpNetworkPolicy | undefined> =>
    (options.getNetworkPolicy ? await options.getNetworkPolicy() : undefined) ?? options.networkPolicy;

  /** Синхронизировать конфиг менеджера из реестра — одно чтение на все карты. */
  const syncManagerConfig = async (): Promise<void> => {
    if (!mcpManager) return;
    await syncMcpManagerFromRegistry(mcpManager, registry);
  };

  const isConnected = (name: string): boolean =>
    mcpManager?.getConfiguredServers().find((s) => s.name === name)?.connected ?? false;

  const currentUser = (c: { get(key: 'user'): unknown }): User | null =>
    (c.get('user') as User | undefined) ?? null;

  /**
   * ADR-105 (Ф3): граница проверки права привязки внешнего доступа к коннектору
   * (инвариант 16 — проверка не в обработчике, правило — в core).
   *
   * Актор — пользователь запроса (для service-key — синтетический
   * `service:<keyId>` с ролями ключа, ADR-052).
   */
  const checkCredentialBinding = createCredentialBindGuard({
    ...(options.credentials ? { credentials: options.credentials } : {}),
    resolveActor: (c) => {
      const user = currentUser(c);
      return { userId: user?.id ?? '', roles: user?.roles ?? [] };
    },
    ...(options.canEditProject ? { canEditProject: options.canEditProject } : {}),
    messages: {
      notFound: (c) => messages.credentialNotFound(c),
      forbidden: (c) => messages.forbidden(c),
    },
  });

  /**
   * ADR-052/O1: запрос от installer-service-key (scope `addons:install`).
   * Даёт scoped-ключу без роли ADMIN создавать **instance**-записи реестра
   * (общие для инстанса, а не персональные) и обновлять созданные им записи.
   */
  const isInstallerKey = (c: Context): boolean => {
    const cred = getServiceCredential(c);
    return !!cred && hasServiceScope(cred.scopes, 'addons:install');
  };

  const checkNetwork = async (
    c: Context,
    config: McpServerConfig,
    origin: 'instance' | 'user',
  ): Promise<{ code: string; message: string } | null> => {
    // ADR-071 §2.3.1: политика — для пользовательских HTTP-серверов; instance
    // (в т.ч. приватные сети инстанса) доверенные.
    if (origin !== 'user' || config.type === 'stdio' || !config.url) return null;
    const policy = await resolveNetworkPolicy();
    if (!policy) return null;
    const result = await evaluateMcpNetworkAccess(config.url, policy);
    if (result.allowed) return null;
    return {
      code: 'NETWORK_POLICY_VIOLATION',
      message: messages.networkPolicyViolation(c, result.reason),
    };
  };

  // ---------------------------------------------------------------------------
  // Legacy `/servers*` — тонкие адаптеры над единым реестром (ADR-071 §2.5).
  // Второго хранилища (config.yaml) больше нет: источник истины — реестр.
  // ---------------------------------------------------------------------------

  // --- Список настроенных серверов ---
  app.get('/servers', auth.requireAuth, async (c) => {
    const entries = await registry.list();
    const result: Record<string, { name: string; config: McpServerConfig; connected: boolean }> = {};
    for (const entry of entries) {
      result[entry.name] = { name: entry.name, config: entry.config, connected: isConnected(entry.name) };
    }
    return c.json(result);
  });

  // --- Добавить сервер (instance-запись; ADMIN) ---
  app.post('/servers', adminGuard, async (c) => {
    const body = await c.req.json();
    const parsed = addServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, config } = parsed.data;
    if (await registry.getByName(name)) {
      return c.json({ error: { code: 'CONFLICT', message: messages.serverExists(c, name) } }, 409);
    }

    // ADR-105 (Ф3): plaintext-секрет в заголовках → 400 (не 500).
    const secretError = secretHeaderError(config);
    if (secretError) {
      return c.json({ error: secretError }, 400);
    }

    // ADR-105 (Ф3): право привязать внешний доступ к коннектору (граница).
    const bindError = await checkCredentialBinding(c, config);
    if (bindError) {
      return c.json({ error: bindError }, bindError.code === 'NOT_FOUND' ? 404 : 403);
    }

    const networkError = await checkNetwork(c, config, 'instance');
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    // ADMIN-роут: сервер трактуется как instance/builtin (как config.mcp.servers).
    await registry.add({ name, config, origin: 'instance', trust: 'builtin' });
    await syncManagerConfig();

    return c.json({ name, config, connected: isConnected(name) }, 201);
  });

  // --- Получить сервер ---
  app.get('/servers/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.serverNotFound(c, name) } }, 404);
    }
    return c.json({ name: entry.name, config: entry.config, connected: isConnected(entry.name) });
  });

  // --- Обновить сервер (ADMIN или scope `addons:install`) ---
  app.put('/servers/:name', adminOrScopeGuard, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.serverNotFound(c, name) } }, 404);
    }

    const body = await c.req.json();
    const parsed = updateServerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    // ADR-105 (Ф3): plaintext-секрет в заголовках → 400 (не 500).
    const secretError = secretHeaderError(parsed.data);
    if (secretError) {
      return c.json({ error: secretError }, 400);
    }

    // ADR-105 (Ф3): право привязать внешний доступ к коннектору (граница).
    const bindError = await checkCredentialBinding(
      c,
      parsed.data,
      entry.config.auth?.kind === 'credential' ? entry.config.auth.credentialId : undefined,
    );
    if (bindError) {
      return c.json({ error: bindError }, bindError.code === 'NOT_FOUND' ? 404 : 403);
    }

    const networkError = await checkNetwork(c, parsed.data, entry.origin);
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    await registry.update(entry.id, { config: parsed.data });
    await syncManagerConfig();

    return c.json({ name, config: parsed.data, connected: isConnected(name) });
  });

  // --- Удалить сервер (ADMIN или scope `addons:install`) ---
  app.delete('/servers/:name', adminOrScopeGuard, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.serverNotFound(c, name) } }, 404);
    }

    if (mcpManager) {
      await mcpManager.disconnectServer(name);
    }
    await registry.remove(entry.id);
    await syncManagerConfig();

    return c.json({ success: true });
  });

  // --- Проверить подключение (ADMIN или scope `addons:install`) ---
  app.post('/servers/:name/test', adminOrScopeGuard, async (c) => {
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
      return c.json({ error: { code: 'NOT_FOUND', message: messages.serverNotFound(c, name) } }, 404);
    }

    // ADR-105 (Ф3): probe/тест не подключается к коннектору с plaintext-секретом.
    const secretError = secretHeaderError(config);
    if (secretError) {
      return c.json({ error: secretError }, 400);
    }

    if (!mcpManager) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: messages.managerNotConfigured(c) } }, 500);
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
  app.get('/servers/:name/tools', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    const entry = await registry.getByName(name);
    if (!entry) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.serverNotFound(c, name) } }, 404);
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
    /**
     * ADR-071 §2.4 / инвариант 16: доступ к MCP-скоупу сессии — **владелец
     * сессии или ADMIN** (та же политика, что у `GET/PUT /api/v2/sessions/:id/mcp`
     * в core-фабрике; LEAD и участник проекта сюда не допускаются).
     *
     * Проверка — на границе роута, до обработчика: нет сессии → 404, чужой →
     * 403. Без неё legacy-путь `/api/v2/mcp/session/:sessionId` был IDOR:
     * любой аутентифицированный читал и менял MCP-скоуп **чужой** сессии по id
     * (обнаружено переписью маршрутов `route-access-census.test.ts`).
     */
    const sessionOwnerGuard = async (c: Context, next: Next): Promise<Response | void> => {
      const session = await sessionManager.getSession(c.req.param('sessionId') ?? '');
      if (!session) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } },
          404,
        );
      }
      const user = currentUser(c);
      const ownerId = session.ownerId ?? session.userId;
      if (!user?.id || (ownerId !== user.id && !isAdmin(c))) {
        return c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);
      }
      await next();
    };

    /** Известные серверы — единый реестр. */
    const knownServerNames = async (): Promise<Set<string>> =>
      new Set((await registry.list()).map((e) => e.name));

    app.get('/session/:sessionId', auth.requireAuth, sessionOwnerGuard, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
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

    app.put('/session/:sessionId', auth.requireAuth, sessionOwnerGuard, async (c) => {
      const sessionId = c.req.param('sessionId');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
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
          return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.serverNotConfigured(c, name) } }, 400);
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

  // --- Единый реестр MCP-серверов (ADR-071 §2.5) ---

  // Список записей реестра (auth).
  app.get('/registry', auth.requireAuth, async (c) => {
    const entries = await registry.list();
    return c.json({ entries });
  });

  // Добавить запись (auth): HTTP — любой пользователь, stdio — только ADMIN.
  // ADR-052/O1: service-key должен нести scope `addons:install` (интерактив без
  // изменений — HTTP добавляет любой, stdio-проверка ниже). Installer-ключ со
  // scope создаёт instance-записи (общие для инстанса) без роли ADMIN.
  app.post('/registry', auth.requireAuth, scopeForServiceKeyGuard, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = registryAddSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const { name, config, enabled, enabledByDefault, origin, remoteMode } = parsed.data;
    const admin = isAdmin(c);

    // ADR-105 (Ф3): plaintext-секрет в заголовках → 400 (не 500).
    const secretError = secretHeaderError(config);
    if (secretError) {
      return c.json({ error: secretError }, 400);
    }

    // ADR-105 (Ф3): право привязать внешний доступ к коннектору (граница).
    const bindError = await checkCredentialBinding(c, config);
    if (bindError) {
      return c.json({ error: bindError }, bindError.code === 'NOT_FOUND' ? 404 : 403);
    }

    // ADR-052/O1: installer-ключ (scope `addons:install`) создаёт instance-записи
    // даже без роли ADMIN — это общие записи инстанса (а не персональные).
    const isInstaller = isInstallerKey(c);

    let entryOrigin: 'instance' | 'user';
    let trust: 'builtin' | 'community';
    if (config.type === 'stdio') {
      // stdio — только ADMIN (scope НЕ ослабляет проверку).
      if (!admin) {
        return c.json({
          error: { code: 'FORBIDDEN', message: messages.stdioAdminOnlyAdd(c) },
        }, 403);
      }
      entryOrigin = 'instance';
      trust = 'builtin';
    } else {
      const wantsInstance = origin === 'instance' || isInstaller;
      entryOrigin = (admin || isInstaller) && wantsInstance ? 'instance' : 'user';
      trust = entryOrigin === 'instance' ? 'builtin' : 'community';
    }

    const networkError = await checkNetwork(c, config, entryOrigin);
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    if (await registry.getByName(name)) {
      return c.json({ error: { code: 'CONFLICT', message: messages.serverExistsInRegistry(c, name) } }, 409);
    }

    const user = currentUser(c);
    const author = user ? { userId: user.id, username: user.username } : null;

    let entry: McpRegistryEntry;
    try {
      entry = await registry.add({
        name,
        config,
        origin: entryOrigin,
        trust,
        author,
        enabled,
        enabledByDefault,
        remoteMode,
      });
    } catch (err) {
      // ADR-105 (Ф3): запрет plaintext-секрета → 400, а не 500.
      const storeError = secretHeaderStoreError(err);
      if (storeError) return c.json({ error: storeError }, 400);
      throw err;
    }
    await syncManagerConfig();
    return c.json(entry, 201);
  });

  // Обновить запись (автор, ADMIN или installer-ключ со scope `addons:install`).
  app.put('/registry/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const existing = await registry.get(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.entryNotFound(c, id) } }, 404);
    }

    const admin = isAdmin(c);
    const user = currentUser(c);
    // Автор записи (для service-key автор — `service:<keyId>`), ADMIN **или**
    // installer-ключ со scope `addons:install`: аддон может обновлять созданные
    // им instance-записи; scope-ветка переживает ротацию/пересоздание ключа
    // (id меняется, author-check бы не сработал).
    const isAuthor = existing.author?.userId === user?.id;
    if (!admin && !isAuthor && !isInstallerKey(c)) {
      return c.json({ error: { code: 'FORBIDDEN', message: messages.updateForbidden(c) } }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = registryUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const nextConfig = parsed.data.config ?? existing.config;
    if (nextConfig.type === 'stdio' && !admin) {
      return c.json({ error: { code: 'FORBIDDEN', message: messages.stdioAdminOnlyUpdate(c) } }, 403);
    }

    // ADR-105 (Ф3): plaintext-секрет в заголовках → 400 (не 500).
    const secretError = secretHeaderError(nextConfig);
    if (secretError) {
      return c.json({ error: secretError }, 400);
    }

    // ADR-105 (Ф3): право привязать внешний доступ к коннектору (граница).
    const bindError = await checkCredentialBinding(
      c,
      nextConfig,
      existing.config.auth?.kind === 'credential' ? existing.config.auth.credentialId : undefined,
    );
    if (bindError) {
      return c.json({ error: bindError }, bindError.code === 'NOT_FOUND' ? 404 : 403);
    }

    const networkError = await checkNetwork(c, nextConfig, existing.origin);
    if (networkError) {
      return c.json({ error: networkError }, 400);
    }

    if (
      parsed.data.name
      && parsed.data.name !== existing.name
      && await registry.getByName(parsed.data.name)
    ) {
      return c.json({
        error: { code: 'CONFLICT', message: messages.serverExistsInRegistry(c, parsed.data.name) },
      }, 409);
    }

    let updated: McpRegistryEntry | null;
    try {
      updated = await registry.update(id, parsed.data);
    } catch (err) {
      // ADR-105 (Ф3): запрет plaintext-секрета → 400, а не 500.
      const storeError = secretHeaderStoreError(err);
      if (storeError) return c.json({ error: storeError }, 400);
      throw err;
    }
    await syncManagerConfig();
    return c.json(updated);
  });

  // Удалить запись (автор или ADMIN).
  app.delete('/registry/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    const existing = await registry.get(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.entryNotFound(c, id) } }, 404);
    }

    const admin = isAdmin(c);
    const user = currentUser(c);
    if (!admin && existing.author?.userId !== user?.id) {
      return c.json({ error: { code: 'FORBIDDEN', message: messages.deleteForbidden(c) } }, 403);
    }

    if (mcpManager) await mcpManager.disconnectServer(existing.name);
    await registry.remove(id);
    await syncManagerConfig();
    return c.json({ success: true });
  });

  return app;
}
