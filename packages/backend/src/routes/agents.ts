import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { JsonStoreLike } from '@itphx/synth-core';
import type { AgentDefinition } from '@itphx/synth-shared';
import { createAgentRoutes as createCoreAgentRoutes } from '@itphx/synth-core';
import type { AgentRegistry, AgentsChangedHook, ContextFileRepository, ExecutionProfileCatalog } from '@itphx/synth-core';
import { requireAdminRoleOrScope } from '../auth/guards.js';
import { t } from '../lib/i18n.js';

/**
 * Backend-обёртка над core-фабрикой агентов: добавляет только RBAC
 * (админ-эндпоинты — ADMIN) и i18n-сообщения. Логика роутов
 * (GET /, GET /all, POST /, GET /:id, DELETE /:id, PATCH /:id/enabled) — в core.
 *
 * `contextFiles` — порт файлов контекста: запись ролевого промпта агента
 * вместе с агентом (ADR-126/ADR-089, поле `role_prompt` в теле POST).
 * Роль пишется тем же guard'ом, что и создание агента (ADMIN).
 *
 * ADR-052: запись агентов (создание + ролевой промпт) — «роль ADMIN **или**
 * scope `automation:install`» (зонтичный скоуп установщика пакетов
 * расширений). Guard `requireAdminRoleOrScope` учитывает и роль ADMIN в
 * service-key, и scope — прежние права не отбираются, новые добавляются.
 *
 * `onAgentsChanged` — реестр агентов изменился (создан/обновлён/удалён/
 * включён-выключен). Точка сборки передаёт сюда `agentsChangedPublisher(eventBus)`:
 * событие `agents.updated` уходит в инстансный канал шины, и админ-панель
 * «Агенты» перечитывает состав без перезагрузки страницы. Не задан — поведение
 * прежнее (тесты, сторонние потребители).
 */
export function createAgentRoutes(
  kit: AuthKit,
  agentStore: JsonStoreLike<AgentDefinition>,
  agentRegistry?: AgentRegistry,
  getDefaultAgentId?: () => string | Promise<string>,
  contextFiles?: ContextFileRepository,
  executionProfileCatalog?: ExecutionProfileCatalog,
  browserProfileCatalog?: ExecutionProfileCatalog,
  onAgentsChanged?: AgentsChangedHook,
): Hono {
  const app = new Hono();

  app.route('/', createCoreAgentRoutes(
    { requireAuth: kit.requireAuth },
    agentStore,
    agentRegistry,
    getDefaultAgentId,
    {
      writeGuard: requireAdminRoleOrScope('automation:install'),
      allGuard: kit.requireAdmin,
      detailGuard: kit.requireAdmin,
      roleFiles: contextFiles,
      // PROP-135 Ф6a: каталог профилей — проверка профиля агента при записи.
      ...(executionProfileCatalog ? { executionProfileCatalog } : {}),
      // PROP-135 (браузерный контур): каталог браузерных профилей агента.
      ...(browserProfileCatalog ? { browserProfileCatalog } : {}),
      // Событие `agents.updated` (инстансный канал шины) после мутации реестра.
      ...(onAgentsChanged ? { onAgentsChanged } : {}),
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        invalidAgentId: (c) => t('errors.validation.invalidAgentId', undefined, c),
        invalidRoleFile: (c) => t('errors.validation.invalidRoleFile', undefined, c),
        invalidEffort: (c) => t('errors.validation.invalidEffort', undefined, c),
        agentNotFound: (c) => t('errors.notFound.agent', undefined, c),
        agentOverrideNotFound: (c) => t('errors.notFound.agentOverride', undefined, c),
      },
    },
  ));

  return app;
}
