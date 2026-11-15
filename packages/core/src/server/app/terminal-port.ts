/**
 * Выбор порта исполнения для терминала (PROP-132 × PROP-135).
 *
 * Терминал — та же агентская работа, что и shell/git-тулы: он должен жить на
 * **той же точке исполнения**, что и ход сессии. Поэтому порт выбирается
 * **тем же** роутером (`ExecutionRouter.portFor`), а профиль — **тем же**
 * binding'ом, что у хода (`resolveExecutionProfile`: сессия → агент → проект
 * → дефолт).
 *
 * ## Что отличается от порта тулов
 *
 * Тул получает порт **из хода** (`ctx.extra.executionPort` — оркестратор уже
 * посчитал). Терминал открывается **вне хода** (из UI или из тула
 * `terminal_open`), поэтому профиль и область здесь считаются заново — по
 * тем же правилам и по тем же данным (сессия/агент/проект).
 *
 * ## Чего здесь нет
 *
 * Никаких прямых обращений к `$SYNTH_DATA_DIR`: только порты чтения
 * (сессия/проект/агенты) и роутер исполнения.
 */
import type { ExecutionPort } from '../../execution/ports/index.js';
import type { ExecutionRouter } from '../../execution/router.js';
import { executionProfileCatalog } from '../../execution/router.js';
import { resolveExecutionProfile } from '../../execution/profile-binding.js';
import { resolveAgentRoleAlias } from '../../engine/agents/migrations.js';
import { resolveWorkspaceSubPath } from '../../engine/orchestrator.js';
import type { TerminalPortContext, TerminalPortResolver } from '../../engine/terminal/types.js';

/** Загрузка сессии (профиль сессии + роль агента). */
export interface TerminalPortSessions {
  /** Загрузить сессию по id. */
  getSession(id: string): Promise<{ settings?: { executorProfile?: string; agentRole?: string } } | null>;
}

/** Загрузка проекта (профиль и потолок профилей проекта). */
export interface TerminalPortProjects {
  /** Загрузить проект по id. */
  load(id: string): Promise<{ executor?: { profile?: string; allowedProfiles?: string[] } } | null>;
}

/** Реестр агентов (профиль и потолок профилей агента). */
export interface TerminalPortAgents {
  /** Определение агента по id роли. */
  get(role: string): { executorProfile?: string; allowedProfiles?: string[] } | undefined;
}

/** Зависимости сборки резолвера порта терминала. */
export interface TerminalPortResolverDeps {
  /** Роутер портов исполнения (PROP-135). */
  router: ExecutionRouter;
  /** Загрузка сессии. */
  sessions?: TerminalPortSessions;
  /** Загрузка проекта. */
  projects?: TerminalPortProjects;
  /** Реестр агентов. */
  agents?: TerminalPortAgents;
  /** Корень каталогов workspace (ADR-075) — для `workspaceSubPath`. */
  workspacesRoot?: string;
}

/**
 * Относительный путь рабочего каталога внутри корня workspace'ов —
 * `workspaceSubPath` для provisioner'а (per-project монтирование PVC).
 *
 * Правило — **то же**, что у хода сессии (`resolveWorkspaceSubPath` в
 * оркестраторе): путь в posix-виде относительно `workspacesRoot`
 * (`proj-slug`, `proj-slug/.worktrees/feature`). Каталог вне корня
 * (standalone с ручным выбором) даёт `undefined` — provisioner смонтирует том
 * целиком.
 */
export function resolveTerminalWorkspaceSubPath(
  workspacesRoot: string | undefined,
  cwd: string,
): string | undefined {
  if (!workspacesRoot) return undefined;
  return resolveWorkspaceSubPath(workspacesRoot, cwd);
}

/**
 * Собрать резолвер порта исполнения терминала.
 *
 * Профиль — по binding'у (сессия → агент → проект → дефолт), область пула —
 * по `projectId`/`sessionId`, `workspaceSubPath` — по рабочему каталогу.
 * Роутер без каталога профилей (inline/вырожденный) работает как прежде:
 * профиль не проверяется, порт выбирается по умолчанию.
 */
export function createTerminalPortResolver(
  deps: TerminalPortResolverDeps,
): TerminalPortResolver {
  const catalog = executionProfileCatalog(deps.router);
  return async (ctx: TerminalPortContext): Promise<ExecutionPort> => {
    let sessionProfile: string | undefined;
    let agentProfile: string | undefined;
    let agentAllowed: readonly string[] | undefined;

    if (ctx.sessionId && deps.sessions) {
      const session = await deps.sessions.getSession(ctx.sessionId);
      const settings = session?.settings;
      sessionProfile = settings?.executorProfile;
      const role = settings?.agentRole;
      if (role && deps.agents) {
        // Алиас прежней роли (`pm` → `leader`) — как у оркестратора.
        const resolvedRole = resolveAgentRoleAlias(role) ?? role;
        const agent = deps.agents.get(resolvedRole);
        agentProfile = agent?.executorProfile;
        agentAllowed = agent?.allowedProfiles;
      }
    }

    let projectProfile: string | undefined;
    let projectAllowed: readonly string[] | undefined;
    if (deps.projects) {
      const project = await deps.projects.load(ctx.projectId);
      projectProfile = project?.executor?.profile;
      projectAllowed = project?.executor?.allowedProfiles;
    }

    const resolution = resolveExecutionProfile({
      ...(sessionProfile !== undefined ? { sessionProfile } : {}),
      ...(agentProfile !== undefined ? { agentProfile } : {}),
      ...(agentAllowed !== undefined ? { agentAllowed } : {}),
      ...(projectProfile !== undefined ? { projectProfile } : {}),
      ...(projectAllowed !== undefined ? { projectAllowed } : {}),
      defaultProfile: catalog?.defaultProfile ?? '',
      ...(catalog ? { knownProfiles: catalog.profiles } : {}),
    });

    return deps.router.portFor({
      profile: resolution.profile || undefined,
      projectId: ctx.projectId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      workspaceSubPath: resolveTerminalWorkspaceSubPath(deps.workspacesRoot, ctx.cwd),
    });
  };
}
