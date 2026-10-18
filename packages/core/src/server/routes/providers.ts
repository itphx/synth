import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { JsonStoreLike } from '../../storage/json-store.js';
import type { ProviderConfig } from '@itphx/synth-shared';
import type { DefaultModelPair } from '../../storage/runtime-settings.js';
import { parseCurrencyInput, renderIcon } from '@itphx/synth-shared';
import { ProviderFactory } from '../../index.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно, как в dictionaries.ts). */
export interface ProviderRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface ProviderRouteMessages {
  nameRequired: (c: Context) => string;
  providerNotFound: (c: Context) => string;
  providerDisabled: (c: Context) => string;
  urlRequired: (c: Context) => string;
  /** URL задан, но не является абсолютным http(s). */
  urlInvalid: (c: Context) => string;
  connectionError: (c: Context) => string;
  /** `num_ctx`/`numCtx` задан, но не целое > 0. */
  numCtxInvalid: (c: Context) => string;
}

/** Первое заданное (не `undefined`) значение — для алиасов входных полей. */
function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

/**
 * Разбор `num_ctx`/`numCtx` (размер контекста Ollama): `undefined` — не задано
 * (сохранить existing); `null`/`''` — явно очистить; целое > 0 — принять;
 * иное — ошибка (`ok: false`).
 */
function parseNumCtx(raw: unknown): { ok: true; defined: boolean; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true, defined: false };
  if (raw === null || raw === '') return { ok: true, defined: true, value: undefined };
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num) || num <= 0) return { ok: false };
  return { ok: true, defined: true, value: num };
}

/** Абсолютный http(s)-URL (обязательное требование к baseUrl провайдера). */
function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ProviderRoutesOptions {
  /** Guard для POST / и DELETE /:name (backend — requireAdmin, core — requireAuth). */
  writeGuard?: Middleware;
  /** Guard для GET /:name (backend — requireAdmin, core — requireAuth). */
  detailGuard?: Middleware;
  /** Регистрировать POST /:name/test (проверка подключения). */
  testEnabled?: boolean;
  /** Guard для POST /:name/test (по умолчанию auth.requireAuth). */
  testGuard?: Middleware;
  /** Доп. middleware для POST /:name/test (например, rate limiter), в порядке применения. */
  testMiddleware?: Middleware[];
  /**
   * Модель по умолчанию инстанса (явная пара provider+model) — из неё берутся
   * `is_default`/`default_provider` в GET `/`. Не задан/`null` — дефолтного
   * провайдера нет (никаких «первый по порядку»).
   */
  getDefaultModel?: () => DefaultModelPair | null | Promise<DefaultModelPair | null>;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<ProviderRouteMessages>;
}

const DEFAULT_MESSAGES: ProviderRouteMessages = {
  nameRequired: () => 'Имя обязательно',
  providerNotFound: () => 'Провайдер не найден',
  providerDisabled: () => 'Провайдер отключён',
  urlRequired: () => 'URL обязателен',
  urlInvalid: () => 'URL обязателен и должен быть абсолютным http(s)',
  connectionError: () => 'Ошибка подключения',
  numCtxInvalid: () => 'num_ctx должен быть целым числом > 0',
};

/**
 * API провайдеров (ADR-005/ADR-017). Общая реализация для core (standalone) и
 * backend (managed): отличается только guard'ами (core — requireAuth, backend —
 * requireAdmin) и текстами (core — литералы, backend — t()).
 */
