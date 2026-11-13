/**
 * Инструменты сессий для агента: `list_sessions`, `get_session_info`,
 * `session_rename`.
 *
 * Причина: агент не мог ни перечислить сессии, ни узнать, в каком проекте они
 * живут, ни переименовать текущую сессию без HTTP API. Здесь — те же правила
 * видимости, что у `GET /api/v2/sessions`: elevated (ADMIN/LEAD) видят всё,
 * остальные — свои сессии и сессии проектов участия. История сообщений **не**
 * тянется: только лёгкие метаданные (`SessionManager.listSessions`).
 */
import { z } from 'zod';
import { nowISO, ToolCapability } from '@itphx/synth-shared';
import type { Project, Session, ToolContext, ToolDefinition } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { EventBus } from '../../events/bus.js';
import { paginate } from '../../server/pagination.js';
import { localEntries, remoteEntries, sortHybridList } from '../../server/routes/hybrid-list.js';
import type { HybridListEntry } from '../../server/routes/hybrid-list.js';
import { isRemoteRef, toLocalId } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import type { ExecutionRouter } from '../../execution/router.js';
import type { PoolInfo } from '../../execution/pool-provider.js';
import {
  type PrincipalExtra,
  type ProjectViewer,
  candidateSummary,
  formatProjectCandidates,
  listVisibleProjects,
  resolveProjectRef,
  resolveViewer,
} from './project-resolve.js';

/** Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор). */
export interface SessionManageExtra extends PrincipalExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreContract;
  eventBus?: EventBus;
  sessionId?: string;
  /** Workstream A1: клиент удалённого backend (гибрид) для read-only merge. */
  getRemoteClient?: () => RemoteBackendClient | null;
  /**
   * Роутер портов исполнения (PROP-135) — источник каталога профилей и
   * состояния пулов для сводки `get_session_info`.
   *
   * Не задан — исполнение в процессе (`inline`): профилей и пулов нет.
   */
  executionRouter?: ExecutionRouter;
  /** Эффективный профиль исполнения сессии (exec-контур). */
  executionProfile?: string | null;
  /** Эффективный браузерный профиль сессии (браузерный контур). */
  executionBrowserProfile?: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function getExtra(ctx: ToolContext): SessionManageExtra {
  return (ctx.extra ?? {}) as SessionManageExtra;
}

function missingDepsError(toolName: string) {
  return {
    content: sm('project.deps_unavailable', { tool: toolName }),
    isError: true as const,
    metadata: { i18n: i18nMeta('project.deps_unavailable', { tool: toolName }) },
  };
}

function pendingCount(session: Session): number {
  return session.pendingMessages?.length ?? 0;
}

function openTodos(session: Session): number {
  return (session.todos ?? []).filter(
    (todo) => todo.status !== 'completed' && todo.status !== 'cancelled',
  ).length;
}

/** Компактный статус сессии (без текста сообщений). */
function sessionStatusInfo(session: Session) {
  return {
    blocked: session.status.blocked ?? null,
    cancel_requested: Boolean(session.status.cancelRequested),
    queue_stopped: Boolean(session.status.queueStopped),
  };
}

/** Компактная активность хода: id стрима/хода и ретрай, без текста. */
function sessionActivityInfo(session: Session) {
  return {
    streaming: Boolean(session.currentStream),
    stream_id: session.currentStream?.streamId ?? null,
    turn_id: session.currentStream?.turnId ?? null,
    retry: session.retry
      ? {
          attempt: session.retry.attempt,
          max_retries: session.retry.maxRetries,
          retry_at: session.retry.retryAt,
        }
      : null,
  };
}

/**
 * Сессии, видимые пользователю: elevated — все; иначе свои + сессии проектов
 * участия (паритет с `GET /api/v2/sessions`, ADR-089).
 */
