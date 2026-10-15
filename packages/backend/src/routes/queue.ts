import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus, ProjectRepository } from '@itphx/synth-core';
import { createQueueRoutes as createCoreQueueRoutes } from '@itphx/synth-core';
import type { Session } from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';
import { createProjectAccess } from './projects.js';

/**
 * Backend-обёртка над core-фабрикой очереди: добавляет i18n-сообщения и RBAC
 * доступа к сессии (владелец/ADMIN/участник проекта/LEAD). Логика роутов
 * (clear/return/resume/retry-now/cancel-retry) — в core-фабрике.
 */
export function createQueueRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
  projectStore?: ProjectRepository,
): Hono {
  const app = new Hono();
  const { canReadProject, canEditProjectContent } = createProjectAccess(kit);

  // ADR-071 §2.4: владелец сессии — обычный пользователь.
  const isSessionOwner = (session: Session, userId: string): boolean =>
    (session.ownerId ?? session.userId) === userId;

  app.route('/', createCoreQueueRoutes(
    { requireAuth: kit.requireAuth },
    sessionManager,
    queueManager,
    eventBus,
    processMessage,
    undefined,
    {
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        messageNotFoundIndex: (c) => t('errors.notFound.messageIndex', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
      },
      resolveUserId: async (c) => (await kit.getCurrentUser(c))?.id ?? '',
      canAccess: (session, c, userId) =>
        isSessionOwner(session, userId)
        || (typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0])),
      resolveElevated: (c) => {
        const isAdmin =
          typeof kit.isAdmin === 'function' && kit.isAdmin(c as Parameters<typeof kit.isAdmin>[0]);
        const isLead =
          typeof kit.hasRole === 'function' && kit.hasRole(c as Parameters<typeof kit.hasRole>[0], 'LEAD');
        return isAdmin || isLead;
      },
      // read/write по роли в проекте: чтение — owner/любой участник, мутация —
      // owner/EDITOR/LEAD/ADMIN (`createProjectAccess`; см. sessions.ts).
      resolveCanAccessExtra: async (session, c, userId, access) => {
        if (!projectStore || !session.projectId) return false;
        const project = await projectStore.load(session.projectId);
        if (!project) return false;
        const ctx = c as Parameters<typeof kit.isAdmin>[0];
        return access === 'read'
          ? canReadProject(ctx, project, userId)
          : canEditProjectContent(ctx, project, userId);
      },
    },
  ));

  return app;
}
