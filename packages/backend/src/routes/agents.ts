import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition } from '@synth/shared';

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'developer', displayName: 'Разработчик', capabilities: ['file_read', 'file_write', 'code_review', 'development'],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false, icon: 'code-box', description: 'Пишет и редактирует код',
  },
  {
    id: 'assistant', displayName: 'Ассистент', capabilities: ['file_read', 'research', 'documentation'],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false, icon: 'chat-new', description: 'Универсальный помощник',
  },
  {
    id: 'devops', displayName: 'DevOps', capabilities: ['file_read', 'infrastructure', 'deployment', 'monitoring', 'shell_exec'],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false, icon: 'server', description: 'Инфраструктура и деплой',
  },
  {
    id: 'analyst', displayName: 'Аналитик', capabilities: ['file_read', 'file_search', 'research', 'documentation', 'architecture'],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false, icon: 'search-eye', description: 'Анализ кода и архитектуры',
  },
];

export function createAgentRoutes(kit: AuthKit, agentStore: JsonStore<AgentDefinition>): Hono {
  const app = new Hono();

  // GET /api/v2/agents — список агентов
  app.get('/', kit.requireAuth, async (c) => {
    const overridden = await agentStore.list();
    const agents = BUILTIN_AGENTS.map((a) => {
      const override = overridden.find((o) => o.id === a.id);
      return override ? { ...a, ...override, isOverridden: true } : a;
    });
    // Add custom (non-builtin) agents
    for (const o of overridden) {
      if (!BUILTIN_AGENTS.some((a) => a.id === o.id)) {
        agents.push({ ...o, isOverridden: true });
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
      })),
      default_agent: 'developer',
    });
  });

  // POST /api/v2/agents — создать/обновить агента (admin)
  app.post('/', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'id обязателен' } }, 400);
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
      mode: body.mode ?? existing?.mode ?? builtin?.mode ?? 'simple',
      sshKeys: body.ssh_keys ?? body.sshKeys ?? existing?.sshKeys ?? [],
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
    };
    await agentStore.save(id, agent);
    return c.json(agent, existing ? 200 : 201);
  });

  // GET /api/v2/agents/:id — получить агента
  app.get('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const override = await agentStore.load(id);
    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!override && !builtin) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Агент не найден' } }, 404);
    }
    const agent = override ? { ...builtin, ...override } : builtin;
    return c.json(agent);
  });

  // DELETE /api/v2/agents/:id — удалить/сбросить (admin)
  app.delete('/:id', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    if (await agentStore.exists(id)) {
      await agentStore.delete(id);
      return c.json({ status: 'reset' });
    }
    return c.json({ error: { code: 'NOT_FOUND', message: 'Агент не найден' } }, 404);
  });

  // PATCH /api/v2/agents/:id/enabled — переключить enabled (admin)
  app.patch('/:id/enabled', kit.requireAdmin, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled ?? true;

    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    const existing = await agentStore.load(id);

    if (!builtin && !existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Агент не найден' } }, 404);
    }

    const agent: AgentDefinition = existing
      ? { ...existing, enabled }
      : { ...builtin!, enabled, isOverridden: true };
    await agentStore.save(id, agent);
    return c.json({ id, enabled });
  });

  return app;
}