export async function listVisibleSessions(
  extra: SessionManageExtra,
  viewer: ProjectViewer,
): Promise<Session[]> {
  if (!extra.sessionManager) return [];
  if (viewer.elevated) return extra.sessionManager.listSessions();
  const projects = extra.projectStore
    ? await listVisibleProjects(extra.projectStore, viewer)
    : [];
  const projectIds = projects.map((project) => project.id);
  if (projectIds.length === 0) {
    return extra.sessionManager.listSessions({ userId: viewer.userId });
  }
  return extra.sessionManager.listSessions({ userId: viewer.userId, projectIds });
}

/** Карта id → имя видимого проекта (для `project_name`). */
async function visibleProjectNames(
  extra: SessionManageExtra,
  viewer: ProjectViewer,
): Promise<Map<string, string>> {
  if (!extra.projectStore) return new Map();
  const projects = await listVisibleProjects(extra.projectStore, viewer);
  return new Map(projects.map((project) => [project.id, project.name]));
}

function sessionSummary(
  session: Session,
  projectNames: Map<string, string>,
  currentSessionId: string,
) {
  return {
    id: session.id,
    title: session.title || null,
    project_id: session.projectId ?? null,
    project_name: session.projectId ? projectNames.get(session.projectId) ?? null : null,
    owner_id: session.ownerId || session.userId || null,
    agent_role: session.settings.agentRole ?? null,
    provider: session.settings.provider ?? null,
    model: session.settings.model ?? null,
    status: sessionStatusInfo(session),
    activity: sessionActivityInfo(session),
    pending_count: pendingCount(session),
    todos_open: openTodos(session),
    is_current: session.id === currentSessionId,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    origin: 'local' as const,
    cross_instance: false,
  };
}

function sessionListLine(summary: ReturnType<typeof sessionSummary>): string {
  const parts = [`- ${summary.title ?? summary.id} (${summary.id})`];
  if (summary.project_name) parts.push(`project: ${summary.project_name}`);
  if (summary.is_current) parts.push('current');
  return parts.join(', ');
}

/** Компактная сводка сессии удалённого мира (DTO уже с `remote:` id). */
function remoteSessionSummary(dto: Record<string, unknown>) {
  const settings = dto.settings && typeof dto.settings === 'object' && !Array.isArray(dto.settings)
    ? dto.settings as Record<string, unknown>
    : {};
  const status = dto.status && typeof dto.status === 'object' && !Array.isArray(dto.status)
    ? dto.status as Record<string, unknown>
    : {};
  const activity = dto.activity && typeof dto.activity === 'object' && !Array.isArray(dto.activity)
    ? dto.activity as Record<string, unknown>
    : {};
  const todos = Array.isArray(dto.todos) ? dto.todos : [];
  const todosOpen = todos.filter((todo) => {
    const item = todo && typeof todo === 'object' ? todo as Record<string, unknown> : {};
    return item.status !== 'completed' && item.status !== 'cancelled';
  }).length;
  const pending = typeof dto.pending_count === 'number' && Number.isFinite(dto.pending_count)
    ? dto.pending_count
    : 0;
  const activityType = typeof activity.type === 'string' ? activity.type : 'idle';
  return {
    id: String(dto.id ?? ''),
    title: typeof dto.name === 'string' ? dto.name : (typeof dto.title === 'string' ? dto.title : null),
    project_id: typeof dto.project_id === 'string' ? dto.project_id : null,
    project_name: null,
    owner_id: typeof dto.owner_id === 'string' ? dto.owner_id : null,
    agent_role: typeof settings.agentRole === 'string' ? settings.agentRole : null,
    provider: typeof settings.provider === 'string' ? settings.provider : null,
    model: typeof settings.model === 'string' ? settings.model : null,
    status: {
      blocked: typeof status.blocked === 'string' ? status.blocked : null,
      cancel_requested: status.cancel_requested === true,
      queue_stopped: status.queue_stopped === true,
    },
    activity: {
      streaming: activityType === 'busy',
      stream_id: typeof activity.streamId === 'string' ? activity.streamId : null,
      turn_id: typeof activity.turnId === 'string' ? activity.turnId : null,
      retry: activityType === 'retry'
        ? {
            attempt: typeof activity.attempt === 'number' ? activity.attempt : null,
            max_retries: typeof activity.maxRetries === 'number' ? activity.maxRetries : null,
            retry_at: typeof activity.retryAt === 'string' ? activity.retryAt : null,
          }
        : null,
    },
    pending_count: pending,
    todos_open: todosOpen,
    is_current: false,
    created_at: typeof dto.created_at === 'string' ? dto.created_at : null,
    updated_at: typeof dto.updated_at === 'string' ? dto.updated_at : null,
    origin: 'remote' as const,
    cross_instance: true,
  };
}

