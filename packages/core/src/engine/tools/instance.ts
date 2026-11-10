/**
 * Workstream A1: read-only тулы инстанса и MCP-реестра.
 *
 * Цель — агент из чата видит, что за инстанс (версия/режим/dataDir/auth/
 * storage/счётчики) и какие MCP-серверы есть, их статус, эффективный scope
 * сессии/проекта, причину неактивности и сетевую политику. Это закрывает боль
 * «найди порт/ключ/реестр» и диагностику «Session not found».
 *
 * Границы:
 * - только чтение: `synth_info`, `synth_mcp_list`, `synth_mcp_test`;
 * - секреты не читаются и не возвращаются: у auth только булевы признаки, у
 *   MCP — `url`/`command` без `headers`/`env`;
 * - `synth_mcp_test` создаёт **временное** подключение (`probeServer`), ничего
 *   не регистрируя; ошибка времени/сети возвращается текстом.
 */
import { z } from 'zod';
import { SYNTH_VERSION, ToolCapability } from '@itphx/synth-shared';
import type {
  McpNetworkPolicy,
  McpRegistryEntry,
  McpServerEffective,
  Project,
  Session,
  ToolContext,
  ToolDefinition,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { McpManager } from '../mcp/manager.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { EventBus } from '../../events/bus.js';
import type { ToolRegistry } from './registry.js';
import { evaluateMcpNetworkAccess } from '../mcp/network-policy.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import {
  type PrincipalExtra,
  listVisibleProjects,
  resolveViewer,
} from './project-resolve.js';
import { listVisibleSessions } from './session-manage.js';

/** Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор). */
export interface InstanceToolsExtra extends PrincipalExtra {
  instanceMeta?: InstanceRuntimeMeta;
  projectStore?: ProjectStoreContract;
  sessionManager?: SessionManager;
  sessionId?: string;
  workspacesRoot?: string;
  listModels?: () => Promise<unknown[]>;
  agentRegistry?: AgentRegistry;
  mcpRegistry?: McpRegistryRepository;
  mcpManager?: McpManager;
  resolveMcpServers?: () => Promise<McpServerEffective[]>;
  /** Резолв эффективного MCP-скоупа для **произвольной** сессии (write-тулы). */
  resolveMcpServersFor?: (session: Session) => Promise<McpServerEffective[]>;
  /** События сессии/проекта (write-тулы MCP). */
  eventBus?: EventBus;
  /** Реестр тулов — нужен `synth_mcp_reconnect` (`refreshServer`). */
  toolRegistry?: ToolRegistry;
  getMcpNetworkPolicy?: () => Promise<McpNetworkPolicy | undefined>;
}

/** Предел числа имён инструментов/серверов в ответе (краткость для модели). */
const MAX_TOOL_NAMES = 50;
const MAX_SERVER_NAMES = 20;

function getExtra(ctx: ToolContext): InstanceToolsExtra {
  return (ctx.extra ?? {}) as InstanceToolsExtra;
}

function depsError(toolName: string) {
  return {
    content: sm('instance.deps_unavailable', { tool: toolName }),
    isError: true as const,
    metadata: { i18n: i18nMeta('instance.deps_unavailable', { tool: toolName }) },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Убирает из URL учётные данные и значения секретных query-параметров.
 *
 * MCP-серверы — пользовательский ввод: `https://user:pass@host/mcp?token=...`
 * не должен попадать в контекст модели. Невалидный URL — regex-фоллбек для
 * `//user:pass@`.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    for (const name of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|auth/i.test(name)) {
        url.searchParams.set(name, '***');
      }
    }
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^/@]+@/g, '//***@');
  }
}

/**
 * Видимость записи MCP-реестра для пользователя (паритет с UI
 * `McpSettings.tsx`): elevated видит всё; instance-записи — общие; чужая
 * user-запись видна, только если реально включена в эффективном наборе
 * сессии/проекта (иначе агент USER узнавал бы о чужих серверах).
 */
export function isMcpEntryVisible(
  entry: McpRegistryEntry,
  viewer: { userId: string; elevated: boolean },
  effectiveNames: ReadonlySet<string>,
): boolean {
  if (viewer.elevated) return true;
  if (entry.origin === 'instance') return true;
  if (entry.author?.userId === viewer.userId) return true;
  return effectiveNames.has(entry.name);
}

