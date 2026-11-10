/**
 * Workstream A2: write-инструменты MCP для агента.
 *
 * Агент (ADMIN или автор user-записи) может добавить/обновить/удалить
 * MCP-сервер, включить его на уровне сессии/проекта/инстанса и переподключить
 * после рестарта MCP-сервера — без curl/UI и без рестарта Synth.
 *
 * Правила:
 * - мутации идут **через существующие порты** (`McpRegistryRepository`) и
 *   сервис синхронизации (`syncMcpManagerFromRegistry`) — логика HTTP-роутов
 *   не дублируется;
 * - видимость/права — как у read-тулов: author user-записи или elevated
 *   (ADMIN/LEAD); `origin:'instance'`/`stdio` и instance master flag — только ADMIN;
 * - секреты не возвращаются: URL в ошибках редактируется (`redactUrl`),
 *   `headers`/`env` не попадают в ответ;
 * - `auth.kind:'credential'` пока запрещён (нужна проводка слоя доступов).
 */
import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/synth-shared';
import type {
  McpServerConfig,
  McpServerEffective,
  McpRegistryEntry,
  Project,
  Session,
  ToolContext,
  ToolDefinition,
} from '@itphx/synth-shared';
import { mcpServerConfigSchema } from '@itphx/synth-shared/config';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { McpManager } from '../mcp/manager.js';
import { syncMcpManagerFromRegistry } from '../mcp/manager-sync.js';
import { McpRegistryValidationError, assertNoMcpSecretHeaders } from '../../storage/mcp-registry-store.js';
import { evaluateMcpNetworkAccess } from '../mcp/network-policy.js';
import { canEditProject } from './project-access.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { resolveViewer } from './project-resolve.js';
import {
  type InstanceToolsExtra,
  effectiveServerNames,
  isMcpEntryVisible,
  redactUrl,
  visibleServerNames,
} from './instance.js';

/** `extra` write-тулов MCP: read-зависимости + события/реестр тулов. */
export type InstanceMcpExtra = InstanceToolsExtra;

const MAX_TOOL_NAMES = 50;

const mcpConfigSchema = mcpServerConfigSchema;

function getExtra(ctx: ToolContext): InstanceMcpExtra {
  return (ctx.extra ?? {}) as InstanceMcpExtra;
}