function remoteSessionLine(summary: ReturnType<typeof remoteSessionSummary>): string {
  const parts = [`- ${summary.title ?? summary.id} (${summary.id}, remote)`];
  if (summary.project_id) parts.push(`project: ${summary.project_id}`);
  return parts.join(', ');
}

const listSessionsSchema = z.object({
  project: z.string().optional().describe('Project id or exact name (case-insensitive) to filter by'),
  query: z.string().optional().describe('Case-insensitive substring of the session title'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional()
    .describe(`Page size (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT})`),
  offset: z.number().int().min(0).optional().describe('Offset from the start (default 0)'),
});

export const listSessionsTool: ToolDefinition = {
  name: 'list_sessions',
  description:
    'List sessions available to the current user (own sessions and sessions of projects the user is a '
    + 'member of; ADMIN/LEAD see all). Each item is a compact summary: id, title, project, owner, agent, '
    + 'provider/model, status/activity, pending count, open todos, whether it is the current session. '
    + 'No message history is returned. Optional `project` (id or exact name) and `query` (title '
    + 'substring) filters, `limit`/`offset` pagination.',
  parameters: listSessionsSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { project?: string; query?: string; limit?: number; offset?: number };

    const extra = getExtra(ctx);
    if (!extra.sessionManager) return missingDepsError(this.name);

    const viewer = await resolveViewer(ctx, extra);
    const limit = params.limit ?? DEFAULT_LIMIT;
    const offset = params.offset ?? 0;
    const client = extra.getRemoteClient?.() ?? null;

    let projectFilter: string | undefined;
    let remoteProjectFilter: string | undefined;
    if (params.project) {
      if (isRemoteRef(params.project)) {
        if (!client) {
          return {
            content: sm('project.remote_unavailable'),
            isError: true,
            metadata: {
              project_id: params.project,
              remote_offline: true,
              i18n: i18nMeta('project.remote_unavailable'),
            },
          };
        }
        remoteProjectFilter = toLocalId(params.project);
        projectFilter = params.project;
      } else {
        if (!extra.projectStore) return missingDepsError(this.name);
        const resolved = await resolveProjectRef(extra.projectStore, params.project, viewer);
        if (resolved.status === 'not_found') {
          return {
            content: sm('project.query_not_found', { name: params.project }),
            isError: true,
            metadata: { found: false, i18n: i18nMeta('project.query_not_found', { name: params.project }) },
          };
        }
        if (resolved.status === 'ambiguous') {
          const items = formatProjectCandidates(resolved.candidates);
          return {
            content: sm('project.query_ambiguous', { name: params.project, items }),
            isError: true,
            metadata: {
              ambiguous: true,
              candidates: resolved.candidates.map(candidateSummary),
              i18n: i18nMeta('project.query_ambiguous', { name: params.project, items }),
            },
          };
        }
        projectFilter = resolved.project.id;
      }
    }

    let localSessions: Session[] = [];
    if (remoteProjectFilter === undefined) {
      localSessions = await listVisibleSessions(extra, viewer);
      if (projectFilter) {
        localSessions = localSessions.filter((session) => session.projectId === projectFilter);
      }
    }

    let remoteItems: Array<Record<string, unknown>> = [];
    let remoteOffline = false;
    let remoteTruncated = false;
    // С remote-проектом или без фильтра — тянем удалённый мир. При локальном
    // проекте remote-сессии не смешиваем (они принадлежат backend-проектам).
    if (client && (remoteProjectFilter !== undefined || !projectFilter)) {
      try {
        const all = await client.listAllSessions(remoteProjectFilter);
        remoteItems = all.items;
        remoteTruncated = all.truncated;
      } catch (err) {
        if (err instanceof RemoteError) remoteOffline = true;
        else remoteOffline = true;
      }
    }

    const mergedEntries: HybridListEntry<unknown>[] = [
      ...localEntries(localSessions),
      ...remoteEntries(remoteItems),
    ];
    let entries = sortHybridList(mergedEntries);
    const query = params.query?.trim().toLowerCase();
    if (query) {
      entries = entries.filter((entry) => {
        if (entry.origin === 'local') {
          return ((entry.value as unknown as Session).title ?? '').toLowerCase().includes(query);
        }
        const dto = entry.value as Record<string, unknown>;
        const title = typeof dto.name === 'string' ? dto.name : (typeof dto.title === 'string' ? dto.title : '');
        return title.toLowerCase().includes(query);
      });
    }

    const projectNames = await visibleProjectNames(extra, viewer);
    const currentSessionId = ctx.sessionId || extra.sessionId || '';
    const page = paginate(entries, offset, limit);
    const items = page.page.map((entry) => (entry.origin === 'local'
      ? sessionSummary(entry.value as unknown as Session, projectNames, currentSessionId)
      : remoteSessionSummary(entry.value as Record<string, unknown>)));
    const warnings: string[] = [];
    if (remoteOffline) warnings.push('remote_offline');
    if (remoteTruncated) warnings.push('remote_truncated');
    const base = {
      sessions: items,
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
        content: sm('session.list_empty'),
        metadata: { ...base, i18n: i18nMeta('session.list_empty') },
      };
    }

    const itemsText = page.page.map((entry) => (entry.origin === 'local'
      ? sessionListLine(entry.value as ReturnType<typeof sessionSummary>)
      : remoteSessionLine(entry.value as ReturnType<typeof remoteSessionSummary>))).join('\n');
    const text = sm('session.list', { count: String(page.total), items: itemsText });
    return {
      content: remoteTruncated ? `${text}\n\n${sm('session.remote_truncated')}` : text,
      metadata: { ...base, i18n: i18nMeta('session.list', { count: String(page.total), items: itemsText }) },
    };
  },
};