export function createProviderRoutes(
  auth: ProviderRoutesAuth,
  store: JsonStoreLike<ProviderConfig>,
  providerCache: Map<string, ProviderConfig>,
  opts: ProviderRoutesOptions = {},
): Hono {
  const app = new Hono();
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const detailGuard = opts.detailGuard ?? auth.requireAuth;
  const testGuard = opts.testGuard ?? auth.requireAuth;
  const testMiddleware = opts.testMiddleware ?? [];
  const messages: ProviderRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  app.get('/', auth.requireAuth, async (c) => {
    const providers = await store.list();
    // Модель по умолчанию — явная пара provider+model (runtime-настройка или
    // config-fallback), а не «первый провайдер в каталоге».
    const pair = opts.getDefaultModel ? await opts.getDefaultModel() : null;
    const defaultProviderName = pair?.provider ?? '';
    return c.json({
      providers: providers.map((p) => ({
        name: p.name,
        type: p.type,
        url: p.baseUrl || '',
        model: p.defaultModel || '',
        enabled: p.enabled !== false,
        is_default: pair?.provider === p.name,
        currency: p.currency,
        num_ctx: p.numCtx,
        ...renderIcon(p.icon, p.baseUrl),
      })),
      default_provider: defaultProviderName,
    });
  });

  app.post('/', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.nameRequired(c) } }, 400);
    }

    const existing = await store.load(name);
    const resolvedCurrency = parseCurrencyInput(body.currency, existing?.currency);
    if (!resolvedCurrency.ok) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'currency должен быть одним из: RUB, USD, CNY' },
      }, 400);
    }
    // Поля принимаются в обоих наборах имён: snake_case (`base_url`/`default_model`/
    // `api_key` — то, что шлёт UI) и короткие/camelCase (`url`/`model`/`apiKey` —
    // то, что отдаёт GET). Иначе «создание по образцу GET» молча писало пустой URL.
    const baseUrl = firstDefined(body.base_url, body.baseUrl, body.url, existing?.baseUrl);
    if (!isAbsoluteHttpUrl(baseUrl)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.urlInvalid(c) } }, 400);
    }
    const apiKey = firstDefined(body.api_key, body.apiKey, existing?.apiKey);
    const defaultModel = firstDefined(
      body.default_model, body.defaultModel, body.model, existing?.defaultModel,
    );
    const parsedNumCtx = parseNumCtx(firstDefined(body.num_ctx, body.numCtx));
    if (!parsedNumCtx.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.numCtxInvalid(c) } }, 400);
    }
    const provider: ProviderConfig = {
      name,
      type: body.type || existing?.type || 'openai',
      baseUrl,
      apiKey: typeof apiKey === 'string' ? apiKey : undefined,
      defaultModel: typeof defaultModel === 'string' ? defaultModel : undefined,
      timeout: body.timeout ?? existing?.timeout ?? 120,
      enabled: body.enabled ?? existing?.enabled ?? true,
      icon: body.icon !== undefined ? body.icon : (existing?.icon ?? ''),
      currency: resolvedCurrency.currency,
      numCtx: parsedNumCtx.defined ? parsedNumCtx.value : existing?.numCtx,
    };
    await store.save(name, provider);
    providerCache.set(name, provider);
    return c.json(provider, existing ? 200 : 201);
  });

  // PATCH /:name — частичное обновление (те же алиасы полей и валидация URL).
  app.patch('/:name', writeGuard, async (c) => {
    const name = c.req.param('name');
    const existing = await store.load(name);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.providerNotFound(c) } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const resolvedCurrency = parseCurrencyInput(body.currency, existing.currency);
    if (!resolvedCurrency.ok) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'currency должен быть одним из: RUB, USD, CNY' },
      }, 400);
    }
    const baseUrl = firstDefined(body.base_url, body.baseUrl, body.url, existing.baseUrl);
    if (!isAbsoluteHttpUrl(baseUrl)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.urlInvalid(c) } }, 400);
    }
    const apiKey = firstDefined(body.api_key, body.apiKey, existing.apiKey);
    const defaultModel = firstDefined(
      body.default_model, body.defaultModel, body.model, existing.defaultModel,
    );
    const parsedNumCtx = parseNumCtx(firstDefined(body.num_ctx, body.numCtx));
    if (!parsedNumCtx.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.numCtxInvalid(c) } }, 400);
    }
    const provider: ProviderConfig = {
      ...existing,
      type: body.type || existing.type,
      baseUrl,
      apiKey: typeof apiKey === 'string' ? apiKey : undefined,
      defaultModel: typeof defaultModel === 'string' ? defaultModel : undefined,
      timeout: body.timeout ?? existing.timeout,
      enabled: body.enabled ?? existing.enabled,
      icon: body.icon !== undefined ? body.icon : existing.icon,
      currency: resolvedCurrency.currency,
      numCtx: parsedNumCtx.defined ? parsedNumCtx.value : existing.numCtx,
    };
    await store.save(name, provider);
    providerCache.set(name, provider);
    return c.json(provider, 200);
  });

  app.delete('/:name', writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!(await store.exists(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.providerNotFound(c) } }, 404);
    }
    await store.delete(name);
    providerCache.delete(name);
    return c.body(null, 204);
  });

  app.get('/:name', detailGuard, async (c) => {
    const provider = await store.load(c.req.param('name'));
    if (!provider) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.providerNotFound(c) } }, 404);
    }
    return c.json({
      ...provider,
      apiKey: provider.apiKey ? `${provider.apiKey.slice(0, 3)}...${provider.apiKey.slice(-4)}` : '',
    });
  });

  if (opts.testEnabled) {
    // Guard и middleware применяются по порядку. app.post принимает только
    // фиксированные наборы хендлеров, поэтому middleware вешаем через app.use
    // (use(path, mw) матчит ровно этот путь, без затекания на /:name).
    app.use('/:name/test', testGuard);
    for (const mw of testMiddleware) {
      app.use('/:name/test', mw);
    }

    app.post('/:name/test', async (c) => {
      const provider = await store.load(c.req.param('name'));
      if (!provider) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.providerNotFound(c) } }, 404);
      }
      if (provider.enabled === false) {
        return c.json({ status: 'disabled', message: messages.providerDisabled(c) });
      }
      if (!provider.baseUrl) {
        return c.json({ status: 'error', error: messages.urlRequired(c) }, 400);
      }

      try {
        const instance = ProviderFactory.create(provider.name, {
          type: provider.type,
          name: provider.name,
          url: provider.baseUrl,
          apiKey: provider.apiKey || '',
          model: provider.defaultModel || '',
          timeout: 30,
          numCtx: provider.numCtx,
        });
        const models = await instance.listModels();
        return c.json({
          status: 'ok',
          provider: provider.name,
          type: instance.type,
          url: instance.url,
          model: instance.model,
          models_count: models.length,
          models,
        });
      } catch (err) {
        return c.json({
          status: 'error',
          error: err instanceof Error ? err.message : messages.connectionError(c),
        });
      }
    });
  }

  return app;
}
