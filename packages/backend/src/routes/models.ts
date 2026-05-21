import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { ModelConfig, ProviderConfig } from '@synth/shared';

export function createModelRoutes(kit: AuthKit, modelStore: JsonStore<ModelConfig>, providerStore: JsonStore<ProviderConfig>): Hono {
  const app = new Hono();

  // GET /api/v2/models — список моделей
  app.get('/', kit.requireAuth, async (c) => {
    const provider = c.req.query('provider');
    const models = await modelStore.list();
    const filtered = provider ? models.filter((m) => m.provider === provider) : models;
    const defaultModel = filtered.find((m) => m.isDefault) || filtered[0];
    return c.json({
      models: filtered.map((m) => ({
        name: m.name,
        provider: m.provider,
        enabled: m.enabled,
        context_window: m.contextWindow,
        max_tokens: m.maxOutputTokens,
      })),
      default_model: defaultModel?.name || '',
    });
  });

  // POST /api/v2/models — создать/обновить модель (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const modelId = body.id?.trim() || body.name?.trim();
    if (!modelId) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'id обязателен' } }, 400);
    }

    const existing = await modelStore.load(modelId);
    const model: ModelConfig = {
      id: modelId,
      name: body.name || existing?.name || modelId,
      provider: body.provider || existing?.provider || '',
      enabled: body.enabled ?? existing?.enabled ?? true,
      isDefault: body.is_default ?? body.isDefault ?? existing?.isDefault ?? false,
      contextWindow: body.context_window ?? body.contextWindow ?? existing?.contextWindow,
      maxOutputTokens: body.max_output_tokens ?? body.maxOutputTokens ?? existing?.maxOutputTokens,
    };
    await modelStore.save(modelId, model);
    return c.json(model, existing ? 200 : 201);
  });

  // POST /api/v2/models/fetch — синхронизировать модели с провайдеров (admin)
  app.post('/fetch', kit.requireAdmin, async (c) => {
    const providers = await providerStore.list();
    const fetched: ModelConfig[] = [];

    for (const p of providers) {
      if (!p.baseUrl) continue;
      try {
        const modelsUrl = p.baseUrl.replace(/\/v1\/chat\/completions\/?$/, '/v1/models');
        const resp = await fetch(modelsUrl, {
          headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) continue;
        const data = await resp.json() as { data?: Array<{ id: string }> };
        const modelIds: string[] = data?.data?.map((m) => m.id) || [];
        for (const mid of modelIds) {
          const mc: ModelConfig = {
            id: `${p.name}/${mid}`,
            name: mid,
            provider: p.name,
            enabled: true,
            isDefault: false,
          };
          await modelStore.save(mc.id, mc);
          fetched.push(mc);
        }
      } catch {
        // skip failed providers
      }
    }

    return c.json({ fetched: fetched.length, models: fetched.map((m) => m.name) });
  });

  // DELETE /api/v2/models/:id — удалить (admin)
  app.delete('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (!(await modelStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Модель не найдена' } }, 404);
    }
    await modelStore.delete(id);
    return c.body(null, 204);
  });

  return app;
}
