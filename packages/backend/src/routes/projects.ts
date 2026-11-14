import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type {
  ProjectRepository, SessionManager, McpManager, SkillService,
  SettingsRepository, McpRegistryRepository, EventBus, SecurityAuditRepository,
  ProjectChangeKind,
} from '@itphx/synth-core';
import { createProjectRoutes as createCoreProjectRoutes, resolveProjectSkillSeed } from '@itphx/synth-core';
import type { ExecutionProfileCatalog } from '@itphx/synth-core';
// ADR-114: сервис worktree — контур `/projects/:id/worktrees*`.
import type { WorktreeService } from '@itphx/synth-core';
import type { EventHub } from '../events/hub.js';
import type { Project, User } from '@itphx/synth-shared';
import {
  canManageWithProjectRole,
  canWriteWithProjectRole,
  resolveProjectAccess,
} from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';
import { projectPrincipalOf, groupsOf } from '../lib/project-principal.js';

/**
 * ADR-076 §T4: RBAC-хелперы проекта (owner/EDITOR/LEAD/ADMIN). Вынесены фабрикой,
 * чтобы их переиспользовали git-роуты core-фабрики (`authorizeProject`), а логика
 * ролей не дублировалась.
 *
 * PROP-133 §1: предикат — **единственный** резолвер доступа
 * (`resolveProjectAccess`); здесь только сборка принципала запроса. Своей копии
 * правил (owner/`members`/`ADMIN`/`LEAD`) больше нет.
 */
export function createProjectAccess(kit: AuthKit) {
  type Ctx = Parameters<typeof kit.isAdmin>[0];

  /**
   * PROP-133 §1: принципал запроса — пользователь + роли инстанса (+ группы, Ф2).
   *
   * Пользователь берётся из контекста (`c.get('user')` — тот же `User`, что
   * кладёт `attachUser`/`requireAuth` и что отдаёт `kit.getCurrentUser`); если
   * пользователя в контексте нет (мок-AuthKit в тестах) — роли инстанса
   * определяются через AuthKit (`isAdmin`/`hasRole` — те же проверки, что и
   * прежде). Проверка остаётся **синхронной**: контракт core-фабрики
   * (`opts.canManage`/`canEditContent`/`canRead`) — sync.
   */
  const principalOf = (c: Ctx, userId: string) => {
    const user = c.get('user') as User | undefined;
    const roles = user?.roles ? [...user.roles] : [];
    if (roles.length === 0) {
      if (typeof kit.isAdmin === 'function' && kit.isAdmin(c)) roles.push('ADMIN');
      else if (typeof kit.hasRole === 'function' && kit.hasRole(c, 'LEAD')) roles.push('LEAD');
    }
    return projectPrincipalOf(user, userId, roles);
  };

  /** PROP-133 §1: решение по доступу к проекту для принципала запроса. */
  const accessOf = (c: Ctx, project: Project, userId: string) =>
    resolveProjectAccess(project, principalOf(c, userId));

  /**
   * ADR-076 §T4 / PROP-133 §1: управление доступом к проекту — автор проекта,
   * участник с ролью `owner`, а также глобальные `LEAD`/`ADMIN` (сквозной
   * обзор). Гранты по группе и режим «всем пользователям» роль `owner` **не**
   * дают (см. `canManageWithProjectRole`).
   */
  const canManageProject = (c: Ctx, project: Project, userId: string): boolean =>
    canManageWithProjectRole(accessOf(c, project, userId).role);

  /**
   * D5 / PROP-133 §1: редактирование контента проекта — `owner`/`editor`
   * (в т.ч. грант по группе и режим «всем пользователям» с ролью `editor`).
   * `viewer` записи не даёт (инвариант 21).
   */
  const canEditProjectContent = (c: Ctx, project: Project, userId: string): boolean =>
    canWriteWithProjectRole(accessOf(c, project, userId).role);

  /**
   * ADR-089 / PROP-133 §1: чтение проекта по id — по роли доступа (владелец,
   * участник, грант по группе, режим «всем пользователям»; `LEAD`/`ADMIN` —
   * сквозной обзор). Не расширяет права на редактирование.
   */
  const canReadProject = (c: Ctx, project: Project, userId: string): boolean =>
    accessOf(c, project, userId).read;

  return { canManageProject, canEditProjectContent, canReadProject };
}

/**
 * Backend-обёртка над core-фабрикой проектов: общая логика — в core, здесь только
 * managed-специфика — RBAC (`createProjectAccess`), i18n-сообщения, авто-имя
 * workspace (ADR-075, политика `deny` вне root), проектный MCP-скоуп (ADR-071 §2.4)
 * и статистика сессий. Полная реализация — `@itphx/synth-core`.
 */
