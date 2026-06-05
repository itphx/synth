import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition, ToolCapability } from '@synth/shared';
import type { SessionManager } from '@synth/core';
import { t } from '../lib/i18n.js';
import { resolveDisplayName, resolveDescription } from '../lib/i18n-config.js';

const BUILTIN_IDS = new Set([
  'developer', 'assistant', 'devops', 'analyst',
  'admin', 'auditor', 'pm', 'qa',
  'general', 'explore',
]);

interface AgentDefFile {
  id: string;
  displayName: Record<string, string>;
  description: Record<string, string>;
  capabilities: ToolCapability[];
  icon: string;
  color: string;
  mode: 'simple' | 'orchestrator';
  contextFile: string;
  agentMode?: 'primary' | 'subagent' | 'all';
  subagentPrompt?: string;
  maxSteps?: number;
}

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'definitions');

function loadAgentDef(id: string): AgentDefFile {
  const path = join(AGENTS_DIR, `${id}.json`);
  if (!existsSync(path)) {
    throw new Error(`Agent definition not found: ${id}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as AgentDefFile;
}

let _cachedDefs: AgentDefFile[] | null = null;

function getAgentDefs(): AgentDefFile[] {
  if (!_cachedDefs) {
    _cachedDefs = [...BUILTIN_IDS].map((id) => loadAgentDef(id));
  }
  return _cachedDefs;
}

function getBuiltInAgents(_agentStore: JsonStore<AgentDefinition>): AgentDefinition[] {
  const defs = getAgentDefs();
  // Синхронная загрузка оверрайдов невозможна через JsonStore (асинхронный).
  // Оверрайды применяются при сборке ответа в роутах.

  return defs.map((def) => ({
    id: def.id,
    displayName: resolveDisplayName(def.displayName),
    contextFile: def.contextFile,
    capabilities: def.capabilities,
    enabled: true,
    mode: def.mode,
    sshKeys: [],
    isOverridden: false,
    temperature: 0.3,
    topP: 0.9,
    icon: def.icon,
    color: def.color,
    description: resolveDescription(def.description),
    agentMode: def.agentMode,
    subagentPrompt: def.subagentPrompt,
    maxSteps: def.maxSteps,
  }));
}

async function mergeWithOverride(
  builtin: AgentDefinition,
  agentStore: JsonStore<AgentDefinition>,
): Promise<AgentDefinition> {
  const override = await agentStore.load(builtin.id);
  if (!override) return builtin;

  const def = getAgentDefs().find((d) => d.id === builtin.id)!;
  return {
    ...builtin,
    ...override,
    displayName: resolveDisplayName(def.displayName, override.displayName),
    description: resolveDescription(def.description, override.description),
    isOverridden: true,
  };
}

export function createAgentRoutes(kit: AuthKit, agentStore: JsonStore<AgentDefinition>, sessionManager?: SessionManager): Hono {
  const app = new Hono();

  // GET /api/v2/agents — список агентов
  app.get('/', kit.requireAuth, async (c) => {
    const builtins = getBuiltInAgents(agentStore);
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
              mode: a.mode,
              agent_mode: a.agentMode || null,
              subagent_prompt: a.subagentPrompt || null,
              max_steps: a.maxSteps || null,
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
        mode: a.mode,
        agent_mode: a.agentMode || null,
        subagent_prompt: a.subagentPrompt || null,
        max_steps: a.maxSteps || null,
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

    const builtins = getBuiltInAgents(agentStore);
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
      mode: body.mode ?? existing?.mode ?? builtin?.mode ?? 'simple',
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
    return c.json(agent, existing ? 200 : 201);
  });

  // GET /api/v2/agents/:id — получить агента
  app.get('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const override = await agentStore.load(id);
    const builtins = getBuiltInAgents(agentStore);
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
        return c.json({ status: 'reset' });
      }
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agentOverride', undefined, c) } }, 404);
    }

    if (exists) {
      await agentStore.delete(id);
      return c.json({ status: 'deleted' });
    }
    return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agent', undefined, c) } }, 404);
  });

  // PATCH /api/v2/agents/:id/enabled — переключить enabled (admin)
  app.patch('/:id/enabled', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled ?? true;

    const builtins = getBuiltInAgents(agentStore);
    const builtin = builtins.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    if (!builtin && !existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.agent', undefined, c) } }, 404);
    }

    const agent: AgentDefinition = existing
      ? { ...existing, enabled }
      : { ...builtin!, enabled, isOverridden: true };
    await agentStore.save(id, agent);
    return c.json({ id, enabled });
  });

  return app;
}
