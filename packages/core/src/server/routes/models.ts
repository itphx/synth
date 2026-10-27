import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { JsonStoreLike } from '../../storage/json-store.js';
import type { ModelConfig, ProviderConfig, ContextSource, AttachmentModality } from '@itphx/synth-shared';
import type { DefaultModelPair } from '../../storage/runtime-settings.js';
import { hasPriceInput, lookupContextWindow, parseCurrencyInput, resolveModelModalities } from '@itphx/synth-shared';
import { ProviderFactory } from '../../providers/index.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

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

/** Пары snake_case/camelCase для ценовых полей модели. */
const PRICE_FIELDS = [
  ['input_price', 'inputPrice'],
  ['output_price', 'outputPrice'],
  ['cache_read_price', 'cacheReadPrice'],
  ['cache_write_price', 'cacheWritePrice'],
] as const;

/**
 * Значение ценового поля из body с явным null-контрактом:
 * - поле не передано → сохранить existing;
 * - `null` → очистить (undefined);
 * - значение → записать.
 *
 * UI очищает поле ввода, отправляя `null`; `undefined` в JSON исчезает и
 * раньше оставлял старую цену (баг «очистка не сбрасывает цену»).
 */
function resolvePriceField(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
  existing: number | undefined,
): number | undefined {
  const key = snake in body ? snake : (camel in body ? camel : null);
  if (!key) return existing;
  const raw = body[key];
  if (raw === null) return undefined;
  if (raw === undefined) return existing;
  return raw as number;
}

/** Есть ли в body хотя бы одно непустое ценовое значение (ручной ввод). */
function hasConcretePriceInput(body: Record<string, unknown>): boolean {
  return PRICE_FIELDS.some(([snake, camel]) => {
    const key = snake in body ? snake : (camel in body ? camel : null);
    if (!key) return false;
    const raw = body[key];
    return raw !== null && raw !== undefined;
  });
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

/** Известные модальности вложения (ADR-115). */
const ATTACHMENT_MODALITIES: readonly AttachmentModality[] = ['text', 'image', 'pdf', 'audio', 'video'];

/**
 * ADR-115: модальности из тела запроса модели (ручной override).
 *
 * - поле не передано → сохранить существующее значение;
 * - `null` → сбросить (модальности снова берутся из справочника);
 * - массив → отфильтровать до известных значений и дедуплицировать.
 */
function resolveModalitiesInput(
  raw: unknown,
  existing?: AttachmentModality[],
): AttachmentModality[] | undefined {
  if (raw === null) return undefined;
  if (raw === undefined) return existing;
  if (!Array.isArray(raw)) return existing;

  const result: AttachmentModality[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim().toLowerCase() as AttachmentModality;
    if (!ATTACHMENT_MODALITIES.includes(value) || result.includes(value)) continue;
    result.push(value);
  }
  return result.length > 0 ? result : undefined;
}

/** Совпадают ли наборы модальностей (порядок не важен). */
function sameModalities(
  a: readonly AttachmentModality[] | undefined,
  b: readonly AttachmentModality[] | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((modality) => set.has(modality));
}

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно, как в dictionaries.ts). */
export interface ModelRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface ModelRouteMessages {
  idRequired: (c: Context) => string;
  modelNotFound: (c: Context) => string;
  fetchError: (c: Context) => string;
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
  /** Guard для POST /fetch (backend — requireAdmin, core — requireAuth). */
  fetchGuard?: Middleware;
  /** Доп. middleware для POST /fetch (например, rate limiter), в порядке применения. */
  fetchMiddleware?: Middleware[];
  /** Кеш провайдеров: нужен для set_as_default (обновление provider.defaultModel). */
  providerCache?: Map<string, ProviderConfig>;
  /** Поддержать `set_as_default` в POST / (core и backend; в core включено с явной runtime-парой). */
  supportSetAsDefault?: boolean;
  /**
   * Модель по умолчанию инстанса (явная пара provider+model). Задана —
   * `isDefault` в GET `/` вычисляется только по ней; не задана — legacy-поведение
   * (`ModelConfig.isDefault` / `provider.defaultModel`), чтобы не ломать
   * существующие инсталляции.
   */
  getDefaultModel?: () => DefaultModelPair | null | Promise<DefaultModelPair | null>;
  /** Записать модель по умолчанию (POST `/` с `set_as_default: true`). */
  setDefaultModel?: (pair: DefaultModelPair) => void | Promise<void>;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<ModelRouteMessages>;
}

