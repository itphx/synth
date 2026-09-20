import { Hono } from 'hono';
import { z } from 'zod';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore } from '../storage/project-store.js';
import type { SessionManager, McpManager } from '@itphx/synth-core';
import type { Project } from '@itphx/synth-shared';
import { ProjectRole } from '@itphx/synth-shared';
import { serializeProject } from '../lib/serialize.js';
import { t } from '../lib/i18n.js';
import { WorkspaceResolver } from '../lib/workspace-resolver.js';

/**
 * План проекта (AD-039): структурированный объект ProjectPlan, создаётся/редактируется
 * движком (plan_write). Отдельной zod-схемы в shared нет — принимаем произвольный
 * объект (перенос между мирами), null очищает план.
 */
const planFieldSchema = z.unknown().nullable().optional();

/** AD-071 §2.4: тело проектного MCP-скоупа (ссылки на реестр по имени). */
const projectMcpUpdateSchema = z.object({
  enabled: z.array(z.string()).optional(),
  defaultOn: z.array(z.string()).optional(),
});

export function createProjectRoutes(
  kit: AuthKit,
  store: ProjectStore,
  sessionManager: SessionManager,
  workspacesRoot: string,
  /** AD-071 §2.4: источник известных MCP-серверов для проектного скоупа. */
  mcpManager?: McpManager,
): Hono {
  const app = new Hono();
  const wsResolver = new WorkspaceResolver(workspacesRoot,
    (projectId) => store.load(projectId),
  );

  /** AD-071 §2.4: owner проекта или глобальные LEAD/ADMIN (через AuthKit). */
  const canManageProjectMcp = (
    c: Parameters<typeof kit.isAdmin>[0],
    project: Project,
    userId: string,
  ): boolean =>
    kit.isAdmin(c)
    || (typeof kit.hasRole === 'function' && kit.hasRole(c, 'LEAD'))
    || project.ownerId === userId
    || project.members?.[userId] === ProjectRole.OWNER;

  const knownMcpServers = (): string[] => Object.keys(mcpManager?.getConfig() ?? {});

  async function validateWorkspaceValue(workspace: string | undefined | null): Promise<string | null> {
    if (!workspace) {
      return null;
    }

    const pathError = wsResolver.validateWorkspacePath(workspace);
    if (pathError) return pathError;

    return await _checkDirectoryExists(resolve(workspacesRoot, workspace));
  }

  async function _checkDirectoryExists(wsPath: string): Promise<string | null> {
    try {
      const s = await stat(wsPath);
      if (!s.isDirectory()) {
        return 'Workspace не является директорией';
      }
      return null;
    } catch {
      return `Директория workspace не найдена: ${wsPath}`;
    }
  }

  // GET /api/v2/projects — список проектов
  app.get('/', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const projects = await store.list(user.id);
    return c.json(projects.map(serializeProject));
  });

  // POST /api/v2/projects — создать
  app.post('/', kit.requireAuth, async (c) => {
    const user = (await kit.getCurrentUser(c))!;
    const body = await c.req.json().catch(() => ({}));

    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.nameRequired', undefined, c) } }, 400);
    }

    if (body.workspace) {
      const wsError = await validateWorkspaceValue(body.workspace);
      if (wsError) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: wsError } }, 422);
      }
    }

    const project = store.create(name, user.id, {
      description: body.description,
      icon: body.icon,
      color: body.color,
      workspace: body.workspace || undefined,
      repos: body.repos || undefined,
    });
    const planResult = planFieldSchema.safeParse(body.plan);
    if (planResult.success && planResult.data !== undefined) {
      project.plan = (planResult.data ?? undefined) as Project['plan'] | undefined;
    }
    await store.save(project);

    return c.json(serializeProject(project), 201);
  });

  // GET /api/v2/projects/:id — получить
  app.get('/:id', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    return c.json(serializeProject(project));
  });

  // GET /api/v2/projects/:id/mcp — проектный MCP-скоуп (AD-071 §2.4).
  // RBAC: ProjectRole.OWNER или глобальные LEAD/ADMIN.
  app.get('/:id/mcp', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!canManageProjectMcp(c, project, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    return c.json({
      enabled: project.mcp?.enabled ?? [],
      defaultOn: project.mcp?.defaultOn ?? [],
      knownServers: knownMcpServers(),
    });
  });

  // PUT /api/v2/projects/:id/mcp — задать проектный MCP-скоуп (AD-071 §2.4).
  // RBAC: ProjectRole.OWNER или глобальные LEAD/ADMIN.
  app.put('/:id/mcp', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    const user = (await kit.getCurrentUser(c))!;
    if (!canManageProjectMcp(c, project, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = projectMcpUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
    }

    const known = new Set(knownMcpServers());
    for (const name of [...(parsed.data.enabled ?? []), ...(parsed.data.defaultOn ?? [])]) {
      if (!known.has(name)) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `MCP-сервер "${name}" не найден` },
        }, 400);
      }
    }

    const current = project.mcp ?? { enabled: [], defaultOn: [] };
    project.mcp = {
      enabled: parsed.data.enabled ?? current.enabled,
      defaultOn: parsed.data.defaultOn ?? current.defaultOn,
    };
    project.updatedAt = new Date().toISOString();
    await store.save(project);

    return c.json({
      enabled: project.mcp.enabled,
      defaultOn: project.mcp.defaultOn,
      knownServers: knownMcpServers(),
    });
  });

  // PUT /api/v2/projects/:id — обновить
  app.put('/:id', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));

    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description;
    if (body.current_task !== undefined) project.currentTask = body.current_task;
    if (body.invariants !== undefined) project.invariants = body.invariants;
    if (body.icon !== undefined) project.icon = body.icon;
    if (body.color !== undefined) project.color = body.color;
    if (body.workspace !== undefined) {
      if (body.workspace !== null && body.workspace !== '') {
        const wsError = await validateWorkspaceValue(body.workspace);
        if (wsError) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: wsError } }, 422);
        }
      }
      project.workspace = body.workspace || undefined;
    }
    if (body.repos !== undefined) project.repos = body.repos;
    const planResult = planFieldSchema.safeParse(body.plan);
    if (planResult.success && planResult.data !== undefined) {
      project.plan = (planResult.data ?? undefined) as Project['plan'] | undefined;
    }
    project.updatedAt = new Date().toISOString();

    await store.save(project);
    return c.json(serializeProject(project));
  });

  // DELETE /api/v2/projects/:id — удалить
  app.delete('/:id', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    await store.delete(project.id);
    return c.body(null, 204);
  });

  // GET /api/v2/projects/:id/stats
  app.get('/:id/stats', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    const sessions = await sessionManager.listSessions({ projectId: project.id });
    let totalInput = 0;
    let totalOutput = 0;
    let totalTotal = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalReasoning = 0;
    let totalMessages = 0;
    for (const s of sessions) {
      totalInput += s.inputTokens;
      totalOutput += s.outputTokens;
      totalTotal += s.totalTokens;
      totalCacheRead += s.cacheReadTokens;
      totalCacheWrite += s.cacheWriteTokens;
      totalReasoning += s.reasoningTokens;
      totalMessages += s.messages.length;
    }
    return c.json({
      total_sessions: sessions.length,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_tokens: totalTotal,
      total_messages: totalMessages,
      total_cache_read_tokens: totalCacheRead,
      total_cache_write_tokens: totalCacheWrite,
      total_reasoning_tokens: totalReasoning,
    });
  });

  return app;
}
