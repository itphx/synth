import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';
import type { AgentDefinition } from '@synth/shared';

const BUILTIN_IDS = new Set([
  'developer', 'assistant', 'devops', 'analyst',
  'admin', 'auditor', 'pm', 'qa',
]);

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'developer', displayName: 'Разработчик',
    contextFile: 'DEVELOPER.md',
    capabilities: ['file_read', 'file_search', 'file_write', 'git_read', 'git_write', 'code_review'],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false,
    temperature: 0.3, topP: 0.9,
    icon: 'code-s-slash', color: '--status-info',
    description: 'Разработка и рефакторинг кода',
  },
  {
    id: 'assistant', displayName: 'Ассистент',
    contextFile: 'ASSISTANT.md',
    capabilities: [],
    enabled: true, mode: 'simple', sshKeys: [], isOverridden: false,
    icon: 'robot-2', color: '--primary',
    description: 'Универсальный ассистент для любых задач',
  },
  {
    id: 'devops', displayName: 'DevOps Инженер',
    contextFile: 'DEVOPS.md',
    capabilities: ['file_read', 'git_read', 'deployment', 'infrastructure'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'server', color: '--status-info',
    description: 'Инфраструктура, деплой, CI/CD',
  },
  {
    id: 'analyst', displayName: 'Аналитик',
    contextFile: 'ANALYST.md',
    capabilities: ['file_read', 'research', 'documentation'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'search-eye', color: '--status-warning',
    description: 'Анализ кода, исследование, документация',
  },
  {
    id: 'admin', displayName: 'Администратор',
    contextFile: 'ADMIN.md',
    capabilities: ['file_read', 'file_write', 'git_read', 'git_write', 'system_admin'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'admin', color: '--status-success',
    description: 'Системное администрирование, управление git',
  },
  {
    id: 'auditor', displayName: 'Аудитор Безопасности',
    contextFile: 'AUDITOR.md',
    capabilities: ['file_read', 'code_review', 'security_analysis'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'shield-keyhole', color: '--status-success',
    description: 'Аудит безопасности и уязвимостей',
  },
  {
    id: 'pm', displayName: 'Проектный Менеджер',
    contextFile: 'PM.md',
    capabilities: ['file_read', 'research', 'planning'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'task', color: '--chart-1',
    description: 'Управление проектом, планирование',
  },
  {
    id: 'qa', displayName: 'QA Инженер',
    contextFile: 'QA.md',
    capabilities: ['file_read', 'testing', 'code_review'],
    enabled: true, mode: 'orchestrator', sshKeys: [], isOverridden: false,
    icon: 'test-tube', color: '--chart-4',
    description: 'Тестирование и контроль качества',
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
      if (!BUILTIN_IDS.has(o.id)) {
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
        mode: a.mode,
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
      return c.json({ error: { code: 'NOT_FOUND', message: 'Override не найден' } }, 404);
    }

    if (exists) {
      await agentStore.delete(id);
      return c.json({ status: 'deleted' });
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
