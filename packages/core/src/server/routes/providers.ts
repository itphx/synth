import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import { JsonStore } from '../../storage/json-store.js';
import type { ProviderConfig } from '@itphx/synth-shared';
import { ProviderFactory } from '../../index.js';

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

export function createProviderRoutes(
  auth: AuthKit,
  store: JsonStore<ProviderConfig>,
  isTestEnabled: boolean = false,
): Hono {
  const app = new Hono();

  app.get('/', auth.requireAuth, async (c) => {
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

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Имя обязательно' } }, 400);
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

  app.delete('/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    if (!(await store.exists(name))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Провайдер не найден' } }, 404);
    }
    await store.delete(name);
    return c.body(null, 204);
  });

  app.get('/:name', auth.requireAuth, async (c) => {
    const provider = await store.load(c.req.param('name'));
    if (!provider) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Провайдер не найден' } }, 404);
    }
    return c.json({
      ...provider,
      apiKey: provider.apiKey ? `${provider.apiKey.slice(0, 3)}...${provider.apiKey.slice(-4)}` : '',
    });
  });

  if (isTestEnabled) {
    app.post('/:name/test', auth.requireAuth, async (c) => {
      const provider = await store.load(c.req.param('name'));
      if (!provider) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Провайдер не найден' } }, 404);
      }
      if (provider.enabled === false) {
        return c.json({ status: 'disabled', message: 'Провайдер отключён' });
      }
      if (!provider.baseUrl) {
        return c.json({ status: 'error', error: 'URL обязателен' }, 400);
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
          error: err instanceof Error ? err.message : 'Ошибка подключения',
        });
      }
    });
  }

  return app;
}