/** Класс профиля исполнения в сводке `get_session_info`. */
export type SessionExecutionProfileClass = 'exec' | 'browser' | 'both';

/**
 * Профиль исполнения в сводке `get_session_info`.
 *
 * Только имена/класс/состояние: адреса и токены пулов наружу не отдаются
 * (инвариант 13 — секреты доступа к исполнителю).
 */
export interface SessionExecutionProfile {
  /** Имя профиля. */
  name: string;
  /** Класс профиля: обычные команды / браузер / оба. */
  class: SessionExecutionProfileClass;
  /** Профиль по умолчанию exec-контура (`execution.remote.defaultProfile`). */
  default: boolean;
  /** Профиль по умолчанию браузерного контура (`execution.remote.browserProfile`). */
  browser_default: boolean;
  /**
   * Пул профиля в текущей области запущен: `true` — `ready`, `false` —
   * `draining`, `null` — пул не поднят/состояние неизвестно.
   */
  running: boolean | null;
  /**
   * Состояние пула профиля в текущей области: `ready` (поднят), `draining`
   * (снимается), `configured` (профиль задан, но пул не поднят — либо список
   * пулов недоступен), `null` — состояние неизвестно (резерв).
   */
  state: 'ready' | 'configured' | 'draining' | null;
}

/** Сведения об исполнении сессии (ADR-135/PROP-135) — без секретов. */
export interface SessionExecutionInfo {
  /** Режим исполнения инстанса: `inline` — в процессе, `remote` — на исполнителе. */
  mode: 'inline' | 'remote';
  /** Режим пула; `null` — в режиме `inline` (пулов нет). */
  pooling: 'instance' | 'project' | 'session' | null;
  /** Эффективные профили сессии: exec-контур и браузерный контур. */
  session_profile: { name: string | null; browser: string | null };
  /** Каталог профилей инстанса (не более 30 записей). */
  profiles: SessionExecutionProfile[];
  /**
   * Причина, по которой состояние пулов неизвестно (провайдер пулов
   * недоступен или не умеет перечислять пулы). Короткий код без секретов.
   */
  pools_error?: string;
  /** Каталог профилей обрезан (лимит 30 записей). */
  truncated?: boolean;
}