/** Имена видимых серверов (для текста «не настроен/не найден»). */
export function visibleServerNames(
  entries: McpRegistryEntry[],
  viewer: { userId: string; elevated: boolean },
  effectiveNames: ReadonlySet<string>,
): string {
  return entries
    .filter((entry) => isMcpEntryVisible(entry, viewer, effectiveNames))
    .slice(0, MAX_SERVER_NAMES)
    .map((entry) => entry.name)
    .join(', ');
}

/** Эффективный набор имён (ошибка резолвера не раскрывает серверы). */
export async function effectiveServerNames(
  extra: InstanceToolsExtra,
): Promise<{ names: Set<string>; list: McpServerEffective[] }> {
  if (!extra.resolveMcpServers) return { names: new Set(), list: [] };
  try {
    const list = await extra.resolveMcpServers();
    // Только реально включённые серверы: `enabled:false` в effective означает
    // «недоступен в сессии», и чужая user-запись не должна становиться видимой.
    return {
      names: new Set(list.filter((item) => item.enabled === true).map((item) => item.name)),
      list,
    };
  } catch {
    return { names: new Set(), list: [] };
  }
}

/** Счётчик с изоляцией ошибки: `null` + код предупреждения. */
async function countOrNull(
  loader: () => Promise<number>,
  warnings: string[],
  warning: string,
): Promise<number | null> {
  try {
    return await loader();
  } catch {
    warnings.push(warning);
    return null;
  }
}

export const synthInfoTool: ToolDefinition = {
  name: 'synth_info',
  description:
    'Describe the current Synth instance (read-only): version, mode (standalone/managed/hybrid), '
    + 'data dir, working dir, workspaces root, server address, auth flags (no secret values), '
    + 'storage backend/degraded state, feature flags, and counts (MCP servers/connected, projects, '
    + 'sessions, models, agents). Use it to diagnose the instance before asking the user for ports, '
    + 'keys or registry details. Counter read failures do not fail the tool: the field is null and '
    + 'a warning code is returned.',
  parameters: z.object({}),
  capabilities: [ToolCapability.INSTANCE],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getExtra(ctx);
    const warnings: string[] = [];
    const meta = extra.instanceMeta;
    const viewer = await resolveViewer(ctx, extra);

    const mcpRegistry = extra.mcpRegistry;
    const mcpManager = extra.mcpManager;

    let registryEntries: Awaited<ReturnType<McpRegistryRepository['list']>> | null = null;
    if (mcpRegistry) {
      try {
        registryEntries = await mcpRegistry.list();
      } catch {
        warnings.push('mcp_registry_unavailable');
      }
    } else {
      warnings.push('mcp_registry_unavailable');
    }

    const mcpServers = registryEntries ? registryEntries.length : null;
    const mcpConnected = mcpManager
      ? (registryEntries ?? []).filter((entry) => mcpManager.getServerStatus(entry.name) === 'connected').length
      : null;
    if (!mcpManager) warnings.push('mcp_manager_unavailable');

    const projects = await countOrNull(
      async () => (extra.projectStore
        ? (await listVisibleProjects(extra.projectStore, viewer)).length
        : Promise.reject(new Error('no project store'))),
      warnings,
      'projects_unavailable',
    );
    const sessions = await countOrNull(
      async () => (extra.sessionManager
        ? (await listVisibleSessions(extra, viewer)).length
        : Promise.reject(new Error('no session manager'))),
      warnings,
      'sessions_unavailable',
    );
    const models = await countOrNull(
      async () => {
        if (!extra.listModels) throw new Error('no model loader');
        return (await extra.listModels()).length;
      },
      warnings,
      'models_unavailable',
    );
    let agents: number | null;
    try {
      agents = extra.agentRegistry ? extra.agentRegistry.list().length : null;
    } catch {
      agents = null;
      warnings.push('agents_unavailable');
    }

    const info = {
      version: SYNTH_VERSION,
      mode: meta?.mode ?? null,
      data_dir: ctx.dataDir ?? null,
      working_dir: ctx.workingDir ?? null,
      workspaces_root: extra.workspacesRoot ?? null,
      server: meta?.server ?? null,
      auth: meta?.auth ?? null,
      storage: meta?.storage ?? null,
      features: meta?.features ?? null,
      counts: {
        mcp_servers: mcpServers,
        mcp_connected: mcpConnected,
        projects,
        sessions,
        models,
        agents,
      },
      warnings,
    };
    const json = JSON.stringify(info);
    return {
      content: sm('instance.info', { json }),
      metadata: { ...info, i18n: i18nMeta('instance.info', { json }) },
    };
  },
};

