import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, ContextOptimizer, EventBus, ProjectRepository, BlobRefRepository } from '@itphx/synth-core';
import { createMessageRoutes as createCoreMessageRoutes } from '@itphx/synth-core';
import type { Session } from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';
import { createRecalcCanSummarize } from '../lib/recalc-can-summarize.js';
import { createProjectAccess } from './projects.js';

/**
 * Backend-обёртка над core-фабрикой сообщений: добавляет i18n-сообщения, RBAC
 * доступа к сессии (владелец/ADMIN/участник проекта/LEAD) и хук пересчёта
 * `canSummarize` после мутаций (backend-специфика). Логика роутов
 * (batch/toggle/pin/delete/retry/debug) — в core-фабрике.
 */
export function createMessageRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  contextOptimizer: ContextOptimizer | null,
  eventBus: EventBus,
  projectStore?: ProjectRepository,
  /** ADR-115: учёт ссылок на объекты blob-хранилища (снятие при удалении). */
  blobRefs?: BlobRefRepository,
): Hono {
  const app = new Hono();
  const recalcCanSummarize = createRecalcCanSummarize({ sessionManager, contextOptimizer, eventBus });
  const { canReadProject, canEditProjectContent } = createProjectAccess(kit);

  // ADR-071 §2.4: владелец сессии — обычный пользователь.
  const isSessionOwner = (session: Session, userId: string): boolean =>
    (session.ownerId ?? session.userId) === userId;

  app.route('/', createCoreMessageRoutes(
    { requireAuth: kit.requireAuth },
    sessionManager,
    undefined,
    {
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        messageNotFound: (c) => t('errors.notFound.message', undefined, c),
        forbidden: (c) => t('auth.forbidden', undefined, c),
      },
      onMessagesChanged: (sessionId) => recalcCanSummarize(sessionId),
      // ADR-115: ссылки на объекты вложений снимаются при удалении сообщения.
      ...(blobRefs ? { blobRefs } : {}),
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