export function createProjectRoutes(
  kit: AuthKit,
  store: ProjectRepository,
  sessionManager: SessionManager,
  workspacesRoot: string,
  /** ADR-071 §2.4: источник известных MCP-серверов для проектного скоупа. */
  mcpManager?: McpManager,
  /** ADR-046 §4.5: сид скиллов нового проекта (системные дефолты). */
  skillService?: SkillService,
  settingsStore?: SettingsRepository,
  mcpRegistryStore?: McpRegistryRepository,
  /**
   * ADR-114: сервис worktree проекта — контур `/projects/:id/worktrees*`
   * (список/создание/удаление/prune). Не задан — роутов нет.
   */
  worktreeService?: WorktreeService,
  /**
   * ADR-118 §4: шина событий — `PUT /:id`/`DELETE /:id` публикуют
   * `project.updated`/`project.deleted` в канал каждой сессии проекта.
   * Не задана — публикации нет (поведение прежнее).
   */
  eventBus?: EventBus,
  /**
   * PROP-135 Ф6a: каталог профилей исполнения (`execution.remote`) —
   * валидация `project.executor.profile`/`allowedProfiles` (PUT /:id).
   * Не задан — проверка существования профиля пропускается.
   */
  executionProfileCatalog?: ExecutionProfileCatalog,
  /**
   * PROP-135 (браузерный контур): каталог браузерных профилей — валидация
   * `project.executor.browserProfile`/`allowedBrowserProfiles`.
   */
  browserProfileCatalog?: ExecutionProfileCatalog,
  /**
   * PROP-133 §3.1: журнал изменений состояния доступа к проекту
   * (`members`/`group_members`/`everyone_role`) — тот же порт
   * `SecurityAuditRepository`, что у security-аудита (скоуп `projects`).
   * Не задан — аудит не пишется (фича работает).
   */
  securityAudit?: SecurityAuditRepository,
  /**
   * ADR-140 Ф2: хаб подписок WS/SSE — при смене состояния доступа к проекту
   * подписки уже подключённых клиентов пересчитываются (доступ применяется
   * к тем, кто подключён **до** изменения).
   * Не задан — пересчёта нет (подписки остаются прежними).
   */
  eventHub?: EventHub,
): Hono {
  const { canManageProject, canEditProjectContent, canReadProject } = createProjectAccess(kit);

  return createCoreProjectRoutes(
    { requireAuth: kit.requireAuth },
    store,
    undefined,
    {
      canManage: canManageProject,
      canEditContent: canEditProjectContent,
      canRead: canReadProject,
      // ADR-089: ADMIN/LEAD — сквозная видимость всех проектов (защита от мок-AuthKit).
      resolveElevated: (c) =>
        (typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]))
        || (typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'LEAD')),
      // PROP-133 §1/§6: группы принципала — грант по группе должен попадать и
      // в список проектов (иначе проект читается по `GET /:id`, но в списке
      // отсутствует). Нет поля/не массив/пусто — групп нет (fail-closed).
      resolveViewerGroups: (c) => groupsOf(c.get('user') as User),
      getCurrentUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
      messages: {
        nameRequired: (c) => t('errors.validation.nameRequired', undefined, c),
        notFound: (c) => t('errors.notFound.project', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
      },
      autoProvisionWorkspace: true,
      getMcpServers: () => Object.keys(mcpManager?.getConfig() ?? {}),
      // PROP-125: источник сервера (`local`/`server`) — бейдж «серверный» в UI.
      // У backend удалённых записей нет (сервер отдаёт состав сам) → `local`,
      // но контракт ответа единый с core.
      getMcpServerSources: () => Object.fromEntries(
        Object.keys(mcpManager?.getConfig() ?? {}).map((name): [string, 'local' | 'server'] => [
          name,
          (typeof mcpManager?.isRemoteServer === 'function' && mcpManager.isRemoteServer(name))
            ? 'server'
            : 'local',
        ]),
      ),
      getProjectSeeds: async () => {
        const defaultMcpServers = mcpRegistryStore
          ? await mcpRegistryStore.toDefaultServers()
          : Object.entries(mcpManager?.getConfig() ?? {})
            .filter(([, cfg]) => cfg.enabledByDefault === true)
            .map(([name]) => name);
        return {
          mcp: { enabled: [...defaultMcpServers], defaultOn: [...defaultMcpServers] },
          ...(skillService && settingsStore
            ? {
                skills: await resolveProjectSkillSeed(
                  skillService,
                  await settingsStore.getSkillsDisabledForNewProjects(),
                ),
              }
            : {}),
        };
      },
      sessionManager,
      getWorkspacesRoot: () => workspacesRoot,
      getOutsideRootPolicy: () => 'deny',
      // ADR-114: контур worktree проекта.
      ...(worktreeService ? { worktrees: worktreeService } : {}),
      // ADR-118 §4: изменение/удаление проекта — в канал каждой сессии проекта.
      ...(eventBus
        ? {
            sessionManager,
            onProjectChanged: async (projectId: string, kind: ProjectChangeKind) => {
              const sessions = await sessionManager.listSessions({ projectId });
              for (const s of sessions) {
                eventBus.publish(s.id, kind === 'deleted' ? 'project.deleted' : 'project.updated', {
                  project_id: projectId,
                  // ADR-140 Ф2: вид изменения — UI/подписки видят, что именно
                  // изменилось (в т.ч. состояние доступа — `access`).
                  kind,
                });
              }
              // ADR-140 Ф2: изменилось состояние доступа — пересчитать
              // подписки уже подключённых клиентов (иначе новый участник не
              // получит события сессий проекта, а потерявший — продолжит
              // получать).
              if (kind === 'access') {
                await eventHub?.resyncAllClients();
              }
            },
          }
        : {}),
      // PROP-135 Ф6a: каталог профилей исполнения — проверка
      // `project.executor.profile`/`allowedProfiles` в PUT /:id.
      ...(executionProfileCatalog ? { executionProfileCatalog } : {}),
      // PROP-135 (браузерный контур): каталог браузерных профилей проекта.
      ...(browserProfileCatalog ? { browserProfileCatalog } : {}),
      // PROP-133 §3.1: аудит изменения состояния доступа к проекту.
      ...(securityAudit ? { securityAudit } : {}),
    },
  );
}
