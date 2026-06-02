import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { ModelConfig, ProviderConfig, ContextSource } from '@synth/shared';
import { lookupContextWindow } from '@synth/shared';
import { ProviderFactory } from '@synth/core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

interface ModelGroupResponse {
  provider: {
    name: string;
    type: string;
    icon: string;
    defaultModel: string;
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
  }>;
}

export function createModelRoutes(kit: AuthKit, modelStore: JsonStore<ModelConfig>, providerStore: JsonStore<ProviderConfig>): Hono {
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

    const model: ModelConfig = {
      id: modelId,
      name: body.name || existing?.name || modelId,
      provider,
      description: body.description ?? existing?.description ?? '',
      enabled: body.enabled ?? existing?.enabled ?? true,
      isDefault: body.is_default ?? body.isDefault ?? existing?.isDefault ?? false,
      contextWindow: body.context_window ?? body.contextWindow ?? existing?.contextWindow,
      contextSource: body.context_source ?? body.contextSource ?? existing?.contextSource ?? (body.context_window ? 'manual' : 'unknown'),
      maxOutputTokens: body.max_output_tokens ?? body.maxOutputTokens ?? existing?.maxOutputTokens,
      inputPrice: body.input_price ?? body.inputPrice ?? existing?.inputPrice,
      outputPrice: body.output_price ?? body.outputPrice ?? existing?.outputPrice,
      cacheReadPrice: body.cache_read_price ?? body.cacheReadPrice ?? existing?.cacheReadPrice,
      cacheWritePrice: body.cache_write_price ?? body.cacheWritePrice ?? existing?.cacheWritePrice,
    };

    await modelStore.save(modelId, model);

    // Если set_as_default — обновить провайдера
    if (body.set_as_default && provider) {
      const prov = await providerStore.load(provider);
      if (prov) {
        prov.defaultModel = model.name;
        await providerStore.save(provider, prov);

        // Снять isDefault с других моделей того же провайдера
        const allModels = await modelStore.list();
        for (const m of allModels) {
          if (m.provider === provider && m.id !== modelId && m.isDefault) {
            m.isDefault = false;
            await modelStore.save(m.id, m);
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
    const errors: string[] = [];

    for (const provider of enabledProviders) {
      const providerConfig = {
        type: provider.type,
        name: provider.name,
        url: provider.baseUrl || '',
        apiKey: provider.apiKey || '',
        model: provider.defaultModel || '',
        timeout: 30,
      };

      if (!providerConfig.url) continue;

      try {
        const instance = ProviderFactory.create(provider.name, providerConfig);
        const modelIds = await instance.listModels();

        for (const modelId of modelIds) {
          const fullId = `${provider.name}/${modelId}`;
          const existing = await modelStore.load(fullId);
          const { window, source } = lookupContextWindow(modelId);

          if (!existing) {
            // Новая модель
            await modelStore.save(fullId, {
              id: fullId,
              name: modelId,
              provider: provider.name,
              description: '',
              enabled: true,
              isDefault: false,
              contextWindow: window,
              contextSource: source !== 'unknown' ? source : 'unknown',
            });
            totalNew++;
            totalFetched++;
          } else if ((existing.contextWindow ?? 0) === 0 && window > 0) {
            // Обогащаем существующую модель справочными данными
            existing.contextWindow = window;
            existing.contextSource = source;
            await modelStore.save(fullId, existing);
            totalEnriched++;
            totalFetched++;
          } else {
            totalFetched++;
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
    return c.body(null, 204);
  });

  return app;
}
