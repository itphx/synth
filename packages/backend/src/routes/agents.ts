import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { JsonStoreLike } from '@itphx/synth-core';
import type { AgentDefinition } from '@itphx/synth-shared';
import { createAgentRoutes as createCoreAgentRoutes } from '@itphx/synth-core';
import type { AgentRegistry } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';

/**
 * Backend-обёртка над core-фабрикой агентов: добавляет только RBAC
 * (админ-эндпоинты — ADMIN) и i18n-сообщения. Логика роутов
 * (GET /, GET /all, POST /, GET /:id, DELETE /:id, PATCH /:id/enabled) — в core.
 */
export function createAgentRoutes(
  kit: AuthKit,
  agentStore: JsonStoreLike<AgentDefinition>,
  agentRegistry?: AgentRegistry,
  getDefaultAgentId?: () => string | Promise<string>,
): Hono {
  const app = new Hono();

  app.route('/', createCoreAgentRoutes(
    { requireAuth: kit.requireAuth },
    agentStore,
    agentRegistry,
    getDefaultAgentId,
    {
      writeGuard: kit.requireAdmin,
      allGuard: kit.requireAdmin,
      detailGuard: kit.requireAdmin,
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        invalidAgentId: (c) => t('errors.validation.invalidAgentId', undefined, c),
        agentNotFound: (c) => t('errors.notFound.agent', undefined, c),
        agentOverrideNotFound: (c) => t('errors.notFound.agentOverride', undefined, c),
      },
    },
  ));

  return app;
}