const DEFAULT_MESSAGES: ModelRouteMessages = {
  idRequired: () => 'ID обязателен',
  modelNotFound: () => 'Модель не найдена',
  fetchError: () => 'Ошибка',
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
  const fetchGuard = opts?.fetchGuard ?? auth.requireAuth;
  const fetchMiddleware = opts?.fetchMiddleware ?? [];
  const providerCache = opts?.providerCache;
  const supportSetAsDefault = opts?.supportSetAsDefault ?? false;
  const getDefaultModel = opts?.getDefaultModel;
  const setDefaultModel = opts?.setDefaultModel;
  const messages: ModelRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };

  // POST /fetch — синхронизировать модели с провайдеров (id конфигурируются
  // провайдером). Статический сегмент объявляем до параметрических (/:id).
  // Guard и middleware — через app.use (app.post принимает фиксированные
  // наборы хендлеров).
  app.use('/fetch', fetchGuard);
  for (const mw of fetchMiddleware) {
    app.use('/fetch', mw);
  }

  app.post('/fetch', async (c) => {
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
        numCtx: provider.numCtx,
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
          // ADR-115: модальности входа, если каталог провайдера их сообщает.
          const apiModalities = model.modalities && model.modalities.length > 0
            ? model.modalities
            : undefined;

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
            // ADR-115: модальности из каталога провайдера — в конфиг модели.
            if (apiModalities) {
              newModel.modalities = [...apiModalities];
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

          // Модальности (ADR-115): приоритет API — как у окна контекста. Ручное
          // значение не затираем, когда API модальности не сообщает; обновляем,
          // только если набор отличается.
          if (apiModalities && !sameModalities(existing.modalities, apiModalities)) {
            existing.modalities = [...apiModalities];
            changed = true;
          }

          totalFetched++;
          if (changed) {
            await modelStore.save(fullId, existing);
            modelCache.set(fullId, existing);
          }
        }
      } catch (err) {
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : messages.fetchError(c)}`);
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

    // Модель по умолчанию — явная пара provider+model (runtime-настройка или
    // config-fallback). Не задана — legacy-поведение (`isDefault` модели /
    // `provider.defaultModel`), чтобы не ломать существующие инсталляции.
    const defaultPair = getDefaultModel ? await getDefaultModel() : null;

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
          isDefault: defaultPair
            ? m.provider === defaultPair.provider && m.name === defaultPair.model
            : (m.isDefault || provider?.defaultModel === m.name),
          contextWindow: m.contextWindow,
          contextSource: m.contextSource || 'unknown',
          maxOutputTokens: m.maxOutputTokens,
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheReadPrice: m.cacheReadPrice,
          cacheWritePrice: m.cacheWritePrice,
          priceSource: m.priceSource,
          currency: m.currency,
          /**
           * ADR-115: модальности входа модели (какие вложения она принимает).
           * Конфиг модели (каталог провайдера / ручной override) приоритетнее
           * справочника; неизвестная модель → консервативно `['text']`.
           */
          modalities: m.modalities ?? resolveModelModalities(m.provider, m.name),
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

    const inputPrice = resolvePriceField(body, 'input_price', 'inputPrice', existing?.inputPrice);
    const outputPrice = resolvePriceField(body, 'output_price', 'outputPrice', existing?.outputPrice);
    const cacheReadPrice = resolvePriceField(body, 'cache_read_price', 'cacheReadPrice', existing?.cacheReadPrice);
    const cacheWritePrice = resolvePriceField(body, 'cache_write_price', 'cacheWritePrice', existing?.cacheWritePrice);

    // `price_source: null` — явно сбросить источник. Иначе: ручной ввод цены
    // помечает manual; очистка последней цены сбрасывает источник; очистка
    // одного поля при остальных ценах источник не трогает.
    const explicitSource = 'price_source' in body
      ? body.price_source
      : ('priceSource' in body ? body.priceSource : undefined);
    const hasAnyPriceValue = inputPrice !== undefined
      || outputPrice !== undefined
      || cacheReadPrice !== undefined
      || cacheWritePrice !== undefined;
    const priceSource: ModelConfig['priceSource'] = explicitSource !== undefined
      ? (explicitSource === null ? undefined : explicitSource)
      : (hasPriceInput(body) && !hasAnyPriceValue)
        ? undefined
        : (hasConcretePriceInput(body) ? 'manual' : existing?.priceSource);

    // ADR-115: модальности модели — ручной override (аддитивно к каталогу API).
    const modalities = resolveModalitiesInput(body.modalities, existing?.modalities);

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
      inputPrice,
      outputPrice,
      cacheReadPrice,
      cacheWritePrice,
      priceSource,
      currency,
      ...(modalities ? { modalities } : {}),
    };

    await modelStore.save(modelId, model);
    modelCache.set(modelId, model);

    // set_as_default: обновить провайдера (legacy) и снять isDefault с остальных
    // моделей, затем записать явную пару provider+model в runtime-настройки —
    // только если провайдер реально существует.
    if (supportSetAsDefault && body.set_as_default && provider) {
      const prov = await providerStore.load(provider);
      if (prov) {
        prov.defaultModel = model.name;
        await providerStore.save(provider, prov);
        providerCache?.set(provider, prov);

        // Снять isDefault с других моделей того же провайдера
        const allModels = await modelStore.list();
        for (const m of allModels) {
          if (m.provider === provider && m.id !== modelId && m.isDefault) {
            m.isDefault = false;
            await modelStore.save(m.id, m);
            modelCache.set(m.id, m);
          }
        }

        await setDefaultModel?.({ provider, model: model.name });
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