interface McpServerListEntry {
  name: string;
  type: string;
  description: string | null;
  origin: string;
  trust: string;
  enabled: boolean;
  enabled_by_default: boolean;
  status: string;
  connected: boolean;
  error?: string;
  url?: string;
  command?: string;
  tools: { count: number; names?: string[] };
  effective: { enabled: boolean; level: string; reason?: string } | null;
  policy: { allowed: boolean; reason?: string; matchedRule?: string } | null;
}

export const synthMcpListTool: ToolDefinition = {
  name: 'synth_mcp_list',
  description:
    'List MCP servers from the instance registry (read-only) with connection status, effective '
    + 'session/project scope, disabled reason, tool names and network policy decision. Also returns '
    + 'the effective MCP network policy and the current project/session MCP scope. Headers and env '
    + 'values are never returned.',
  parameters: z.object({}),
  capabilities: [ToolCapability.INSTANCE],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getExtra(ctx);
    const manager = extra.mcpManager;
    const registry = extra.mcpRegistry;
    if (!manager || !registry) return depsError(this.name);

    let entries: Awaited<ReturnType<McpRegistryRepository['list']>>;
    try {
      entries = await registry.list();
    } catch (err) {
      return {
        content: sm('instance.deps_unavailable', { tool: this.name }),
        isError: true,
        metadata: { error: errorText(err), i18n: i18nMeta('instance.deps_unavailable', { tool: this.name }) },
      };
    }

    const viewer = await resolveViewer(ctx, extra);
    const { names: effectiveNames, list: effective } = await effectiveServerNames(extra);

    let networkPolicy: McpNetworkPolicy | undefined;
    if (extra.getMcpNetworkPolicy) {
      try {
        networkPolicy = await extra.getMcpNetworkPolicy();
      } catch {
        networkPolicy = undefined;
      }
    }

    const servers: McpServerListEntry[] = [];
    for (const entry of entries) {
      // Видимость — как в UI (`McpSettings.tsx`): чужая user-запись не
      // раскрывается, кроме случая, когда она реально включена в сессии/проекте.
      if (!isMcpEntryVisible(entry, viewer, effectiveNames)) continue;
      const config = entry.config;
      const decision = effective.find((item) => item.name === entry.name) ?? null;
      const status = decision && !decision.enabled
        ? 'disabled'
        : manager.getServerStatus(entry.name);
      const rawTools = manager.getServerTools(entry.name);
      const toolNames = (rawTools ?? []).slice(0, MAX_TOOL_NAMES).map((tool) => tool.name);

      let policy: McpServerListEntry['policy'] = null;
      if (
        entry.origin === 'user'
        && (config.type === 'http' || config.type === 'sse')
        && config.url
      ) {
        try {
          const result = await evaluateMcpNetworkAccess(config.url, networkPolicy);
          policy = {
            allowed: result.allowed,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.matchedRule ? { matchedRule: result.matchedRule } : {}),
          };
        } catch (err) {
          policy = { allowed: false, reason: errorText(err) };
        }
      }

      const error = decision?.error ?? manager.getServerError(entry.name);
      servers.push({
        name: entry.name,
        type: config.type,
        description: config.description ?? null,
        origin: entry.origin,
        trust: entry.trust,
        enabled: entry.enabled,
        enabled_by_default: entry.enabledByDefault,
        status,
        connected: status === 'connected',
        ...(error ? { error } : {}),
        ...(config.url ? { url: redactUrl(config.url) } : {}),
        ...(config.command ? { command: config.command } : {}),
        tools: {
          count: rawTools?.length ?? 0,
          ...(toolNames.length > 0 ? { names: toolNames } : {}),
        },
        effective: decision
          ? {
              enabled: decision.enabled,
              level: decision.level,
              ...(decision.reason ? { reason: decision.reason } : {}),
            }
          : null,
        policy,
      });
    }

    const sessionId = ctx.sessionId || extra.sessionId;
    let session: Session | null = null;
    if (sessionId && extra.sessionManager) {
      try {
        session = await extra.sessionManager.getSession(sessionId);
      } catch {
        session = null;
      }
    }

    let project: { id: string; name: string; mcp: { enabled: string[]; defaultOn: string[] } } | null = null;
    if (session?.projectId && extra.projectStore) {
      try {
        const loaded: Project | null = await extra.projectStore.load(session.projectId);
        if (loaded) {
          project = {
            id: loaded.id,
            name: loaded.name,
            mcp: {
              enabled: loaded.mcp?.enabled ?? [],
              defaultOn: loaded.mcp?.defaultOn ?? [],
            },
          };
        }
      } catch {
        project = null;
      }
    }

    const payload = {
      policy: networkPolicy ?? null,
      servers,
      project,
      session: session
        ? {
            id: session.id,
            mcpServers: session.mcpServers ?? [],
            mcpDisabledServers: session.settings.mcpDisabledServers ?? [],
            mcpDefaultOn: session.settings.mcpDefaultOn ?? [],
          }
        : null,
    };

    const json = JSON.stringify(payload);
    const count = servers.length;
    const text = sm('instance.mcp_list', { count: String(count), json });
    return {
      content: text,
      metadata: { ...payload, i18n: i18nMeta('instance.mcp_list', { count: String(count), json }) },
    };
  },
};

