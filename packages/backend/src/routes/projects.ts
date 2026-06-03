import { Hono } from 'hono';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore } from '../storage/project-store.js';
import type { SessionManager } from '@synth/core';
import { serializeProject } from '../lib/serialize.js';
import { t } from '../lib/i18n.js';
import { WorkspaceResolver } from '../lib/workspace-resolver.js';

export function createProjectRoutes(
  kit: AuthKit,
  store: ProjectStore,
  sessionManager: SessionManager,
  workspacesRoot: string,
): Hono {
  const app = new Hono();
  const wsResolver = new WorkspaceResolver(workspacesRoot,
    (projectId) => store.load(projectId),
  );

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
    const user = kit.getCurrentUser(c)!;
    const projects = await store.list(user.id);
    return c.json(projects.map(serializeProject));
  });

  // POST /api/v2/projects — создать
  app.post('/', kit.requireAuth, async (c) => {
    const user = kit.getCurrentUser(c)!;
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
