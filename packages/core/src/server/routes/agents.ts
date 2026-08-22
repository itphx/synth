import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AgentDefinition } from '@itphx/synth-shared';
import { loadSystemAgentDefinitions, normalizeAgentModes, DEFAULT_AGENT_ID } from '../../engine/agents/index.js';
import type { AgentRegistry } from '../../engine/agents/index.js';

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

const AGENT_FIELDS = (a: AgentDefinition) => ({
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
  is_builtin: true,
  is_overridden: a.isOverridden,
});

export function createAgentRoutes(
  auth: AuthKit,
  agentStore: JsonStore<AgentDefinition>,
  agentRegistry?: AgentRegistry,
): Hono {
  const app = new Hono();
  const BUILTIN_AGENTS = loadSystemAgentDefinitions();

  async function resolveAgents(): Promise<AgentDefinition[]> {
    const overrides = await agentStore.list();
    const agents = BUILTIN_AGENTS.map((builtin) => {
      const override = overrides.find((o) => o.id === builtin.id);
      return override ? { ...builtin, ...override, isOverridden: true } : builtin;
    });

    for (const o of overrides) {
      if (!BUILTIN_AGENTS.find((b) => b.id === o.id)) {
        agents.push({ ...o, isOverridden: true });
      }
    }
    return agents;
  }

  // Все агенты (для админки) — регистрируем до /:id-подобных маршрутов
  app.get('/all', auth.requireAuth, async (c) => {
    return c.json({
      agents: (await resolveAgents()).map(AGENT_FIELDS),
      default_agent: DEFAULT_AGENT_ID,
    });
  });

  // Только основные агенты (класс primary) — для чата
  app.get('/', auth.requireAuth, async (c) => {
    const agents = (await resolveAgents())
      .filter((a) => normalizeAgentModes(a.agentMode).includes('primary'));

    return c.json({
      agents: agents.map(AGENT_FIELDS),
      default_agent: DEFAULT_AGENT_ID,
    });
  });

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ID обязателен' } }, 400);
    }
    if (!AGENT_ID_REGEX.test(id)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ID агента может содержать только латиницу, цифры, дефис и подчёркивание' } }, 400);
    }

    const existing = await agentStore.load(id);
    const agent: AgentDefinition = {
      id,
      displayName: body.display_name ?? body.displayName ?? existing?.displayName ?? id,
      contextFile: body.context_file ?? body.contextFile ?? existing?.contextFile,
      capabilities: body.capabilities ?? existing?.capabilities ?? [],
      enabled: body.enabled ?? existing?.enabled ?? true,
      provider: body.provider ?? existing?.provider,
      model: body.model ?? existing?.model,
      temperature: body.temperature ?? existing?.temperature,
      topP: body.top_p ?? body.topP ?? existing?.topP,
      reasoningLevel: body.reasoning_level ?? body.reasoningLevel ?? existing?.reasoningLevel,
      sshKeys: body.ssh_keys ?? body.sshKeys ?? existing?.sshKeys ?? [],
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
      agentMode: normalizeAgentModes(body.agent_mode ?? body.agentMode ?? existing?.agentMode),
      subagentPrompt: body.subagent_prompt ?? body.subagentPrompt ?? existing?.subagentPrompt,
      maxSteps: body.max_steps ?? body.maxSteps ?? existing?.maxSteps,
    };
    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    return c.json(agent, existing ? 200 : 201);
  });

  app.delete('/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (!(await agentStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Агент не найден' } }, 404);
    }
    await agentStore.delete(id);
    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    if (builtin) {
      agentRegistry?.register(builtin);
    } else {
      agentRegistry?.unregister(id);
    }
    return c.json({ status: 'deleted' });
  });

  return app;
}
