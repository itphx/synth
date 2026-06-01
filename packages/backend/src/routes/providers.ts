import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { ProviderConfig } from '@synth/shared';
import { ProviderFactory } from '@synth/core';
import { t } from '../lib/i18n.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';

function getFaviconUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const origin = new URL(baseUrl).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function renderIcon(icon?: string, baseUrl?: string): { icon: string; icon_url?: string } {
  if (icon) return { icon };
  const fav = getFaviconUrl(baseUrl);
  return { icon: '', icon_url: fav };
}

const INTERNAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
]);

const INTERNAL_CIDR_PATTERNS = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^fe80:/i,
];

function isInternalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    const hostname = u.hostname.toLowerCase();
    if (INTERNAL_HOSTS.has(hostname)) return true;
    if (hostname === '[::1]') return true;
    for (const pattern of INTERNAL_CIDR_PATTERNS) {
      if (pattern.test(hostname)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function createProviderRoutes(kit: AuthKit, store: JsonStore<ProviderConfig>): Hono {
  const app = new Hono();

  // GET /api/v2/providers — список провайдеров
  app.get('/', kit.requireAuth, async (c) => {
    const providers = await store.list();
    const defaultProvider = providers.find((p) => !p.name.startsWith('__'));
    return c.json({
      providers: providers.map((p) => ({
        name: p.name,
        type: p.type,
        url: p.baseUrl || '',
        model: p.defaultModel || '',
        enabled: p.enabled !== false,
        is_default: p === defaultProvider,
        ...renderIcon(p.icon, p.baseUrl),
      })),
      default_provider: defaultProvider?.name || '',
    });
  });

  // POST /api/v2/providers — создать/обновить провайдера (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.nameRequired', undefined, c) } }, 400);
    }

    const existing = await store.load(name);
    const provider: ProviderConfig = {
      name,
      type: body.type || existing?.type || 'openai',
      baseUrl: body.base_url ?? body.baseUrl ?? existing?.baseUrl,
      apiKey: body.api_key ?? body.apiKey ?? existing?.apiKey,
      defaultModel: body.default_model ?? body.defaultModel ?? existing?.defaultModel,
      timeout: body.timeout ?? existing?.timeout ?? 120,
      enabled: body.enabled ?? existing?.enabled ?? true,
      icon: body.icon !== undefined ? body.icon : (existing?.icon ?? ''),
    };
    await store.save(name, provider);
    return c.json(provider, existing ? 200 : 201);
  });

  // DELETE /api/v2/providers/:name — удалить (admin)
  app.delete('/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    if (!(await store.exists(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.provider', undefined, c) } }, 404);
    }
    await store.delete(name);
    return c.body(null, 204);
  });

  // GET /api/v2/providers/:name — получить одного (apiKey маскирован)
  app.get('/:name', kit.requireAdmin, async (c) => {
    const provider = await store.load(c.req.param('name'));
    if (!provider) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.provider', undefined, c) } }, 404);
    }
    return c.json({
      ...provider,
      apiKey: provider.apiKey ? `${provider.apiKey.slice(0, 3)}...${provider.apiKey.slice(-4)}` : '',
    });
  });

  // POST /api/v2/providers/:name/test — тест подключения (admin)
  app.post('/:name/test', kit.requireAdmin, createRateLimiter(5, 60_000), async (c) => {
    const provider = await store.load(c.req.param('name'));
    if (!provider) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.provider', undefined, c) } }, 404);
    }

    if (provider.enabled === false) {
      return c.json({ status: 'disabled', message: t('errors.providerDisabled', undefined, c) });
    }

    if (!provider.baseUrl) {
      return c.json({ status: 'error', error: t('errors.validation.urlRequired', undefined, c) }, 400);
    }

    try {
      const instance = ProviderFactory.create(provider.name, {
        type: provider.type,
        name: provider.name,
        url: provider.baseUrl,
        apiKey: provider.apiKey || '',
        model: provider.defaultModel || '',
        timeout: 30,
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
        error: err instanceof Error ? err.message : t('errors.connectionError', undefined, c),
      });
    }
  });

  // POST /api/v2/providers/fetch-icon — получить favicon с домена (admin)
  app.post('/fetch-icon', kit.requireAdmin, createRateLimiter(10, 60_000), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = body.url?.trim();
    if (!url) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.urlRequired', undefined, c) } }, 400);
    }

    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUrl', undefined, c) } }, 400);
    }

    if (isInternalOrigin(origin)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUrl', undefined, c) } }, 400);
    }

    try {
      const iconUrl = `${origin}/favicon.ico`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(iconUrl, {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      });
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

      const htmlResp = await fetch(origin, {
        signal: htmlController.signal,
        headers: { Accept: 'text/html' },
      });
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

            const iconResp = await fetch(resolved, {
              signal: AbortSignal.timeout(5000),
              headers: { Accept: 'image/*' },
            });
            if (iconResp.ok) {
              const buffer = await iconResp.arrayBuffer();
              const ct = iconResp.headers.get('content-type') || 'image/x-icon';
              const b64 = Buffer.from(buffer).toString('base64');
              return c.json({ icon: `data:${ct};base64,${b64}`, source: resolved });
            }
          }
        }
      }

      return c.json({ icon: null, error: t('errors.notFound.favicon', undefined, c) });
    } catch (err) {
      return c.json({
        icon: null,
        error: err instanceof Error ? err.message : t('errors.faviconFetchError', undefined, c),
      });
    }
  });

  return app;
}
