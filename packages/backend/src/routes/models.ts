import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { ModelConfig, ProviderConfig, ContextSource } from '@itphx/synth-shared';
import { lookupContextWindow } from '@itphx/synth-shared';
import { createModelRoutes as createCoreModelRoutes, ProviderFactory } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/** Ценовые поля, пришедшие от провайдера (B1 уже отфильтровал non-token тарифы). */
interface ApiPriceFields {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

/** Есть ли у модели хоть одна заданная цена. */
function hasAnyPrice(model: ModelConfig): boolean {
  return model.inputPrice !== undefined
    || model.outputPrice !== undefined
    || model.cacheReadPrice !== undefined
    || model.cacheWritePrice !== undefined;
}

/**
 * Считаются ли цены модели ручными. Явная пометка `priceSource === 'manual'`,
 * либо старые записи без `priceSource`, но с ценами (введены вручную до
 * появления поля) — их нельзя терять при синхронизации.
 */
function isManualPriceSource(model: ModelConfig): boolean {
  return model.priceSource === 'manual' || (model.priceSource === undefined && hasAnyPrice(model));
}

/** Токенные цены от провайдера, если они есть; иначе undefined. */
function collectApiPrices(model: ApiPriceFields): ApiPriceFields | undefined {
  if (
    model.inputPrice === undefined
    && model.outputPrice === undefined
    && model.cacheReadPrice === undefined
    && model.cacheWritePrice === undefined
  ) {
    return undefined;
  }
  return {
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
    cacheReadPrice: model.cacheReadPrice,
    cacheWritePrice: model.cacheWritePrice,
  };
}

/**
 * Backend-обёртка над core-фабрикой моделей: добавляет только RBAC
 * (мутации — ADMIN), `set_as_default` и backend-only синхронизацию `fetch`.
 */
export function createModelRoutes(
  kit: AuthKit,
  modelStore: JsonStore<ModelConfig>,
  providerStore: JsonStore<ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  providerCache: Map<string, ProviderConfig>,
): Hono {
  const app = new Hono();

  // POST /api/v2/models/fetch — синхронизировать модели с провайдеров (admin).
  // Статический сегмент регистрируем до core-роутов (в т.ч. /:id).
  app.post('/fetch', kit.requireAdmin, createRateLimiter(3, 120_000), async (c) => {
    const providerFilter = c.req.query('provider');
    const providers = await providerStore.list();
    const enabledProviders = providers.filter((p) =>
      p.enabled !== false && (!providerFilter || p.name === providerFilter)
    );

    let totalFetched = 0;
    let totalNew = 0;
    let totalEnriched = 0;
    let totalPriced = 0;
    let totalLimited = 0;
    const errors: string[] = [];

    for (const provider of enabledProviders) {
      const providerConfig = {
        type: provider.type,
        name: provider.name,
        url: provider.baseUrl || '',
        apiKey: provider.apiKey || '',
        model: provider.defaultModel || '',
        timeout: 30,
        currency: provider.currency,
      };

      if (!providerConfig.url) continue;

      try {
        const instance = ProviderFactory.create(provider.name, providerConfig);
        const models = await instance.listModelsDetailed();

        for (const model of models) {
          const modelId = model.id;
          const fullId = `${provider.name}/${modelId}`;
          const existing = await modelStore.load(fullId);
          const { window, source } = lookupContextWindow(modelId);
          // Окно, сообщённое самим провайдером (Ollama /api/tags), приоритетнее
          // справочника и ручных значений; 0/undefined означает «неизвестно».
          const apiWindow = typeof model.contextWindow === 'number' && model.contextWindow > 0
            ? model.contextWindow
            : 0;
          const resolvedWindow = apiWindow > 0 ? apiWindow : window;
          const resolvedSource: ContextSource = apiWindow > 0
            ? 'api'
            : (source !== 'unknown' ? source : 'unknown');

          // Лимит выходных токенов — только из API.
          const apiMaxOutput = typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
            ? model.maxOutputTokens
            : undefined;
          // Токенные цены от провайдера (B1 отфильтровал non-token тарифы).
          const apiPrices = collectApiPrices(model);

          if (!existing) {
            // Новая модель
            const newModel: ModelConfig = {
              id: fullId,
              name: modelId,
              provider: provider.name,
              description: '',
              enabled: true,
              isDefault: false,
              contextWindow: resolvedWindow,
              contextSource: resolvedSource,
            };
            if (apiMaxOutput !== undefined) {
              newModel.maxOutputTokens = apiMaxOutput;
              totalLimited++;
            }
            if (apiPrices) {
              Object.assign(newModel, apiPrices);
              newModel.priceSource = 'api';
              totalPriced++;
            }
            if (provider.currency) {
              newModel.currency = provider.currency;
            }
            await modelStore.save(fullId, newModel);
            modelCache.set(fullId, newModel);
            totalNew++;
            totalFetched++;
            continue;
          }

          let changed = false;

          if (apiWindow > 0 && existing.contextWindow !== apiWindow) {
            // Провайдер сообщил реальное окно — оно приоритетнее справочника
            // и актуальнее ранее известного api/reference-значения, но НЕ
            // перезаписывает вручную заданное пользователем (source='manual').
            const hasManualWindow = existing.contextSource === 'manual' && (existing.contextWindow ?? 0) > 0;
            if (!hasManualWindow) {
              existing.contextWindow = apiWindow;
              existing.contextSource = 'api';
              changed = true;
              totalEnriched++;
            }
          } else if ((existing.contextWindow ?? 0) === 0 && window > 0) {
            // Обогащаем существующую модель справочными данными
            existing.contextWindow = window;
            existing.contextSource = source;
            changed = true;
            totalEnriched++;
          }

          // maxOutputTokens: заполняем только если пришло из API и ещё не задано.
          if (apiMaxOutput !== undefined && existing.maxOutputTokens == null) {
            existing.maxOutputTokens = apiMaxOutput;
            changed = true;
            totalLimited++;
          }

          // Цены: пишем api-цены, только если модель не помечена ручной и нет
          // старых цен без priceSource (их тоже считаем ручными).
          if (apiPrices && !isManualPriceSource(existing)) {
            Object.assign(existing, apiPrices);
            existing.priceSource = 'api';
            if (existing.currency === undefined && provider.currency) {
              existing.currency = provider.currency;
            }
            changed = true;
            totalPriced++;
          }

          totalFetched++;
          if (changed) {
            await modelStore.save(fullId, existing);
            modelCache.set(fullId, existing);
          }
        }
      } catch (err) {
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : t('errors.generic', undefined, c)}`);
      }
    }

    return c.json({
      fetched: totalFetched,
      new: totalNew,
      enriched: totalEnriched,
      priced: totalPriced,
      limited: totalLimited,
      errors: errors.length ? errors : undefined,
    });
  });

  // Общая логика (GET /, POST /, DELETE /:id, set_as_default) — в core.
  app.route('/', createCoreModelRoutes(
    { requireAuth: kit.requireAuth },
    modelStore,
    providerStore,
    modelCache,
    {
      writeGuard: kit.requireAdmin,
      providerCache,
      supportSetAsDefault: true,
      messages: {
        idRequired: (c) => t('errors.validation.idRequired', undefined, c),
        modelNotFound: (c) => t('errors.notFound.model', undefined, c),
      },
    },
  ));

  return app;
}
