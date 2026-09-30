import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { SessionManager, QueueProcessorManager, ChatOrchestrator, EventBus } from '@itphx/synth-core';
import { createQueueRoutes as createCoreQueueRoutes } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';

/**
 * Backend-обёртка над core-фабрикой очереди: добавляет только i18n-сообщения.
 * Логика роутов (clear/return/resume/retry-now/cancel-retry) — в core-фабрике.
 */
export function createQueueRoutes(
  kit: AuthKit,
  sessionManager: SessionManager,
  queueManager: QueueProcessorManager,
  eventBus: EventBus,
  processMessage: ReturnType<ChatOrchestrator['createProcessMessage']>,
): Hono {
  const app = new Hono();

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
      },
    },
  ));

  return app;
}
