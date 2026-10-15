import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AgentDefinition } from '@itphx/synth-shared';
import type { JsonStoreLike } from '../../storage/json-store.js';
import {
  loadSystemAgentDefinitions,
  normalizeAgentModes,
  DEFAULT_AGENT_ID,
} from '../../engine/agents/index.js';
import type { AgentRegistry } from '../../engine/agents/index.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface AgentRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface AgentRouteMessages {
  idRequired: (c: Context) => string;
  invalidAgentId: (c: Context) => string;
  agentNotFound: (c: Context) => string;
  agentOverrideNotFound: (c: Context) => string;
}

export interface AgentRoutesOptions {
  /** Guard для POST /, DELETE /:id, PATCH /:id/enabled (backend — requireAdmin, core — requireAuth). */
  writeGuard?: Middleware;
  /** Guard для GET /all (backend — requireAdmin, core — requireAuth). */
  allGuard?: Middleware;
  /** Guard для GET /:id (backend — requireAdmin, core — requireAuth). */
  detailGuard?: Middleware;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<AgentRouteMessages>;
}

const DEFAULT_MESSAGES: AgentRouteMessages = {
  idRequired: () => 'ID обязателен',
  invalidAgentId: () => 'ID агента может содержать только латиницу, цифры, дефис и подчёркивание',
  agentNotFound: () => 'Агент не найден',
  agentOverrideNotFound: () => 'Override не найден',
};

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

const AGENT_FIELDS = (a: AgentDefinition, isBuiltin: boolean) => ({
  id: a.id,
  display_name: a.displayName,
  capabilities: a.capabilities,
  enabled: a.enabled,
  icon: a.icon || null,
  color: a.color || null,
  description: a.description || null,
  available: true,
  mode: 'simple' as const,
  agent_mode: normalizeAgentModes(a.agentMode),
  subagent_prompt: a.subagentPrompt || null,
  max_steps: a.maxSteps ?? null,
  provider: a.provider || null,
  model: a.model || null,
  reasoning_level: a.reasoningLevel ?? null,
  context_file: a.contextFile || null,
  is_builtin: isBuiltin,
  is_overridden: a.isOverridden,
});

export function createAgentRoutes(
  auth: AgentRoutesAuth,
  agentStore: JsonStoreLike<AgentDefinition>,
  agentRegistry?: AgentRegistry,
  getDefaultAgentId?: () => string | Promise<string>,
  opts?: AgentRoutesOptions,
): Hono {
  const app = new Hono();
  const BUILTIN_AGENTS = loadSystemAgentDefinitions();
  const BUILTIN_IDS = new Set(BUILTIN_AGENTS.map((a) => a.id));

  const writeGuard = opts?.writeGuard ?? auth.requireAuth;
  const allGuard = opts?.allGuard ?? auth.requireAuth;
  const detailGuard = opts?.detailGuard ?? auth.requireAuth;
  const messages: AgentRouteMessages = { ...DEFAULT_MESSAGES, ...opts?.messages };

  const fields = (a: AgentDefinition) => AGENT_FIELDS(a, BUILTIN_IDS.has(a.id));

  async function resolveAgents(): Promise<AgentDefinition[]> {
    const overrides = await agentStore.list();
    const agents = BUILTIN_AGENTS.map((builtin) => {
      const override = overrides.find((o) => o.id === builtin.id);
      return override ? { ...builtin, ...override, isOverridden: true } : builtin;
    });

    for (const o of overrides) {
      if (!BUILTIN_IDS.has(o.id)) {
        agents.push({ ...o, isOverridden: true });
      }
    }
    return agents;
  }

  // Все агенты (для админки) — регистрируем до /:id-подобных маршрутов
  app.get('/all', allGuard, async (c) => {
    return c.json({
      agents: (await resolveAgents()).map(fields),
      default_agent: (await getDefaultAgentId?.()) ?? DEFAULT_AGENT_ID,
    });
  });

  // Только основные агенты (класс primary) — для чата
  app.get('/', auth.requireAuth, async (c) => {
    const agents = (await resolveAgents())
      .filter((a) => normalizeAgentModes(a.agentMode).includes('primary'));

    return c.json({
      agents: agents.map(fields),
      default_agent: (await getDefaultAgentId?.()) ?? DEFAULT_AGENT_ID,
    });
  });

  // Создать/обновить агента (custom или override builtin)
  app.post('/', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.idRequired(c) } }, 400);
    }
    if (!AGENT_ID_REGEX.test(id)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidAgentId(c) } }, 400);
    }

    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    const agent: AgentDefinition = {
      id,
      displayName: body.display_name ?? body.displayName ?? existing?.displayName ?? builtin?.displayName ?? id,
      contextFile: body.context_file ?? body.contextFile ?? existing?.contextFile,
      capabilities: body.capabilities ?? existing?.capabilities ?? builtin?.capabilities ?? [],
      enabled: body.enabled ?? existing?.enabled ?? builtin?.enabled ?? true,
      provider: body.provider ?? existing?.provider,
      model: body.model ?? existing?.model,
      temperature: body.temperature ?? existing?.temperature,
      topP: body.top_p ?? body.topP ?? existing?.topP,
      topK: body.top_k ?? body.topK ?? existing?.topK,
      reasoningLevel: body.reasoning_level ?? body.reasoningLevel ?? existing?.reasoningLevel ?? builtin?.reasoningLevel,
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
      agentMode: normalizeAgentModes(body.agent_mode ?? body.agentMode ?? existing?.agentMode ?? builtin?.agentMode),
      subagentPrompt: body.subagent_prompt ?? body.subagentPrompt ?? existing?.subagentPrompt,
      maxSteps: body.max_steps ?? body.maxSteps ?? existing?.maxSteps,
    };
    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    return c.json(agent, existing ? 200 : 201);
  });

  // Получить агента (override/builtin)
  app.get('/:id', detailGuard, async (c) => {
    const id = c.req.param('id');
    const override = await agentStore.load(id);
    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!override && !builtin) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
    }
    const agent = override ? { ...builtin, ...override } : builtin;
    return c.json(agent);
  });

  // Удалить custom / сбросить built-in (override)
  app.delete('/:id', writeGuard, async (c) => {
    const id = c.req.param('id');
    const isBuiltin = BUILTIN_IDS.has(id);
    const exists = await agentStore.exists(id);

    if (isBuiltin) {
      if (exists) {
        await agentStore.delete(id);
        const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
        if (builtin) agentRegistry?.register(builtin);
        return c.json({ status: 'reset' });
      }
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentOverrideNotFound(c) } }, 404);
    }

    if (exists) {
      await agentStore.delete(id);
      agentRegistry?.unregister(id);
      return c.json({ status: 'deleted' });
    }
    return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
  });

  // Переключить enabled (override builtin или custom)
  app.patch('/:id/enabled', writeGuard, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled ?? true;

    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    if (!builtin && !existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.agentNotFound(c) } }, 404);
    }

    const agent: AgentDefinition = existing
      ? { ...existing, enabled }
      : { ...builtin!, enabled, isOverridden: true };
    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    return c.json({ id, enabled });
  });

  return app;
}
