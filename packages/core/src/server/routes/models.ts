import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { JsonStoreLike } from '../../storage/json-store.js';
import type { ModelConfig, ProviderConfig } from '@itphx/synth-shared';
import { hasPriceInput, parseCurrencyInput } from '@itphx/synth-shared';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно, как в dictionaries.ts). */
export interface ModelRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface ModelRouteMessages {
  idRequired: (c: Context) => string;
  modelNotFound: (c: Context) => string;
}

export interface ModelRoutesOptions {
  /** Виртуальные модели (например, remote-модели через LLM Proxy) — добавляются к store-моделям. */
  extraModels?: ModelConfig[] | (() => ModelConfig[]);
  /** Виртуальные провайдеры (например, remote-зеркала серверных провайдеров) — для группировки extraModels. */
  extraProviders?: ProviderConfig[] | (() => ProviderConfig[]);
  /** Показывать только extraModels (политика «все LLM — через remote»). */
  onlyRemoteModels?: boolean | (() => boolean);
  /** Guard для POST / и DELETE /:id (backend — requireAdmin, core — requireAuth). */
  writeGuard?: Middleware;
  /** Кеш провайдеров: нужен для set_as_default (обновление provider.defaultModel). */
  providerCache?: Map<string, ProviderConfig>;
  /** Поддержать `set_as_default` в POST / (backend; в core выключено). */
  supportSetAsDefault?: boolean;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<ModelRouteMessages>;
}

const DEFAULT_MESSAGES: ModelRouteMessages = {
  idRequired: () => 'ID обязателен',
  modelNotFound: () => 'Модель не найдена',
};

/** Гибрид подключается в рантайме — опции могут быть геттерами текущего состояния. */
function resolveOpt<T>(value: T | (() => T) | undefined, fallback: T): T {
  if (typeof value === 'function') return (value as () => T)();
  return value ?? fallback;
}

export function createModelRoutes(
  auth: ModelRoutesAuth,
  modelStore: JsonStoreLike<ModelConfig>,
  providerStore: JsonStoreLike<ProviderConfig>,
  modelCache: Map<string, ModelConfig>,
  opts?: ModelRoutesOptions,
): Hono {
  const app = new Hono();
  const extraModels = opts?.extraModels ?? [];
  const extraProviders = opts?.extraProviders ?? [];
  const onlyRemoteModels = opts?.onlyRemoteModels ?? false;
  const writeGuard = opts?.writeGuard ?? auth.requireAuth;
  const providerCache = opts?.providerCache;
  const supportSetAsDefault = opts?.supportSetAsDefault ?? false;
  const messages: ModelRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };

  app.get('/', auth.requireAuth, async (c) => {
    const filterProvider = c.req.query('provider');
    const onlyEnabled = c.req.query('enabled_only') === 'true' || c.req.query('enabled_only') === '1';

    // Гибрид runtime: extra-модели/провайдеры читаются на каждый запрос.
    const effExtraModels = resolveOpt<ModelConfig[]>(extraModels, []);
    const effExtraProviders = resolveOpt<ProviderConfig[]>(extraProviders, []);
    const effOnlyRemoteModels = resolveOpt<boolean>(onlyRemoteModels, false);

    const [storeModels, storeProviders] = await Promise.all([modelStore.list(), providerStore.list()]);

    // Слияние store + extra (без дубликатов по id). При onlyRemoteModels
    // локальные модели скрываются — остаются только remote.
    const models: ModelConfig[] = [];
    const seenModels = new Set<string>();
    for (const m of effOnlyRemoteModels ? effExtraModels : [...storeModels, ...effExtraModels]) {
      if (seenModels.has(m.id)) continue;
      seenModels.add(m.id);
      models.push(m);
    }

    const providers: ProviderConfig[] = [];
    const seenProviders = new Set<string>();
    for (const p of effOnlyRemoteModels ? effExtraProviders : [...storeProviders, ...effExtraProviders]) {
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

  app.post('/', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const modelId = body.id?.trim() || body.name?.trim();
    if (!modelId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.idRequired(c) } }, 400);
    }

    const existing = await modelStore.load(modelId);
    const provider = body.provider || existing?.provider || '';
    const resolvedCurrency = parseCurrencyInput(body.currency, existing?.currency);
    if (!resolvedCurrency.ok) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'currency должен быть одним из: RUB, USD, CNY' },
      }, 400);
    }
    const currency = resolvedCurrency.currency;

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

    // set_as_default (backend): обновить провайдера и снять isDefault с остальных моделей.
    if (supportSetAsDefault && providerCache && body.set_as_default && provider) {
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

  app.delete('/:id', writeGuard, async (c) => {
    const id = c.req.param('id');
    if (!(await modelStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.modelNotFound(c) } }, 404);
    }
    await modelStore.delete(id);
    modelCache.delete(id);
    return c.body(null, 204);
  });

  return app;
}
