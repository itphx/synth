import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import { JsonStore } from '../../storage/json-store.js';
import type { AgentDefinition, ToolCapability } from '@synth/shared';

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'developer',
    displayName: 'Разработчик',
    contextFile: 'developer',
    capabilities: ['file_read', 'file_write', 'shell', 'search', 'web', 'git_read', 'git_write', 'task'] as ToolCapability[],
    enabled: true,
    sshKeys: [],
    isOverridden: false,
    temperature: 0.3,
    topP: 0.9,
    icon: 'code',
    color: '#3b82f6',
    description: 'Пишет код, выполняет рефакторинг, исправляет ошибки',
  },
  {
    id: 'assistant',
    displayName: 'Ассистент',
    contextFile: 'assistant',
    capabilities: ['file_read', 'search', 'web'] as ToolCapability[],
    enabled: true,
    sshKeys: [],
    isOverridden: false,
    temperature: 0.3,
    topP: 0.9,
    icon: 'message-circle',
    color: '#10b981',
    description: 'Отвечает на вопросы, помогает с анализом',
  },
];

export function createAgentRoutes(
  auth: AuthKit,
  agentStore: JsonStore<AgentDefinition>,
): Hono {
  const app = new Hono();

  app.get('/', auth.requireAuth, async (c) => {
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
        is_builtin: true,
        is_overridden: a.isOverridden,
      })),
      default_agent: 'developer',
    });
  });

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.id?.trim();
    if (!id) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ID обязателен' } }, 400);
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
      sshKeys: body.ssh_keys ?? body.sshKeys ?? existing?.sshKeys ?? [],
      isOverridden: true,
      icon: body.icon ?? existing?.icon,
      color: body.color ?? existing?.color,
      description: body.description ?? existing?.description,
      agentMode: body.agent_mode ?? body.agentMode ?? existing?.agentMode,
      subagentPrompt: body.subagent_prompt ?? body.subagentPrompt ?? existing?.subagentPrompt,
      maxSteps: body.max_steps ?? body.maxSteps ?? existing?.maxSteps,
    };
    await agentStore.save(id, agent);
    return c.json(agent, existing ? 200 : 201);
  });

  app.delete('/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (!(await agentStore.exists(id))) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Агент не найден' } }, 404);
    }
    await agentStore.delete(id);
    return c.json({ status: 'deleted' });
  });

  return app;
}
