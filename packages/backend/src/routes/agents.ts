import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { JsonStoreLike } from '@itphx/synth-core';
import type { AgentDefinition } from '@itphx/synth-shared';
import { createAgentRoutes as createCoreAgentRoutes } from '@itphx/synth-core';
import type { AgentRegistry, ContextFileRepository } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';

/**
 * Backend-обёртка над core-фабрикой агентов: добавляет только RBAC
 * (админ-эндпоинты — ADMIN) и i18n-сообщения. Логика роутов
 * (GET /, GET /all, POST /, GET /:id, DELETE /:id, PATCH /:id/enabled) — в core.
 *
 * `contextFiles` — порт файлов контекста: запись ролевого промпта агента
 * вместе с агентом (ADR-046/ADR-089, поле `role_prompt` в теле POST).
 * Роль пишется тем же guard'ом, что и создание агента (ADMIN).
 */
export function createAgentRoutes(
  kit: AuthKit,
  agentStore: JsonStoreLike<AgentDefinition>,
  agentRegistry?: AgentRegistry,
  getDefaultAgentId?: () => string | Promise<string>,
  contextFiles?: ContextFileRepository,
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
      roleFiles: contextFiles,
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        invalidAgentId: (c) => t('errors.validation.invalidAgentId', undefined, c),
        invalidRoleFile: (c) => t('errors.validation.invalidRoleFile', undefined, c),
        agentNotFound: (c) => t('errors.notFound.agent', undefined, c),
        agentOverrideNotFound: (c) => t('errors.notFound.agentOverride', undefined, c),
      },
    },
  ));

  return app;
}
