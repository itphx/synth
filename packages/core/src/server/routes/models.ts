import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import { JsonStore } from '../../storage/json-store.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';

export interface ModelRoutesOptions {
  /** Виртуальные модели (например, remote-модели через LLM Proxy) — добавляются к store-моделям. */
  extraModels?: ModelConfig[];
  /** Виртуальные провайдеры (например, synth-remote) — для группировки extraModels. */
  extraProviders?: ProviderConfig[];
  /** Показывать только extraModels (политика «все LLM — через remote»). */
  onlyRemoteModels?: boolean;
}

export function createModelRoutes(
  auth: AuthKit,
  modelStore: JsonStore<ModelConfig>,
  providerStore: JsonStore<ProviderConfig>,
  opts?: ModelRoutesOptions,
): Hono {
  const app = new Hono();
  const extraModels = opts?.extraModels ?? [];
  const extraProviders = opts?.extraProviders ?? [];
  const onlyRemoteModels = opts?.onlyRemoteModels ?? false;

  app.get('/', auth.requireAuth, async (c) => {
    const filterProvider = c.req.query('provider');
    const onlyEnabled = c.req.query('enabled_only') === 'true' || c.req.query('enabled_only') === '1';

    const [storeModels, storeProviders] = await Promise.all([modelStore.list(), providerStore.list()]);

    // Слияние store + extra (без дубликатов по id). При onlyRemoteModels
    // локальные модели скрываются — остаются только remote.
    const models: ModelConfig[] = [];
    const seenModels = new Set<string>();
    for (const m of onlyRemoteModels ? extraModels : [...storeModels, ...extraModels]) {
      if (seenModels.has(m.id)) continue;
      seenModels.add(m.id);
      models.push(m);
    }

    const providers: ProviderConfig[] = [];
    const seenProviders = new Set<string>();
    for (const p of onlyRemoteModels ? extraProviders : [...storeProviders, ...extraProviders]) {
      if (seenProviders.has(p.name)) continue;
      seenProviders.add(p.name);
      providers.push(p);
    }

    const providerMap = new Map<string, ProviderConfig>();
    for (const p of providers) {
      providerMap.set(p.name, p);
    }

    const groups = new Map<string, ModelConfig[]>();
    for (const m of models) {
      if (filterProvider && m.provider !== filterProvider) continue;
      if (onlyEnabled && !m.enabled) continue;
      if (!providerMap.has(m.provider)) continue;

      const group = groups.get(m.provider) || [];
      group.push(m);
      groups.set(m.provider, group);
    }

    for (const p of providers) {
      if (!groups.has(p.name)) {
        groups.set(p.name, []);
      }
    }

    const sortedProviderNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

    const result = sortedProviderNames.map((providerName) => {
      const groupModels = groups.get(providerName)!;
      const provider = providerMap.get(providerName);
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

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const modelId = body.id?.trim() || body.name?.trim();
    if (!modelId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ID обязателен' } }, 400);
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
      contextWindow: 'context_window' in body
        ? (body.context_window ?? undefined)
        : (body.contextWindow ?? existing?.contextWindow),
      contextSource: body.context_source ?? body.contextSource ?? existing?.contextSource ?? (body.context_window ? 'manual' : 'unknown'),
      maxOutputTokens: body.max_output_tokens ?? body.maxOutputTokens ?? existing?.maxOutputTokens,
      inputPrice: body.input_price ?? body.inputPrice ?? existing?.inputPrice,
      outputPrice: body.output_price ?? body.outputPrice ?? existing?.outputPrice,
      cacheReadPrice: body.cache_read_price ?? body.cacheReadPrice ?? existing?.cacheReadPrice,
      cacheWritePrice: body.cache_write_price ?? body.cacheWritePrice ?? existing?.cacheWritePrice,
    };

    await modelStore.save(modelId, model);
    return c.json(model, existing ? 200 : 201);
  });

  app.delete('/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (!(await modelStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Модель не найдена' } }, 404);
    }
    await modelStore.delete(id);
    return c.body(null, 204);
  });

  return app;
}