const synthMcpTestSchema = z.object({
  name: z.string().min(1).describe('MCP server name from synth_mcp_list'),
});

export const synthMcpTestTool: ToolDefinition = {
  name: 'synth_mcp_test',
  description:
    'Check an MCP server by name (read-only): opens a temporary connection (does not register the '
    + 'server), returns ok, tool list (up to 50) and an error text on failure/timeout. If the server '
    + 'is not configured, lists available names from the registry.',
  parameters: synthMcpTestSchema,
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

    // При наличии реестра видимость проверяется по тому же правилу, что в
    // `synth_mcp_list`: невидимая/чужая user-запись выглядит как отсутствующая
    // (не раскрываем существование и не пробуем её подключить).
    if (extra.mcpRegistry) {
      try {
        const entries = await extra.mcpRegistry.list();
        const entry = entries.find((item) => item.name === params.name);
        // Запись есть, но невидима — выглядит как отсутствующая. Записи нет в
        // реестре (executor/серверный runtime-сервер) — прежний путь менеджера.
        if (entry && !isMcpEntryVisible(entry, viewer, effectiveNames)) {
          const available = visibleServerNames(entries, viewer, effectiveNames);
          return {
            content: sm('instance.mcp_not_found', {
              name: params.name,
              available: available || '—',
            }),
            isError: true,
            metadata: {
              ok: false,
              name: params.name,
              i18n: i18nMeta('instance.mcp_not_found', { name: params.name, available: available || '—' }),
            },
          };
        }
      } catch {
        // Реестр недоступен — не раскрываем ошибку, идём прежним путём менеджера.
      }
    }

    if (!manager.getServerConfig(params.name)) {
      let available = '';
      if (extra.mcpRegistry) {
        try {
          const entries = await extra.mcpRegistry.list();
          available = visibleServerNames(entries, viewer, effectiveNames);
        } catch {
          available = '';
        }
      }
      return {
        content: sm('instance.mcp_not_found', {
          name: params.name,
          available: available || '—',
        }),
        isError: true,
        metadata: {
          ok: false,
          name: params.name,
          i18n: i18nMeta('instance.mcp_not_found', { name: params.name, available: available || '—' }),
        },
      };
    }

    try {
      const tools = (await manager.probeServer(params.name))
        .slice(0, MAX_TOOL_NAMES)
        .map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        }));
      return {
        content: sm('instance.mcp_test_ok', { name: params.name, count: String(tools.length) }),
        metadata: {
          ok: true,
          name: params.name,
          tools,
          i18n: i18nMeta('instance.mcp_test_ok', { name: params.name, count: String(tools.length) }),
        },
      };
    } catch (err) {
      const error = errorText(err);
      return {
        content: sm('instance.mcp_test_failed', { name: params.name, error }),
        isError: true,
        metadata: {
          ok: false,
          name: params.name,
          error,
          i18n: i18nMeta('instance.mcp_test_failed', { name: params.name, error }),
        },
      };
    }
  },
};
