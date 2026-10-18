import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { DefaultModelPair, JsonStoreLike } from '@itphx/synth-core';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import { createModelRoutes as createCoreModelRoutes } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/** Колбэки модели по умолчанию инстанса (runtime-пара provider+model). */
export interface ModelRoutesDefaultOptions {
  getDefaultModel?: () => DefaultModelPair | null | Promise<DefaultModelPair | null>;
  setDefaultModel?: (pair: DefaultModelPair) => void | Promise<void>;
}

/**
 * Backend-обёртка над core-фабрикой моделей: добавляет только RBAC
 * (мутации и синхронизация — ADMIN), rate limit на `fetch` и `set_as_default`.
 * Логика роутов (GET /, POST /, DELETE /:id, POST /fetch) — в core-фабрике.
 */
export function createModelRoutes(
  kit: AuthKit,
  modelStore: JsonStoreLike<ModelConfig>,
  providerStore: JsonStoreLike<ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  providerCache: Map<string, ProviderConfig>,
  defaults: ModelRoutesDefaultOptions = {},
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
      getDefaultModel: defaults.getDefaultModel,
      setDefaultModel: defaults.setDefaultModel,
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        modelNotFound: (c) => t('errors.notFound.model', undefined, c),
        fetchError: (c) => t('errors.generic', undefined, c),
      },
    },
  ));

  return app;
}
