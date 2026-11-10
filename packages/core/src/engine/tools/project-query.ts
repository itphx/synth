/**
 * Read-инструменты проектов для агента: `list_projects` и `get_project`.
 *
 * Причина: `project_attach` принимал только `projectId`, а списка проектов у
 * агента не было — приходилось просить id у пользователя. Теперь агент сам
 * перечисляет доступные проекты, ищет по имени и узнаёт детали, не выходя в
 * HTTP API.
 *
 * Границы:
 * - видимость — как у HTTP-списка: elevated (ADMIN/LEAD) видит всё, остальные —
 *   свои проекты и проекты участия; чужие не видны;
 * - отдаются компактные сводки без `log`, `invariants`, `plan` и секретов;
 * - пагинация — общий контракт `paginate` (`server/pagination.ts`).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { Project, ToolContext, ToolDefinition } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import { paginate } from '../../server/pagination.js';
import { localEntries, remoteEntries, sortHybridList } from '../../server/routes/hybrid-list.js';
import type { HybridListEntry } from '../../server/routes/hybrid-list.js';
import { isRemoteRef, toLocalId, toRemoteRef } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { isAborted, abortedResult } from './abort.js';
import { canEditProject } from './project-access.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import {
  type PrincipalExtra,
  type ProjectViewer,
  candidateSummary,
  formatProjectCandidates,
  listVisibleProjects,
  projectRoleLabel,
  resolveProjectRef,
  resolveViewer,
} from './project-resolve.js';

/** Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор). */
export interface ProjectQueryExtra extends PrincipalExtra {
  projectStore?: ProjectStoreContract;
  sessionManager?: SessionManager;
  sessionId?: string;
  /** Workstream A1: клиент удалённого backend (гибрид) для read-only merge. */
  getRemoteClient?: () => RemoteBackendClient | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getExtra(ctx: ToolContext): ProjectQueryExtra {
  return (ctx.extra ?? {}) as ProjectQueryExtra;
}

function missingDepsError(toolName: string) {
  return {
    content: sm('project.deps_unavailable', { tool: toolName }),
    isError: true as const,
    metadata: { i18n: i18nMeta('project.deps_unavailable', { tool: toolName }) },
  };
}

function failRemoteUnavailable(ref: string) {
  return {
    content: sm('project.remote_unavailable'),
    isError: true as const,
    metadata: {
      project_id: ref,
      remote_offline: true,
      i18n: i18nMeta('project.remote_unavailable'),
    },
  };
}

function countMembers(project: Project): number {
  const ids = new Set(Object.keys(project.members ?? {}));
  if (project.ownerId) ids.add(project.ownerId);
  return ids.size;
}

/** Компактная сводка проекта для `list_projects` (без log/invariants/plan). */
function projectSummary(project: Project, viewer: ProjectViewer) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    icon: project.icon ?? null,
    color: project.color ?? null,
    owner_id: project.ownerId || null,
    my_role: projectRoleLabel(project, viewer.userId),
    members_count: countMembers(project),
    workspace: project.workspace ?? null,
    current_task: project.currentTask || '',
    repos_count: project.repos?.length ?? 0,
    mcp_enabled_count: project.mcp?.enabled?.length ?? 0,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

/** Детали проекта для `get_project` — без `log` и полного `invariants`. */
function projectDetails(project: Project, viewer: ProjectViewer, sessionsCount: number) {
  const members = Object.entries(project.members ?? {}).map(([id, role]) => ({
    id,
    role: String(role).toUpperCase(),
  }));
  if (project.ownerId && !members.some((member) => member.id === project.ownerId)) {
    members.unshift({ id: project.ownerId, role: 'OWNER' });
  }
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    workspace: project.workspace ?? null,
    owner_id: project.ownerId || null,
    members,
    members_count: countMembers(project),
    current_task: project.currentTask || '',
    repos: (project.repos ?? []).map((repo) => ({
      name: repo.name ?? null,
      path: repo.path,
      url: repo.url ?? null,
      type: repo.type ?? null,
    })),
    repos_count: project.repos?.length ?? 0,
    mcp_enabled: project.mcp?.enabled ?? [],
    mcp_enabled_count: project.mcp?.enabled?.length ?? 0,
    memory_enabled: project.memory?.enabled !== false,
    my_role: projectRoleLabel(project, viewer.userId),
    sessions_count: sessionsCount,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function projectListLine(project: Project, viewer: ProjectViewer): string {
  const role = projectRoleLabel(project, viewer.userId) ?? '—';
  const workspace = project.workspace ? `, workspace: ${project.workspace}` : '';
  return `- ${project.name} (${project.id}, role: ${role}${workspace})`;
}

/** Компактная сводка проекта удалённого мира (DTO уже с `remote:` id). */
function remoteProjectSummary(dto: Record<string, unknown>) {
  const members = dto.members && typeof dto.members === 'object' && !Array.isArray(dto.members)
    ? dto.members as Record<string, unknown>
    : {};
  const memberIds = new Set(Object.keys(members));
  if (typeof dto.owner_id === 'string' && dto.owner_id) memberIds.add(dto.owner_id);
  const repos = Array.isArray(dto.repos) ? dto.repos : [];
  const mcp = dto.mcp && typeof dto.mcp === 'object' && !Array.isArray(dto.mcp)
    ? dto.mcp as Record<string, unknown>
    : {};
  const mcpEnabled = Array.isArray(mcp.enabled) ? mcp.enabled : [];
  return {
    id: String(dto.id ?? ''),
    name: String(dto.name ?? ''),
    description: typeof dto.description === 'string' ? dto.description : '',
    icon: typeof dto.icon === 'string' ? dto.icon : null,
    color: typeof dto.color === 'string' ? dto.color : null,
    owner_id: typeof dto.owner_id === 'string' ? dto.owner_id : null,
    my_role: null,
    members_count: memberIds.size,
    workspace: typeof dto.workspace === 'string' ? dto.workspace : null,
    current_task: typeof dto.current_task === 'string' ? dto.current_task : '',
    repos_count: repos.length,
    mcp_enabled_count: mcpEnabled.length,
    created_at: typeof dto.created_at === 'string' ? dto.created_at : null,
    updated_at: typeof dto.updated_at === 'string' ? dto.updated_at : null,
    origin: 'remote' as const,
    can_attach: false,
    cross_instance: true,
  };
}

/** Безопасная деталь проекта удалённого мира (без `plan`/`log`/`invariants`). */
function remoteProjectDetails(dto: Record<string, unknown>) {
  const members = dto.members && typeof dto.members === 'object' && !Array.isArray(dto.members)
    ? dto.members as Record<string, unknown>
    : {};
  const memberList = Object.entries(members).map(([id, role]) => ({
    id,
    role: String(role).toUpperCase(),
  }));
  if (typeof dto.owner_id === 'string' && dto.owner_id && !memberList.some((member) => member.id === dto.owner_id)) {
    memberList.unshift({ id: dto.owner_id, role: 'OWNER' });
  }
  const repos = Array.isArray(dto.repos)
    ? dto.repos.map((repo) => {
      const item = repo && typeof repo === 'object' ? repo as Record<string, unknown> : {};
      return {
        name: typeof item.name === 'string' ? item.name : null,
        path: typeof item.path === 'string' ? item.path : '',
        url: typeof item.url === 'string' ? item.url : null,
        type: typeof item.type === 'string' ? item.type : null,
      };
    })
    : [];
  const mcp = dto.mcp && typeof dto.mcp === 'object' && !Array.isArray(dto.mcp)
    ? dto.mcp as Record<string, unknown>
    : {};
  const mcpEnabled = Array.isArray(mcp.enabled) ? mcp.enabled.filter((name): name is string => typeof name === 'string') : [];
  const memory = dto.memory && typeof dto.memory === 'object' && !Array.isArray(dto.memory)
    ? dto.memory as Record<string, unknown>
    : undefined;
  return {
    id: toRemoteRef(typeof dto.id === 'string' ? dto.id : ''),
    name: typeof dto.name === 'string' ? dto.name : '',
    description: typeof dto.description === 'string' ? dto.description : '',
    workspace: typeof dto.workspace === 'string' ? dto.workspace : null,
    owner_id: typeof dto.owner_id === 'string' ? dto.owner_id : null,
    members: memberList,
    members_count: memberList.length,
    current_task: typeof dto.current_task === 'string' ? dto.current_task : '',
    repos,
    repos_count: repos.length,
    mcp_enabled: mcpEnabled,
    mcp_enabled_count: mcpEnabled.length,
    memory_enabled: memory?.enabled !== false,
    my_role: null,
    sessions_count: null,
    can_edit: false,
    can_attach: false,
    cross_instance: true,
    origin: 'remote' as const,
    created_at: typeof dto.created_at === 'string' ? dto.created_at : null,
    updated_at: typeof dto.updated_at === 'string' ? dto.updated_at : null,
  };
}

function remoteProjectLine(dto: Record<string, unknown>): string {
  const workspace = typeof dto.workspace === 'string' && dto.workspace ? `, workspace: ${dto.workspace}` : '';
  return `- ${String(dto.name ?? '')} (${String(dto.id ?? '')}, remote${workspace})`;
}

function remoteCandidate(dto: Record<string, unknown>) {
  return {
    origin: 'remote' as const,
    id: toRemoteRef(String(dto.id ?? '')),
    name: String(dto.name ?? ''),
    owner_id: typeof dto.owner_id === 'string' ? dto.owner_id : null,
    workspace: typeof dto.workspace === 'string' ? dto.workspace : null,
  };
}

function remoteDetailsResult(details: ReturnType<typeof remoteProjectDetails>) {
  const json = JSON.stringify(details);
  const text = sm('project.details', { name: details.name, id: details.id, json });
  return {
    content: text,
    metadata: { ...details, i18n: i18nMeta('project.details', { name: details.name, id: details.id, json }) },
  };
}

async function fetchRemoteProjects(
  client: RemoteBackendClient,
): Promise<{ items: Array<Record<string, unknown>>; truncated: boolean } | { offline: true }> {
  try {
    const all = await client.listAllProjects();
    return { items: all.items, truncated: all.truncated };
  } catch (err) {
    if (err instanceof RemoteError) return { offline: true };
    return { offline: true };
  }
}

const listProjectsSchema = z.object({
  query: z.string().optional().describe('Substring to match against project name or description (case-insensitive)'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional()
    .describe(`Page size (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT})`),
  offset: z.number().int().min(0).optional().describe('Offset from the start (default 0)'),
});

export const listProjectsTool: ToolDefinition = {
  name: 'list_projects',
  description:
    'List projects available to the current user (own projects and projects the user is a member of; '
    + 'ADMIN/LEAD see all). Each item is a compact summary: id, name, description, owner, my role, '
    + 'workspace, task, counts. Supports case-insensitive `query` over name/description and '
    + '`limit`/`offset` pagination. Use it to find a project id or name before project_attach.',
  parameters: listProjectsSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { query?: string; limit?: number; offset?: number };

    const extra = getExtra(ctx);
    if (!extra.projectStore) return missingDepsError(this.name);

    const viewer = await resolveViewer(ctx, extra);
    const limit = params.limit ?? DEFAULT_LIMIT;
    const offset = params.offset ?? 0;

    const localProjects = await listVisibleProjects(extra.projectStore, viewer);
    const query = params.query?.trim().toLowerCase();

    let remoteItems: Array<Record<string, unknown>> = [];
    let remoteOffline = false;
    let remoteTruncated = false;
    const client = extra.getRemoteClient?.() ?? null;
    if (client) {
      const remote = await fetchRemoteProjects(client);
      if ('offline' in remote) {
        remoteOffline = true;
      } else {
        remoteItems = remote.items;
        remoteTruncated = remote.truncated;
      }
    }

    const mergedEntries: HybridListEntry<unknown>[] = [
      ...localEntries(localProjects),
      ...remoteEntries(remoteItems),
    ];
    let entries = sortHybridList(mergedEntries);
    if (query) {
      entries = entries.filter((entry) => {
        if (entry.origin === 'local') {
          const project = entry.value as unknown as Project;
          return project.name.toLowerCase().includes(query)
            || (project.description ?? '').toLowerCase().includes(query);
        }
        const dto = entry.value as Record<string, unknown>;
        return String(dto.name ?? '').toLowerCase().includes(query)
          || String(dto.description ?? '').toLowerCase().includes(query);
      });
    }

    const page = paginate(entries, offset, limit);
    const items = page.page.map((entry) => (entry.origin === 'local'
      ? {
          ...projectSummary(entry.value as unknown as Project, viewer),
          origin: 'local' as const,
          can_attach: true,
          cross_instance: false,
        }
      : remoteProjectSummary(entry.value as Record<string, unknown>)));
    const warnings: string[] = [];
    if (remoteOffline) warnings.push('remote_offline');
    if (remoteTruncated) warnings.push('remote_truncated');
    const base = {
      projects: items,
      total: page.total,
      offset,
      limit,
      next_offset: remoteTruncated ? null : page.next_offset,
      ...(remoteOffline ? { remote_offline: true } : {}),
      ...(remoteTruncated ? { remote_truncated: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (items.length === 0) {
      return {
        content: sm('project.list_empty'),
        metadata: { ...base, i18n: i18nMeta('project.list_empty') },
      };
    }

    const itemsText = page.page.map((entry) => (entry.origin === 'local'
      ? projectListLine(entry.value as unknown as Project, viewer)
      : remoteProjectLine(entry.value as Record<string, unknown>))).join('\n');
    const text = sm('project.list', {
      count: String(page.total),
      items: itemsText,
    });
    return {
      content: remoteTruncated ? `${text}\n\n${sm('project.remote_truncated')}` : text,
      metadata: { ...base, i18n: i18nMeta('project.list', { count: String(page.total), items: itemsText }) },
    };
  },
};

const getProjectSchema = z.object({
  project: z.string().min(1).describe('Project id or exact name (case-insensitive)'),
});

export const getProjectTool: ToolDefinition = {
  name: 'get_project',
  description:
    'Get details of a project by id or exact name (case-insensitive): description, workspace, owner, '
    + 'members, current task, repos, MCP scope, memory flag, timestamps, your role and whether you can '
    + 'edit it, plus the number of sessions. Does not include the project log or full invariants. '
    + 'If the name matches more than one project, `ambiguous: true` and `candidates` are returned — '
    + 'retry with the id.',
  parameters: getProjectSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { project: string };

    const extra = getExtra(ctx);
    if (!extra.projectStore || !extra.sessionManager) return missingDepsError(this.name);

    const viewer = await resolveViewer(ctx, extra);
    const ref = params.project.trim();
    const client = extra.getRemoteClient?.() ?? null;

    // Явная ссылка на удалённый мир — деталь только оттуда, без локального резолва.
    if (isRemoteRef(ref)) {
      if (!client) return failRemoteUnavailable(ref);
      try {
        const dto = await client.getProject(toLocalId(ref)) as Record<string, unknown>;
        const id = toRemoteRef(String(dto.id ?? toLocalId(ref)));
        return remoteDetailsResult(remoteProjectDetails({ ...dto, id }));
      } catch (err) {
        if (err instanceof RemoteError) {
          const offline = err.code === 'OFFLINE';
          return {
            content: sm('project.query_not_found', { name: ref }),
            isError: true,
            metadata: {
              found: false,
              ...(offline ? { remote_offline: true } : {}),
              i18n: i18nMeta('project.query_not_found', { name: ref }),
            },
          };
        }
        throw err;
      }
    }

    const resolved = await resolveProjectRef(extra.projectStore, ref, viewer);

    if (resolved.status === 'not_found') {
      let remoteOffline = false;
      if (client) {
        const remote = await fetchRemoteProjects(client);
        if ('offline' in remote) {
          remoteOffline = true;
        } else {
          const needle = ref.toLowerCase();
          const matches = remote.items.filter(
            (item) => String(item.name ?? '').trim().toLowerCase() === needle,
          );
          if (matches.length === 1) {
            return remoteDetailsResult(remoteProjectDetails(matches[0]!));
          }
          if (matches.length > 1) {
            const items = matches.map(remoteProjectLine).join('\n');
            return {
              content: sm('project.query_ambiguous', { name: ref, items }),
              isError: true,
              metadata: {
                ambiguous: true,
                candidates: matches.map(remoteCandidate),
                i18n: i18nMeta('project.query_ambiguous', { name: ref, items }),
              },
            };
          }
        }
      }
      return {
        content: sm('project.query_not_found', { name: ref }),
        isError: true,
        metadata: {
          found: false,
          ...(remoteOffline ? { remote_offline: true } : {}),
          i18n: i18nMeta('project.query_not_found', { name: ref }),
        },
      };
    }
    if (resolved.status === 'ambiguous') {
      const items = formatProjectCandidates(resolved.candidates);
      return {
        content: sm('project.query_ambiguous', { name: ref, items }),
        isError: true,
        metadata: {
          ambiguous: true,
          candidates: resolved.candidates.map(candidateSummary),
          i18n: i18nMeta('project.query_ambiguous', { name: ref, items }),
        },
      };
    }

    const project = resolved.project;
    const sessionId = ctx.sessionId || extra.sessionId;
    const session = sessionId ? await extra.sessionManager.getSession(sessionId) : null;

    let sessionsCount = 0;
    try {
      const sessions = await extra.sessionManager.listSessions({ projectId: project.id });
      sessionsCount = sessions.length;
    } catch {
      sessionsCount = 0;
    }

    const details = {
      ...projectDetails(project, viewer, sessionsCount),
      origin: 'local' as const,
      can_attach: true,
      cross_instance: false,
      can_edit: canEditProject(session, project),
    };
    const json = JSON.stringify(details);
    const text = sm('project.details', { name: project.name, id: project.id, json });
    return {
      content: text,
      metadata: { ...details, i18n: i18nMeta('project.details', { name: project.name, id: project.id, json }) },
    };
  },
};
