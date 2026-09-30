import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '@itphx/synth-core';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import { createModelRoutes as createCoreModelRoutes } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/**
 * Backend-обёртка над core-фабрикой моделей: добавляет только RBAC
 * (мутации и синхронизация — ADMIN), rate limit на `fetch` и `set_as_default`.
 * Логика роутов (GET /, POST /, DELETE /:id, POST /fetch) — в core-фабрике.
 */
export function createModelRoutes(
  kit: AuthKit,
  modelStore: JsonStore<ModelConfig>,
  providerStore: JsonStore<ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  providerCache: Map<string, ProviderConfig>,
): Hono {
  const app = new Hono();

  // Общая логика (GET /, POST /, DELETE /:id, POST /fetch, set_as_default) — в core.
  app.route('/', createCoreModelRoutes(
    { requireAuth: kit.requireAuth },
    modelStore,
    providerStore,
    modelCache,
    {
      writeGuard: kit.requireAdmin,
      fetchGuard: kit.requireAdmin,
      fetchMiddleware: [createRateLimiter(3, 120_000)],
      providerCache,
      supportSetAsDefault: true,
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        modelNotFound: (c) => t('errors.notFound.model', undefined, c),
        fetchError: (c) => t('errors.generic', undefined, c),
      },
    },
  ));

  return app;
}