function fail(key: Parameters<typeof sm>[0], params?: Record<string, string>) {
  return {
    content: sm(key, params),
    isError: true as const,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

function depsError(toolName: string) {
  return fail('instance.deps_unavailable', { tool: toolName });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface MutationDeps {
  manager: McpManager;
  registry: McpRegistryRepository;
}

function mutationDeps(extra: InstanceMcpExtra, toolName: string): MutationDeps | ReturnType<typeof depsError> {
  if (!extra.mcpManager || !extra.mcpRegistry) return depsError(toolName);
  return { manager: extra.mcpManager, registry: extra.mcpRegistry };
}

function isDepsError(value: unknown): value is ReturnType<typeof depsError> {
  return typeof value === 'object' && value !== null && (value as { isError?: boolean }).isError === true;
}

/** Проверка config: credential-auth и plaintext-секретные заголовки. */
function validateConfig(config: McpServerConfig): ReturnType<typeof fail> | null {
  if (config.auth?.kind === 'credential') {
    return fail('instance.mcp.credential_unsupported');
  }
  try {
    assertNoMcpSecretHeaders(config);
  } catch (err) {
    if (err instanceof McpRegistryValidationError) {
      return fail('instance.mcp.secret_header', { error: err.message });
    }
    return fail('instance.mcp.invalid_config', { error: errorText(err) });
  }
  return null;
}

/**
 * Сетевая политика — только для пользовательских HTTP/SSE серверов (как у
 * HTTP-роута). Ошибка проверки — fail-closed.
 */
async function validateNetwork(
  extra: InstanceMcpExtra,
  config: McpServerConfig,
  origin: 'instance' | 'user',
): Promise<ReturnType<typeof fail> | null> {
  if (origin !== 'user') return null;
  if (config.type !== 'http' && config.type !== 'sse') return null;
  if (!config.url) return fail('instance.mcp.invalid_config', { error: 'url is required for http/sse' });
  const rawUrl = config.url;
  const safeUrl = redactUrl(rawUrl);
  const mask = (text: string): string => text.split(rawUrl).join(safeUrl);
  try {
    const policy = await extra.getMcpNetworkPolicy?.();
    const result = await evaluateMcpNetworkAccess(rawUrl, policy);
    if (result.allowed) return null;
    const reason = [result.reason, result.matchedRule ? `(${result.matchedRule})` : '']
      .filter(Boolean)
      .join(' ');
    return fail('instance.mcp.network_denied', {
      url: safeUrl,
      reason: mask(reason || 'denied'),
    });
  } catch (err) {
    return fail('instance.mcp.network_denied', {
      url: safeUrl,
      reason: mask(errorText(err)),
    });
  }
}

async function loadEntry(
  registry: McpRegistryRepository,
  name: string,
): Promise<McpRegistryEntry | null> {
  try {
    return await registry.getByName(name);
  } catch {
    return null;
  }
}

async function notFound(
  extra: InstanceMcpExtra,
  name: string,
  viewer?: { userId: string; elevated: boolean },
) {
  let available = '';
  if (extra.mcpRegistry) {
    try {
      const entries = await extra.mcpRegistry.list();
      const { names } = await effectiveServerNames(extra);
      available = visibleServerNames(
        entries,
        viewer ?? { userId: 'local', elevated: false },
        names,
      );
    } catch {
      available = '';
    }
  }
  return fail('instance.mcp_not_found', { name, available: available || '—' });
}

function canManage(entry: McpRegistryEntry, viewer: { userId: string; elevated: boolean }): boolean {
  return viewer.elevated || entry.author?.userId === viewer.userId;
}

/**
 * ADR-071: полномочия **ADMIN** (не LEAD) нужны для instance-записей, stdio и
 * instance master flag. `LEAD` остаётся elevated для видимости/проектов, но не
 * получает ADMIN-права над MCP. Нет принципала — fail-closed.
 */
function isInstanceAdmin(extra: InstanceMcpExtra): boolean {
  return (extra.principal?.roles ?? []).some((role) => role.toUpperCase() === 'ADMIN');
}

async function effectiveFor(
  extra: InstanceMcpExtra,
  session?: Session,
): Promise<McpServerEffective[]> {
  try {
    if (session && extra.resolveMcpServersFor) return await extra.resolveMcpServersFor(session);
    if (extra.resolveMcpServers) return await extra.resolveMcpServers();
  } catch {
    return [];
  }
  return [];
}

function effectivePayload(effective: McpServerEffective | undefined) {
  if (!effective) return null;
  return {
    enabled: effective.enabled,
    level: effective.level,
    ...(effective.reason ? { reason: effective.reason } : {}),
  };
}

const addSchema = z.object({
  name: z.string().min(1).describe('Unique MCP server name'),
  config: mcpConfigSchema.describe('MCP server config (stdio/http/sse; no plaintext secret headers)'),
  origin: z.enum(['instance', 'user']).optional().describe('Registry origin (default user)'),
  enabled: z.boolean().optional().describe('Instance master flag (default true)'),
  enabledByDefault: z.boolean().optional().describe('Enable by default for new projects'),
});

export const synthMcpAddTool: ToolDefinition = {
  name: 'synth_mcp_add',
  description:
    'Add an MCP server to the instance registry (write). `origin: "instance"` and stdio servers '
    + 'require ADMIN (LEAD is not enough). User HTTP/SSE servers are checked against the MCP network policy; '
    + 'plaintext secret headers and credential-backed auth are rejected. The server is added '
    + 'disabled for the session — call synth_mcp_enable (level session/project/instance) to use it. '
    + 'Secrets in config (env/headers) are never returned.',
  parameters: addSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as {
      name: string;
      config: McpServerConfig;
      origin?: 'instance' | 'user';
      enabled?: boolean;
      enabledByDefault?: boolean;
    };

    const extra = getExtra(ctx);
    const deps = mutationDeps(extra, this.name);
    if (isDepsError(deps)) return deps;

    const viewer = await resolveViewer(ctx, extra);
    const origin = params.origin ?? 'user';
    if (!isInstanceAdmin(extra) && (origin === 'instance' || params.config.type === 'stdio')) {
      return fail('instance.mcp.instance_forbidden');
    }

    const invalid = validateConfig(params.config) ?? await validateNetwork(extra, params.config, origin);
    if (invalid) return invalid;

    const existing = await loadEntry(deps.registry, params.name);
    if (existing) return fail('instance.mcp.exists', { name: params.name });

    let entry: McpRegistryEntry;
    try {
      entry = await deps.registry.add({
        name: params.name,
        config: params.config,
        origin,
        author: { userId: viewer.userId, username: viewer.userId },
        trust: origin === 'instance' ? 'builtin' : 'community',
        enabled: params.enabled ?? true,
        enabledByDefault: params.enabledByDefault ?? false,
      });
    } catch (err) {
      if (err instanceof McpRegistryValidationError) {
        return fail('instance.mcp.secret_header', { error: err.message });
      }
      return fail('instance.mcp.invalid_config', { error: errorText(err) });
    }

    await syncMcpManagerFromRegistry(deps.manager, deps.registry);

    const payload = {
      name: entry.name,
      origin: entry.origin,
      enabled: entry.enabled,
      enabled_by_default: entry.enabledByDefault,
      enabled_for_session: false,
    };
    return {
      content: sm('instance.mcp_add.added', { name: entry.name, origin: entry.origin }),
      metadata: {
        ...payload,
        i18n: i18nMeta('instance.mcp_add.added', { name: entry.name, origin: entry.origin }),
      },
    };
  },
};

const updateSchema = z.object({
  name: z.string().min(1).describe('MCP server name'),
  config: mcpConfigSchema.optional().describe('New config (validated like synth_mcp_add)'),
  enabled: z.boolean().optional().describe('Instance master flag'),
  enabledByDefault: z.boolean().optional().describe('Enable by default for new projects'),
});

export const synthMcpUpdateTool: ToolDefinition = {
  name: 'synth_mcp_update',
  description:
    'Update an MCP server in the registry (write). Allowed for the record author; instance records require ADMIN. '
    + 'The name cannot be changed. Config changes are validated like synth_mcp_add (secret headers, '
    + 'credential auth, network policy for user HTTP/SSE). Secrets are never returned.',
  parameters: updateSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as {
      name: string;
      config?: McpServerConfig;
      enabled?: boolean;
      enabledByDefault?: boolean;
    };

    const extra = getExtra(ctx);
    const deps = mutationDeps(extra, this.name);
    if (isDepsError(deps)) return deps;

    const viewer = await resolveViewer(ctx, extra);
    const entry = await loadEntry(deps.registry, params.name);
    if (!entry) return notFound(extra, params.name, viewer);
    if (!canManage(entry, viewer)) return fail('instance.mcp.forbidden');
    // Instance-запись меняет только ADMIN (LEAD elevated, но не ADMIN).
    if (entry.origin === 'instance' && !isInstanceAdmin(extra)) {
      return fail('instance.mcp.instance_forbidden');
    }

    // Non-elevated не может создать/обновить stdio-конфиг (RCE): смена
    // `config.type` на stdio у своей user-записи — тот же риск, что и add.
    // stdio/instance — только ADMIN (ADR-071), LEAD недостаточно.
    if (params.config?.type === 'stdio' && !isInstanceAdmin(extra)) {
      return fail('instance.mcp.instance_forbidden');
    }

    if (params.config) {
      const invalid = validateConfig(params.config)
        ?? await validateNetwork(extra, params.config, entry.origin);
      if (invalid) return invalid;
    }

    let updated: McpRegistryEntry | null;
    try {
      updated = await deps.registry.update(entry.id, {
        ...(params.config ? { config: params.config } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.enabledByDefault !== undefined ? { enabledByDefault: params.enabledByDefault } : {}),
      });
    } catch (err) {
      if (err instanceof McpRegistryValidationError) {
        return fail('instance.mcp.secret_header', { error: err.message });
      }
      return fail('instance.mcp.invalid_config', { error: errorText(err) });
    }
    if (!updated) return notFound(extra, params.name);

    await syncMcpManagerFromRegistry(deps.manager, deps.registry);

    return {
      content: sm('instance.mcp_update.updated', { name: updated.name }),
      metadata: {
        name: updated.name,
        origin: updated.origin,
        enabled: updated.enabled,
        enabled_by_default: updated.enabledByDefault,
        i18n: i18nMeta('instance.mcp_update.updated', { name: updated.name }),
      },
    };
  },
};

const removeSchema = z.object({
  name: z.string().min(1).describe('MCP server name'),
});

export const synthMcpRemoveTool: ToolDefinition = {
  name: 'synth_mcp_remove',
  description:
    'Remove an MCP server from the registry (write). Allowed for the record author; instance records require ADMIN. '
    + 'Disconnects the server first, then removes the registry record and syncs the manager.',
  parameters: removeSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { name: string };

    const extra = getExtra(ctx);
    const deps = mutationDeps(extra, this.name);
    if (isDepsError(deps)) return deps;

    const viewer = await resolveViewer(ctx, extra);
    const entry = await loadEntry(deps.registry, params.name);
    if (!entry) return notFound(extra, params.name, viewer);
    if (!canManage(entry, viewer)) return fail('instance.mcp.forbidden');
    // Instance-запись удаляет только ADMIN (ADR-071).
    if (entry.origin === 'instance' && !isInstanceAdmin(extra)) {
      return fail('instance.mcp.instance_forbidden');
    }

    try {
      await deps.manager.disconnectServer(entry.name);
    } catch {
      // Отключение — best-effort: запись всё равно должна быть удалена.
    }
    const removed = await deps.registry.remove(entry.id);
    if (!removed) return notFound(extra, params.name);
    await syncMcpManagerFromRegistry(deps.manager, deps.registry);

    return {
      content: sm('instance.mcp_remove.removed', { name: entry.name }),
      metadata: {
        removed: true,
        name: entry.name,
        i18n: i18nMeta('instance.mcp_remove.removed', { name: entry.name }),
      },
    };
  },
};

