import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition } from '@itphx/shared';
import { loadSystemAgentDefinitions } from '@itphx/core';
import type { AgentRegistry, SessionManager } from '@itphx/core';
import { t } from '../lib/i18n.js';

const BUILTIN_IDS = new Set(loadSystemAgentDefinitions().map((a: AgentDefinition) => a.id));

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

function getBuiltInAgents(): AgentDefinition[] {
  return loadSystemAgentDefinitions();
}

async function mergeWithOverride(
  builtin: AgentDefinition,
  agentStore: JsonStore<AgentDefinition>,
): Promise<AgentDefinition> {
  const override = await agentStore.load(builtin.id);
  if (!override) return builtin;
  return { ...builtin, ...override, isOverridden: true };
}

export function createAgentRoutes(kit: AuthKit, agentStore: JsonStore<AgentDefinition>, sessionManager?: SessionManager, agentRegistry?: AgentRegistry): Hono {
  const app = new Hono();

  // GET /api/v2/agents — список агентов
  app.get('/', kit.requireAuth, async (c) => {
    const builtins = getBuiltInAgents();
    const overridden = await agentStore.list();

    const agents = await Promise.all(builtins.map((a) => mergeWithOverride(a, agentStore)));

    // Add custom (non-builtin) agents
    for (const o of overridden) {
      if (!BUILTIN_IDS.has(o.id)) {
        agents.push({ ...o, isOverridden: true });
      }
    }

    // Если передан session_id и сессия без проекта — только assistant
    const sessionId = c.req.query('session_id');
    if (sessionId && sessionManager) {
      const session = await sessionManager.getSession(sessionId);
      if (session && !session.projectId) {
        return c.json({
          agents: agents
            .filter((a) => a.id === 'assistant')
            .map((a) => ({
              id: a.id,
              display_name: a.displayName,
              capabilities: a.capabilities,
              enabled: a.enabled,
              icon: a.icon || null,
              color: a.color || null,
              description: a.description || null,
              available: true,
              mode: 'simple' as const,
              agent_mode: a.agentMode || null,
              subagent_prompt: a.subagentPrompt || null,
              max_steps: a.maxSteps ?? null,
              provider: a.provider || null,
              model: a.model || null,
              context_file: a.contextFile || null,
              is_builtin: BUILTIN_IDS.has(a.id),
              is_overridden: a.isOverridden,
            })),
          default_agent: 'assistant',
        });
      }
    }

    return c.json({
      agents: agents.map((a) => ({
        id: a.id,
        display_name: a.displayName,
        capabilities: a.capabilities,
        enabled: a.enabled,
        icon: a.icon || null,
        color: a.color || null,
        description: a.description || null,
        available: true,
        mode: 'simple' as const,
        agent_mode: a.agentMode || null,
        subagent_prompt: a.subagentPrompt || null,
        max_steps: a.maxSteps ?? null,
        provider: a.provider || null,
        model: a.model || null,
        context_file: a.contextFile || null,
        is_builtin: BUILTIN_IDS.has(a.id),
        is_overridden: a.isOverridden,
      })),
      default_agent: 'developer',
    });
  });

  // POST /api/v2/agents — создать/обновить агента (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.idRequired', undefined, c) } }, 400);
    }
    if (!AGENT_ID_REGEX.test(id)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidAgentId', undefined, c) } }, 400);
    }

    const builtins = getBuiltInAgents();
    const builtin = builtins.find((a) => a.id === id);
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
      sshKeys: body.ssh_keys ?? body.sshKeys ?? existing?.sshKeys ?? [],
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
      agentMode: body.agent_mode ?? body.agentMode ?? existing?.agentMode ?? builtin?.agentMode,
      subagentPrompt: body.subagent_prompt ?? body.subagentPrompt ?? existing?.subagentPrompt,
      maxSteps: body.max_steps ?? body.maxSteps ?? existing?.maxSteps,
    };
    await agentStore.save(id, agent);
    agentRegistry?.register(agent);
    return c.json(agent, existing ? 200 : 201);
  });

  // GET /api/v2/agents/:id — получить агента
  app.get('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const override = await agentStore.load(id);
    const builtins = getBuiltInAgents();
    const builtin = builtins.find((a) => a.id === id);
    if (!override && !builtin) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agent', undefined, c) } }, 404);
    }
    const agent = override ? { ...builtin, ...override } : builtin;
    return c.json(agent);
  });

  // DELETE /api/v2/agents/:id — удалить custom / сбросить built-in (admin)
  app.delete('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const isBuiltin = BUILTIN_IDS.has(id);
    const exists = await agentStore.exists(id);

    if (isBuiltin) {
      if (exists) {
        await agentStore.delete(id);
        const builtin = getBuiltInAgents().find((a) => a.id === id);
        if (builtin) agentRegistry?.register(builtin);
        return c.json({ status: 'reset' });
      }
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agentOverride', undefined, c) } }, 404);
    }

    if (exists) {
      await agentStore.delete(id);
      agentRegistry?.unregister(id);
      return c.json({ status: 'deleted' });
    }
    return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agent', undefined, c) } }, 404);
  });

  // PATCH /api/v2/agents/:id/enabled — переключить enabled (admin)
  app.patch('/:id/enabled', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled ?? true;

    const builtins = getBuiltInAgents();
    const builtin = builtins.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    if (!builtin && !existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agent', undefined, c) } }, 404);
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
