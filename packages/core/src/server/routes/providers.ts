import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { JsonStoreLike } from '../../storage/json-store.js';
import type { EgressPolicy, ProviderConfig } from '@itphx/synth-shared';
import type { DefaultModelPair } from '../../storage/runtime-settings.js';
import { parseCurrencyInput, parseModelCompatibilityInput, renderIcon } from '@itphx/synth-shared';
import {
  PRIVATE_EGRESS_POLICY,
  checkEgressUrl,
  fetchWithEgressGuard,
  sanitizeEgressTarget,
  type EgressLogSink,
} from '../../engine/net/egress-guard.js';
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
  /** Фавикон домена не найден (в т.ч. адрес заблокирован egress-политикой). */
  faviconNotFound: (c: Context) => string;
  /** Ошибка загрузки фавикона. */
  faviconFetchError: (c: Context) => string;
}

/**
 * Опции `POST /api/v2/providers/fetch-icon` (ADR-099/PROP-100).
 *
 * Маршрут включается явно (`enabled: true`): в managed — всегда, в core —
 * по решению сборки. Guard и rate-limit — на стороне вызывающего (managed:
 * ADMIN + лимит 10/60 с; core: локальный пользователь всегда ADMIN).
 */
export interface ProviderFetchIconOptions {
  /** Включить маршрут. По умолчанию — выключен. */
  enabled?: boolean;
  /** Guard на маршрут (managed — requireAdmin; core — requireAuth). */
  guard?: Middleware;
  /** Доп. middleware (rate limiter) — применяются после guard'а. */
  middleware?: Middleware[];
  /** Живой резолвер egress-политики `egress.tools` (per-request). */
  resolvePolicy?: () => Promise<EgressPolicy>;
  /** Приёмник журнала внешних запросов (scope `providers`). */
  log?: EgressLogSink;
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
   * `POST /fetch-icon` — получить фавикон домена провайдера.
   * Не задано — маршрут не регистрируется (core по умолчанию выключает).
   */
  fetchIcon?: ProviderFetchIconOptions;
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
  faviconNotFound: () => 'Favicon не найден',
  faviconFetchError: () => 'Ошибка получения favicon',
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

  // POST /api/v2/providers/fetch-icon — получить favicon с домена.
  // Статический сегмент регистрируем ДО параметрических (`/:name`).
  const fetchIcon = opts.fetchIcon;
  if (fetchIcon?.enabled) {
    const iconGuard = fetchIcon.guard ?? auth.requireAuth;
    app.post('/fetch-icon', iconGuard, ...(fetchIcon.middleware ?? []), async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const url = body.url?.trim();
      if (!url) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: messages.urlRequired(c) },
        }, 400);
      }

      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: messages.urlInvalid(c) },
        }, 400);
      }

      // SSRF-защита: resolved egress-политика (включая exceptions и DNS-резолв).
      const policy = fetchIcon.resolvePolicy ? await fetchIcon.resolvePolicy() : PRIVATE_EGRESS_POLICY;
      const networkCheck = await checkEgressUrl(origin, policy);
      if (!networkCheck.allowed) {
        // Отказ до HTTP-запроса — фиксируем в журнале egress (ответ остаётся 400).
        if (fetchIcon.log) {
          const target = sanitizeEgressTarget(origin);
          try {
            await fetchIcon.log({
              scope: 'providers',
              host: target.host,
              url: target.url,
              method: 'GET',
              status: 'blocked',
              reason: networkCheck.reason,
              ...(networkCheck.matchedRule ? { matchedRule: networkCheck.matchedRule } : {}),
            });
          } catch (err) {
            console.warn(`[providers] egress log: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: messages.urlInvalid(c) },
        }, 400);
      }

      try {
        const iconUrl = `${origin}/favicon.ico`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);

        const resp = await fetchWithEgressGuard(iconUrl, {
          signal: controller.signal,
          headers: { Accept: 'image/*' },
        }, { policy, scope: 'providers', log: fetchIcon.log });
        clearTimeout(timer);

        if (resp.ok && resp.headers.get('content-type')?.includes('image')) {
          const buffer = await resp.arrayBuffer();
          const ct = resp.headers.get('content-type') || 'image/x-icon';
          const b64 = Buffer.from(buffer).toString('base64');
          return c.json({ icon: `data:${ct};base64,${b64}`, source: iconUrl });
        }

        // Попробовать найти <link rel="icon"> в HTML
        const htmlController = new AbortController();
        const htmlTimer = setTimeout(() => htmlController.abort(), 5000);

        const htmlResp = await fetchWithEgressGuard(origin, {
          signal: htmlController.signal,
          headers: { Accept: 'text/html' },
        }, { policy, scope: 'providers', log: fetchIcon.log });
        clearTimeout(htmlTimer);

        if (htmlResp.ok) {
          const html = await htmlResp.text();
          const match = html.match(/<link[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i)
            || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i);

          if (match) {
            const href = match[1];
            if (href) {
              let resolved = href;
              if (resolved.startsWith('/')) resolved = `${origin}${resolved}`;
              else if (!resolved.startsWith('http')) resolved = `${origin}/${resolved}`;

              const iconResp = await fetchWithEgressGuard(resolved, {
                signal: AbortSignal.timeout(5000),
                headers: { Accept: 'image/*' },
              }, { policy, scope: 'providers', log: fetchIcon.log });
              if (iconResp.ok) {
                const buffer = await iconResp.arrayBuffer();
                const ct = iconResp.headers.get('content-type') || 'image/x-icon';
                const b64 = Buffer.from(buffer).toString('base64');
                return c.json({ icon: `data:${ct};base64,${b64}`, source: resolved });
              }
            }
          }
        }

        return c.json({ icon: null, error: messages.faviconNotFound(c) });
      } catch (err) {
        return c.json({
          icon: null,
          error: err instanceof Error ? err.message : messages.faviconFetchError(c),
        });
      }
    });
  }

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
        ...(p.compatibility ? { compatibility: p.compatibility } : {}),
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
    // Совместимость протокола: объект — **замена** целиком (UI присылает полный
    // объект из черновика), `null`/пустой объект — сброс, поле отсутствует —
    // без изменений (при upsert сохраняется прежнее значение); неизвестные
    // поля/неверные типы → 400, чтобы опечатка не терялась молча.
    const parsedCompatibility = parseModelCompatibilityInput(body.compatibility, existing?.compatibility);
    if (!parsedCompatibility.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedCompatibility.reason } }, 400);
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
      ...(parsedCompatibility.value ? { compatibility: parsedCompatibility.value } : {}),
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
    // Совместимость: объект — замена целиком, `null`/пустой объект — сброс,
    // поле не передано — без изменений.
    const parsedCompatibility = parseModelCompatibilityInput(body.compatibility, existing.compatibility);
    if (!parsedCompatibility.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedCompatibility.reason } }, 400);
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
      ...(parsedCompatibility.value ? { compatibility: parsedCompatibility.value } : { compatibility: undefined }),
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
          compatibility: provider.compatibility,
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