const enableSchema = z.object({
  name: z.string().min(1).describe('MCP server name'),
  enabled: z.boolean().describe('Enable or disable'),
  level: z.enum(['session', 'project', 'instance']).describe('Scope to change'),
});

export const synthMcpEnableTool: ToolDefinition = {
  name: 'synth_mcp_enable',
  description:
    'Enable/disable an MCP server at session, project or instance level (write). Session level '
    + 'updates the current session settings and publishes session.updated; project level requires '
    + 'project edit rights and publishes project.updated; instance level requires ADMIN. '
    + 'Returns the effective scope for this session.',
  parameters: enableSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { name: string; enabled: boolean; level: 'session' | 'project' | 'instance' };

    const extra = getExtra(ctx);
    if (!extra.mcpRegistry) return depsError(this.name);
    if (params.level === 'instance' && !extra.mcpManager) return depsError(this.name);

    const viewer = await resolveViewer(ctx, extra);
    const entry = await extra.mcpRegistry.getByName(params.name);
    const { names: effectiveNames } = await effectiveServerNames(extra);
    if (!entry || !isMcpEntryVisible(entry, viewer, effectiveNames)) {
      return notFound(extra, params.name, viewer);
    }

    if (params.level === 'session') {
      const sessionManager = extra.sessionManager;
      const sessionId = ctx.sessionId || extra.sessionId;
      if (!sessionManager || !sessionId) return fail('instance.mcp_enable.no_session');

      let updatedSession: Session | null = null;
      let forbidden = false;
      try {
        await sessionManager.withLock(sessionId, async (session) => {
          // Уровень сессии меняет только владелец сессии (паритет с HTTP
          // `sessionOwnerGuard`: owner/ADMIN) — иначе участник проекта мог бы
          // переключать MCP у чужой сессии.
          if (
            !viewer.elevated
            && session.ownerId !== viewer.userId
            && session.userId !== viewer.userId
          ) {
            forbidden = true;
            return;
          }
          const servers = new Set(session.settings.mcpServers ?? []);
          const disabled = new Set(session.settings.mcpDisabledServers ?? []);
          if (params.enabled) {
            servers.add(entry.name);
            disabled.delete(entry.name);
          } else {
            servers.delete(entry.name);
            disabled.add(entry.name);
          }
          session.settings.mcpServers = [...servers];
          session.settings.mcpDisabledServers = [...disabled];
          session.updatedAt = nowISO();
          updatedSession = session;
          await sessionManager.saveSession(session);
        });
      } catch {
        return fail('instance.mcp_enable.no_session');
      }
      if (forbidden) return fail('instance.mcp_enable.session_forbidden');
      const session = updatedSession as Session | null;
      if (session) {
        extra.eventBus?.publish(session.id, 'session.updated', {
          session_id: session.id,
          settings: session.settings,
          updated_at: session.updatedAt,
        });
      }
      const effective = (await effectiveFor(extra, session ?? undefined))
        .find((item) => item.name === entry.name);
      return {
        content: sm('instance.mcp_enable.session_ok', {
          name: entry.name,
          enabled: String(params.enabled),
        }),
        metadata: {
          name: entry.name,
          level: params.level,
          enabled: params.enabled,
          effective: effectivePayload(effective),
          i18n: i18nMeta('instance.mcp_enable.session_ok', {
            name: entry.name,
            enabled: String(params.enabled),
          }),
        },
      };
    }

    if (params.level === 'project') {
      const sessionManager = extra.sessionManager;
      const projectStore = extra.projectStore;
      const sessionId = ctx.sessionId || extra.sessionId;
      if (!sessionManager || !projectStore || !sessionId) return fail('instance.mcp_enable.no_project');

      let session: Session | null;
      try {
        session = await sessionManager.getSession(sessionId);
      } catch {
        session = null;
      }
      if (!session?.projectId) return fail('instance.mcp_enable.no_project');
      let project: Project | null = null;
      try {
        project = await projectStore.load(session.projectId);
      } catch {
        project = null;
      }
      if (!project) return fail('instance.mcp_enable.no_project');
      if (!canEditProject(session, project)) return fail('instance.mcp.project_forbidden');

      await projectStore.mutate(project.id, (target) => {
        const current = target.mcp ?? { enabled: [], defaultOn: [] };
        const enabled = new Set(current.enabled ?? []);
        const defaultOn = new Set(current.defaultOn ?? []);
        if (params.enabled) {
          enabled.add(entry.name);
          defaultOn.add(entry.name);
        } else {
          enabled.delete(entry.name);
          defaultOn.delete(entry.name);
        }
        target.mcp = { ...current, enabled: [...enabled], defaultOn: [...defaultOn] };
        target.updatedAt = nowISO();
      });

      extra.eventBus?.publish(session.id, 'project.updated', { project_id: project.id });
      const effective = (await effectiveFor(extra)).find((item) => item.name === entry.name);
      return {
        content: sm('instance.mcp_enable.project_ok', {
          name: entry.name,
          enabled: String(params.enabled),
        }),
        metadata: {
          name: entry.name,
          level: params.level,
          enabled: params.enabled,
          effective: effectivePayload(effective),
          i18n: i18nMeta('instance.mcp_enable.project_ok', {
            name: entry.name,
            enabled: String(params.enabled),
          }),
        },
      };
    }

    // instance
    const manager = extra.mcpManager;
    const registry = extra.mcpRegistry;
    if (!manager || !registry) return depsError(this.name);
    if (!isInstanceAdmin(extra)) return fail('instance.mcp.instance_forbidden');

    await registry.update(entry.id, { enabled: params.enabled });
    await syncMcpManagerFromRegistry(manager, registry);
    const effective = (await effectiveFor(extra)).find((item) => item.name === entry.name);
    return {
      content: sm('instance.mcp_enable.instance_ok', {
        name: entry.name,
        enabled: String(params.enabled),
      }),
      metadata: {
        name: entry.name,
        level: params.level,
        enabled: params.enabled,
        effective: effectivePayload(effective),
        i18n: i18nMeta('instance.mcp_enable.instance_ok', {
          name: entry.name,
          enabled: String(params.enabled),
        }),
      },
    };
  },
};

