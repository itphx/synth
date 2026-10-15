import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore, SessionManager, McpManager, SkillService, RuntimeSettingsStore, McpRegistryStore } from '@itphx/synth-core';
import { createProjectRoutes as createCoreProjectRoutes, resolveProjectSkillSeed } from '@itphx/synth-core';
import type { Project } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';

/**
 * ADR-076 §T4: RBAC-хелперы проекта (owner/EDITOR/LEAD/ADMIN). Вынесены фабрикой,
 * чтобы их переиспользовали git-роуты core-фабрики (`authorizeProject`), а логика
 * ролей не дублировалась.
 */
export function createProjectAccess(kit: AuthKit) {
  type Ctx = Parameters<typeof kit.isAdmin>[0];

  /** ADR-071 §2.4: owner проекта или глобальные LEAD/ADMIN (через AuthKit). */
  const canManageProject = (c: Ctx, project: Project, userId: string): boolean =>
    (typeof kit.isAdmin === 'function' && kit.isAdmin(c))
    || (typeof kit.hasRole === 'function' && kit.hasRole(c, 'LEAD'))
    || project.ownerId === userId
    || project.members?.[userId] === ProjectRole.OWNER;

  /** D5: owner / EDITOR / глобальные LEAD/ADMIN — редактирование контента проекта. */
  const canEditProjectContent = (c: Ctx, project: Project, userId: string): boolean =>
    canManageProject(c, project, userId)
    || project.members?.[userId] === ProjectRole.EDITOR;

  /**
   * ADR-089: чтение проекта по id — owner / любой участник (любая роль, в т.ч.
   * VIEWER) / глобальные LEAD/ADMIN. Не расширяет права на редактирование.
   */
  const canReadProject = (c: Ctx, project: Project, userId: string): boolean =>
    canManageProject(c, project, userId)
    || userId in (project.members ?? {});

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
  store: ProjectStore,
  sessionManager: SessionManager,
  workspacesRoot: string,
  /** ADR-071 §2.4: источник известных MCP-серверов для проектного скоупа. */
  mcpManager?: McpManager,
  /** ADR-046 §4.5: сид скиллов нового проекта (системные дефолты). */
  skillService?: SkillService,
  settingsStore?: RuntimeSettingsStore,
  mcpRegistryStore?: McpRegistryStore,
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
      getCurrentUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
      messages: {
        nameRequired: (c) => t('errors.validation.nameRequired', undefined, c),
        notFound: (c) => t('errors.notFound.project', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
      },
      autoProvisionWorkspace: true,
      getMcpServers: () => Object.keys(mcpManager?.getConfig() ?? {}),
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
    },
  );
}
