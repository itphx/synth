import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { Currency, ModelConfig, ProviderConfig, ContextSource, PriceSource } from '@itphx/synth-shared';
import { CURRENCIES, lookupContextWindow } from '@itphx/synth-shared';
import { ProviderFactory } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

/** Валидирует валюту по списку RUB/USD/CNY; иначе — undefined. */
function parseCurrency(value: unknown): Currency | undefined {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
    ? (value as Currency)
    : undefined;
}

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

/** Присутствуют ли в теле запроса ценовые поля (snake_case или camelCase). */
function hasPriceInput(body: unknown): boolean {
  return !!body && typeof body === 'object' && (
    'input_price' in body || 'inputPrice' in body
    || 'output_price' in body || 'outputPrice' in body
    || 'cache_read_price' in body || 'cacheReadPrice' in body
    || 'cache_write_price' in body || 'cacheWritePrice' in body
  );
}

interface ModelGroupResponse {
  provider: {
    name: string;
    type: string;
    icon: string;
    defaultModel: string;
    currency?: Currency;
  };
  models: Array<{
    id: string;
    name: string;
    provider: string;
    description?: string;
    enabled: boolean;
    isDefault: boolean;
    contextWindow?: number;
    contextSource?: ContextSource;
    maxOutputTokens?: number;
    inputPrice?: number;
    outputPrice?: number;
    cacheReadPrice?: number;
    cacheWritePrice?: number;
    priceSource?: PriceSource;
    currency?: Currency;
  }>;
}

export function createModelRoutes(
  kit: AuthKit,
  modelStore: JsonStore<ModelConfig>,
  providerStore: JsonStore<ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  providerCache: Map<string, ProviderConfig>,
): Hono {
  const app = new Hono();

  // GET /api/v2/models — сгруппированный список моделей
  app.get('/', kit.requireAuth, async (c) => {
    const filterProvider = c.req.query('provider');
    const onlyEnabled = c.req.query('enabled_only') === 'true' || c.req.query('enabled_only') === '1';

    const [models, providers] = await Promise.all([modelStore.list(), providerStore.list()]);

    // Собираем информацию о провайдерах
    const providerMap = new Map<string, ProviderConfig>();
    for (const p of providers) {
      providerMap.set(p.name, p);
    }

    // Группируем модели по провайдеру (пропускаем модели от несуществующих провайдеров)
    const groups = new Map<string, ModelConfig[]>();
    for (const m of models) {
      if (filterProvider && m.provider !== filterProvider) continue;
      if (onlyEnabled && !m.enabled) continue;
      if (!providerMap.has(m.provider)) continue;

      const group = groups.get(m.provider) || [];
      group.push(m);
      groups.set(m.provider, group);
    }

    // Добавляем пустые группы для провайдеров без моделей
    for (const p of providers) {
      if (!groups.has(p.name)) {
        groups.set(p.name, []);
      }
    }

    // Сортируем группы по имени провайдера
    const sortedProviderNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

    const result: ModelGroupResponse[] = sortedProviderNames.map((providerName) => {
      const groupModels = groups.get(providerName)!;
      const provider = providerMap.get(providerName);

      // Сортируем модели по имени
      groupModels.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      return {
        provider: {
          name: providerName,
          type: provider?.type || 'openai',
          icon: provider?.icon || '',
          defaultModel: provider?.defaultModel || '',
          currency: provider?.currency,
        },
        models: groupModels.map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          description: m.description,
          enabled: m.enabled,
          isDefault: m.isDefault || provider?.defaultModel === m.name,
          contextWindow: m.contextWindow,
          contextSource: m.contextSource || 'unknown',
          maxOutputTokens: m.maxOutputTokens,
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheReadPrice: m.cacheReadPrice,
          cacheWritePrice: m.cacheWritePrice,
          priceSource: m.priceSource,
          currency: m.currency,
        })),
      };
    });

    return c.json({ groups: result });
  });

  // POST /api/v2/models — создать/обновить модель (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const modelId = body.id?.trim() || body.name?.trim();
    if (!modelId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.idRequired', undefined, c) } }, 400);
    }

    const existing = await modelStore.load(modelId);
    const provider = body.provider || existing?.provider || '';
    const rawCurrency = body.currency;
    const currency = rawCurrency === null || rawCurrency === ''
      ? undefined
      : parseCurrency(rawCurrency) ?? existing?.currency;

    const model: ModelConfig = {
      id: modelId,
      name: body.name || existing?.name || modelId,
      provider,
      description: body.description ?? existing?.description ?? '',
      enabled: body.enabled ?? existing?.enabled ?? true,
      isDefault: body.is_default ?? body.isDefault ?? existing?.isDefault ?? false,
      contextWindow: 'context_window' in body
        ? (body.context_window ?? undefined)
        : (body.contextWindow ?? existing?.contextWindow),
      contextSource: body.context_source ?? body.contextSource ?? existing?.contextSource ?? (body.context_window ? 'manual' : 'unknown'),
      maxOutputTokens: body.max_output_tokens ?? body.maxOutputTokens ?? existing?.maxOutputTokens,
      inputPrice: body.input_price ?? body.inputPrice ?? existing?.inputPrice,
      outputPrice: body.output_price ?? body.outputPrice ?? existing?.outputPrice,
      cacheReadPrice: body.cache_read_price ?? body.cacheReadPrice ?? existing?.cacheReadPrice,
      cacheWritePrice: body.cache_write_price ?? body.cacheWritePrice ?? existing?.cacheWritePrice,
      priceSource: body.price_source ?? body.priceSource
        ?? (hasPriceInput(body) ? 'manual' : existing?.priceSource),
      currency,
    };

    await modelStore.save(modelId, model);
    modelCache.set(modelId, model);

    // Если set_as_default — обновить провайдера
    if (body.set_as_default && provider) {
      const prov = await providerStore.load(provider);
      if (prov) {
        prov.defaultModel = model.name;
        await providerStore.save(provider, prov);
        providerCache.set(provider, prov);

        // Снять isDefault с других моделей того же провайдера
        const allModels = await modelStore.list();
        for (const m of allModels) {
          if (m.provider === provider && m.id !== modelId && m.isDefault) {
            m.isDefault = false;
            await modelStore.save(m.id, m);
            modelCache.set(m.id, m);
          }
        }
      }
    }

    return c.json(model, existing ? 200 : 201);
  });

  // POST /api/v2/models/fetch — синхронизировать модели с провайдеров (admin)
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

  // DELETE /api/v2/models/:id — удалить (admin)
  app.delete('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!(await modelStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.model', undefined, c) } }, 404);
    }
    await modelStore.delete(id);
    modelCache.delete(id);
    return c.body(null, 204);
  });

  return app;
}
