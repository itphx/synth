import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, ContextOptimizer, EventBus } from '@itphx/synth-core';
import { createMessageRoutes as createCoreMessageRoutes } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRecalcCanSummarize } from '../lib/recalc-can-summarize.js';

/**
 * Backend-обёртка над core-фабрикой сообщений: добавляет i18n-сообщения и хук
 * пересчёта `canSummarize` после мутаций (backend-специфика). Логика роутов
 * (batch/toggle/pin/delete/retry/debug) — в core-фабрике.
 */
export function createMessageRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  contextOptimizer: ContextOptimizer | null,
  eventBus: EventBus,
): Hono {
  const app = new Hono();
  const recalcCanSummarize = createRecalcCanSummarize({ sessionManager, contextOptimizer, eventBus });

  app.route('/', createCoreMessageRoutes(
    { requireAuth: kit.requireAuth },
    sessionManager,
    undefined,
    {
      messages: {
        sessionNotFound: (c) => t('errors.notFound.session', undefined, c),
        messageNotFound: (c) => t('errors.notFound.message', undefined, c),
      },
      onMessagesChanged: (sessionId) => recalcCanSummarize(sessionId),
    },
  ));

  return app;
}