/** Предел числа профилей в сводке `get_session_info`. */
const MAX_EXECUTION_PROFILES = 30;

/**
 * Топология исполнения инстанса — из роутера (источник истины).
 *
 * Роутер без `mode()`/`pooling()` (тестовая заглушка) — режим выводится по
 * наличию каталога профилей/провайдера пулов; без них — `inline`.
 */
function resolveExecutionTopology(router: ExecutionRouter | undefined): {
  mode: 'inline' | 'remote';
  pooling: 'instance' | 'project' | 'session' | null;
} {
  if (!router) return { mode: 'inline', pooling: null };
  const mode = router.mode?.();
  if (mode) {
    // В режиме `inline` пулов нет — режим пула не показываем.
    return { mode, pooling: mode === 'inline' ? null : router.pooling?.() ?? null };
  }
  const remote = Boolean(router.profiles?.().length || router.profilesInfo || router.poolProvider);
  return { mode: remote ? 'remote' : 'inline', pooling: remote ? 'instance' : null };
}

/** Уникальные имена профилей (exec-каталог + браузерный, без повторов). */
function uniqueProfileNames(...lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const name = (raw ?? '').trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Префикс ключа пула **текущей области** (`poolKeyString`).
 *
 * `null` — область не адресуема (пул на проект, а у сессии проекта нет):
 * чужие пулы в сводку не попадают (изоляция пулов).
 */
function poolScopePrefix(
  pooling: 'instance' | 'project' | 'session' | null,
  session: Session,
): string | null {
  if (pooling === 'instance') return 'instance:';
  if (pooling === 'project') {
    const projectId = (session.projectId ?? '').trim();
    return projectId === '' ? null : `project:${projectId}:`;
  }
  if (pooling === 'session') return `session:${session.id}:`;
  return null;
}

/**
 * Пулы текущей области + короткая причина сбоя (без секретов).
 *
 * Провайдера нет — пулов с жизненным циклом нет (не ошибка). Провайдер есть,
 * но перечислять пулы не умеет/не смог — причина в `error`, тул не падает.
 */
async function listScopePools(
  router: ExecutionRouter | undefined,
  scopePrefix: string | null,
): Promise<{ pools: PoolInfo[]; error?: string }> {
  const provider = router?.poolProvider?.();
  if (!provider) return { pools: [] };
  if (typeof provider.list !== 'function') {
    return { pools: [], error: 'pool_list_unavailable' };
  }
  try {
    const pools = await provider.list();
    if (!scopePrefix) return { pools: [] };
    return {
      pools: pools.filter(
        (pool) => typeof pool.key === 'string' && pool.key.startsWith(scopePrefix),
      ),
    };
  } catch {
    // Причина ошибки наружу не идёт: текст провайдера может содержать
    // технические детали (адреса/токены).
    return { pools: [], error: 'pool_list_failed' };
  }
}

/** Значимость состояния пула: `ready` важнее `draining`, `configured` — слабее обоих. */
function poolStateRank(state: PoolInfo['state']): number {
  if (state === 'ready') return 2;
  if (state === 'draining') return 1;
  return 0;
}

/** Класс профиля по составу каталогов (когда метаданные провайдера недоступны). */
function fallbackProfileClass(
  name: string,
  execNames: readonly string[],
  browserNames: readonly string[],
): SessionExecutionProfileClass {
  const inExec = execNames.includes(name);
  const inBrowser = browserNames.includes(name);
  if (inExec && inBrowser) return 'both';
  return inBrowser ? 'browser' : 'exec';
}

/**
 * Сведения об исполнении сессии: режим, режим пула, эффективные профили и
 * каталог профилей инстанса с состоянием пулов **текущей области**.
 *
 * Без секретов: только имена профилей, класс и состояние (инвариант 13).
 * Сбой провайдера пулов/метаданных не ломает тул — причина в `pools_error`.
 */
async function buildSessionExecutionInfo(
  extra: SessionManageExtra,
  session: Session,
): Promise<SessionExecutionInfo> {
  const router = extra.executionRouter;
  const { mode, pooling } = resolveExecutionTopology(router);
  if (mode === 'inline') {
    return {
      mode: 'inline',
      pooling: null,
      session_profile: { name: null, browser: null },
      profiles: [],
    };
  }

  const execNames = uniqueProfileNames(router?.profiles?.());
  const browserNames = uniqueProfileNames(router?.browserProfiles?.());
  const names = uniqueProfileNames(execNames, browserNames);
  const defaultProfile = (router?.defaultProfile?.() ?? '').trim();
  const browserDefaultProfile = (router?.browserDefaultProfile?.() ?? '').trim();

  // Класс профиля: метаданные провайдера (`profilesInfo`), иначе — по составу
  // каталогов имён. Сбой провайдера — не падение тула.
  const classByName = new Map<string, SessionExecutionProfileClass>();
  try {
    const infos = router?.profilesInfo ? await router.profilesInfo() : [];
    for (const info of infos) {
      if (info.class) classByName.set(info.name, info.class);
    }
  } catch {
    // Метаданные недоступны — класс выводится по каталогам имён.
  }

  const scopePrefix = poolScopePrefix(pooling, session);
  const { pools, error: poolsError } = await listScopePools(router, scopePrefix);
  const poolByProfile = new Map<string, PoolInfo>();
  for (const pool of pools) {
    const known = poolByProfile.get(pool.profile);
    if (!known || poolStateRank(pool.state) > poolStateRank(known.state)) {
      poolByProfile.set(pool.profile, pool);
    }
  }

  const truncated = names.length > MAX_EXECUTION_PROFILES;
  const profiles: SessionExecutionProfile[] = names
    .slice(0, MAX_EXECUTION_PROFILES)
    .map((name) => {
      const pool = poolByProfile.get(name);
      const running = pool
        ? pool.state === 'ready'
          ? true
          : pool.state === 'draining'
            ? false
            : null
        : null;
      return {
        name,
        class: classByName.get(name) ?? fallbackProfileClass(name, execNames, browserNames),
        default: defaultProfile !== '' && name === defaultProfile,
        browser_default: browserDefaultProfile !== '' && name === browserDefaultProfile,
        running,
        state: pool?.state ?? 'configured',
      };
    });

  return {
    mode,
    pooling,
    session_profile: {
      name: (extra.executionProfile ?? '').trim() || null,
      browser: (extra.executionBrowserProfile ?? '').trim() || null,
    },
    profiles,
    ...(poolsError ? { pools_error: poolsError } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export const getSessionInfoTool: ToolDefinition = {
  name: 'get_session_info',
  description:
    'Get compact information about the current session: title, project, workspace, mode, agent, '
    + 'provider/model, status/activity, pending count, current stream ids, todo counts, worktree '
    + 'binding and the execution environment (mode, pool scope, effective profiles, profile catalog '
    + 'with pool states — names and states only, no addresses or tokens). No message history is '
    + 'returned.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const extra = getExtra(ctx);
    if (!extra.sessionManager) return missingDepsError(this.name);

    const sessionId = ctx.sessionId || extra.sessionId;
    if (!sessionId) return missingDepsError(this.name);
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session) {
      return {
        content: sm('session.not_found', { id: sessionId }),
        isError: true,
        metadata: { i18n: i18nMeta('session.not_found', { id: sessionId }) },
      };
    }

    let project: Project | null = null;
    if (session.projectId && extra.projectStore) {
      try {
        project = await extra.projectStore.load(session.projectId);
      } catch {
        project = null;
      }
    }

    const todos = session.todos ?? [];
    const execution = await buildSessionExecutionInfo(extra, session);
    const details = {
      id: session.id,
      title: session.title || null,
      project: project ? { id: project.id, name: project.name } : null,
      workspace: project?.workspace ?? null,
      mode: session.mode ?? 'act',
      agent_role: session.settings.agentRole ?? null,
      provider: session.settings.provider ?? null,
      model: session.settings.model ?? null,
      status: sessionStatusInfo(session),
      activity: sessionActivityInfo(session),
      pending_count: pendingCount(session),
      current_stream: session.currentStream
        ? { stream_id: session.currentStream.streamId, turn_id: session.currentStream.turnId ?? null }
        : null,
      todos: { total: todos.length, open: openTodos(session) },
      worktree: session.worktree
        ? { worktreeId: session.worktree.worktreeId, repoPath: session.worktree.repoPath ?? null }
        : null,
      // ADR-135/PROP-135: среда исполнения и пулы (только имена/состояния).
      execution,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    };
    const json = JSON.stringify(details);
    const text = sm('session.details', { name: session.title || session.id, id: session.id, json });
    return {
      content: text,
      metadata: {
        ...details,
        i18n: i18nMeta('session.details', { name: session.title || session.id, id: session.id, json }),
      },
    };
  },
};

const sessionRenameSchema = z.object({
  title: z.string().trim().min(1).max(200).describe('New session title (1..200 chars)'),
});

export const sessionRenameTool: ToolDefinition = {
  name: 'session_rename',
  description:
    'Rename the current session. Only affects the current session; the title must be 1..200 '
    + 'characters (empty is rejected). No LLM title regeneration is performed. Publishes '
    + '`session.renamed` and `session.updated` so other clients update the name.',
  parameters: sessionRenameSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { title: string };

    const extra = getExtra(ctx);
    if (!extra.sessionManager) return missingDepsError(this.name);
    const sessionId = ctx.sessionId || extra.sessionId;
    if (!sessionId) return missingDepsError(this.name);

    let prevTitle: string | undefined;
    let updatedAt = '';
    try {
      await extra.sessionManager.withLock(sessionId, async (session) => {
        prevTitle = session.title;
        session.title = params.title;
        session.updatedAt = nowISO();
        updatedAt = session.updatedAt;
        await extra.sessionManager!.saveSession(session);
      });
    } catch (err) {
      const existing = await extra.sessionManager.getSession(sessionId).catch(() => null);
      if (!existing) {
        return {
          content: sm('session.not_found', { id: sessionId }),
          isError: true,
          metadata: { i18n: i18nMeta('session.not_found', { id: sessionId }) },
        };
      }
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: sm('session.save_error', { error }),
        isError: true,
        metadata: { i18n: i18nMeta('session.save_error', { error }) },
      };
    }

    extra.eventBus?.publish(sessionId, 'session.renamed', {
      session_id: sessionId,
      title: params.title,
      prev_title: prevTitle ?? null,
    });
    extra.eventBus?.publish(sessionId, 'session.updated', {
      session_id: sessionId,
      name: params.title,
      title: params.title,
      updated_at: updatedAt,
    });

    return {
      content: sm('session.rename_ok', { title: params.title }),
      metadata: {
        id: sessionId,
        title: params.title,
        prev_title: prevTitle ?? null,
        i18n: i18nMeta('session.rename_ok', { title: params.title }),
      },
    };
  },
};
