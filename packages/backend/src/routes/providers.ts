import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { JsonStoreLike } from '@itphx/synth-core';
import type { DefaultModelPair } from '@itphx/synth-core';
import type { EgressPolicy, ProviderConfig } from '@itphx/synth-shared';
import { createProviderRoutes as createCoreProviderRoutes } from '@itphx/synth-core';
import type { EgressLogSink } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/** Инъекция egress-политики/журнала для `/fetch-icon` (резолвер из deps). */
export interface ProviderRoutesEgressOptions {
  /** Живой резолвер `egress.tools` (per-request; без него — встроенный дефолт). */
  resolvePolicy?: () => Promise<EgressPolicy>;
  /** Приёмник журнала внешних запросов (scope `providers`). */
  log?: EgressLogSink;
}

/**
 * Backend-обёртка над core-фабрикой провайдеров: добавляет только RBAC
 * (мутации — ADMIN), rate limit на тест подключения и на `fetch-icon`.
 *
 * Сами роуты (в т.ч. `POST /fetch-icon`) — в core-фабрике; обёртка лишь
 * передаёт guard'ы, rate limit, egress-политику/журнал и тексты (i18n).
 *
 * URL провайдера проверяется общей egress-политикой (`egress.tools`, live),
 * без собственной копии списка приватных диапазонов.
 */
export function createProviderRoutes(
  kit: AuthKit,
  store: JsonStoreLike<ProviderConfig>,
  providerCache: Map<string, ProviderConfig>,
  egress: ProviderRoutesEgressOptions = {},
  getDefaultModel?: () => DefaultModelPair | null | Promise<DefaultModelPair | null>,
): Hono {
  const app = new Hono();

  // Общая логика (GET /, POST /, GET/DELETE /:name, POST /:name/test,
  // POST /fetch-icon) — в core.
  app.route('/', createCoreProviderRoutes(
    { requireAuth: kit.requireAuth },
    store,
    providerCache,
    {
      writeGuard: kit.requireAdmin,
      detailGuard: kit.requireAdmin,
      testEnabled: true,
      testGuard: kit.requireAdmin,
      testMiddleware: [createRateLimiter(5, 60_000)],
      // POST /api/v2/providers/fetch-icon — favicon домена (admin).
      // Статический сегмент `/fetch-icon` core-фабрика регистрирует ДО
      // параметрических (`/:name`).
      fetchIcon: {
        enabled: true,
        guard: kit.requireAdmin,
        middleware: [createRateLimiter(10, 60_000)],
        resolvePolicy: egress.resolvePolicy,
        log: egress.log,
      },
      getDefaultModel,
      messages: {
        nameRequired: (c) => t('errors.validation.nameRequired', undefined, c),
        providerNotFound: (c) => t('errors.notFound.provider', undefined, c),
        providerDisabled: (c) => t('errors.providerDisabled', undefined, c),
        urlRequired: (c) => t('errors.validation.urlRequired', undefined, c),
        urlInvalid: (c) => t('errors.validation.invalidUrl', undefined, c),
        connectionError: (c) => t('errors.connectionError', undefined, c),
        faviconNotFound: (c) => t('errors.notFound.favicon', undefined, c),
        faviconFetchError: (c) => t('errors.faviconFetchError', undefined, c),
      },
    },
  ));

  return app;
}