const reconnectSchema = z.object({
  name: z.string().min(1).describe('MCP server name'),
});

export const synthMcpReconnectTool: ToolDefinition = {
  name: 'synth_mcp_reconnect',
  description:
    'Reconnect an MCP server (deregister tools → disconnect → connect → register) without restarting '
    + 'Synth. Use it when the MCP server was restarted and tool calls fail (e.g. "Session not found"). '
    + 'Returns status and tool names; on failure the reason is returned as text.',
  parameters: reconnectSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { name: string };

    const extra = getExtra(ctx);
    const manager = extra.mcpManager;
    if (!manager) return depsError(this.name);

    const viewer = await resolveViewer(ctx, extra);
    const { names: effectiveNames } = await effectiveServerNames(extra);

    // Если запись есть в реестре, она должна быть видима; невидимая чужая
    // user-запись выглядит как отсутствующая (не подключаем и не раскрываем).
    let registryAvailable = '';
    if (extra.mcpRegistry) {
      try {
        const entries = await extra.mcpRegistry.list();
        const entry = entries.find((item) => item.name === params.name);
        registryAvailable = visibleServerNames(entries, viewer, effectiveNames);
        if (entry && !isMcpEntryVisible(entry, viewer, effectiveNames)) {
          return notFound(extra, params.name, viewer);
        }
      } catch {
        // Реестр недоступен — прежний путь менеджера.
      }
    }

    if (!manager.getServerConfig(params.name)) {
      return fail('instance.mcp_not_found', {
        name: params.name,
        available: registryAvailable || '—',
      });
    }

    try {
      if (extra.toolRegistry) {
        await manager.refreshServer(params.name, extra.toolRegistry);
      } else {
        await manager.disconnectServer(params.name);
        await manager.connectServer(params.name);
      }
    } catch (err) {
      return fail('instance.mcp_reconnect.failed', { name: params.name, error: errorText(err) });
    }

    const status = manager.getServerStatus(params.name);
    const connected = status === 'connected';
    const rawTools = manager.getServerTools(params.name) ?? [];
    const names = rawTools.slice(0, MAX_TOOL_NAMES).map((tool) => tool.name);
    const tools = {
      count: rawTools.length,
      ...(names.length > 0 ? { names } : {}),
    };
    const payload = { name: params.name, status, connected, tools };

    if (!connected) {
      const error = manager.getServerError(params.name) ?? status;
      return {
        content: sm('instance.mcp_reconnect.failed', { name: params.name, error }),
        isError: true,
        metadata: {
          ...payload,
          error,
          i18n: i18nMeta('instance.mcp_reconnect.failed', { name: params.name, error }),
        },
      };
    }

    return {
      content: sm('instance.mcp_reconnect.ok', { name: params.name, count: String(tools.count) }),
      metadata: {
        ...payload,
        i18n: i18nMeta('instance.mcp_reconnect.ok', { name: params.name, count: String(tools.count) }),
      },
    };
  },
};
