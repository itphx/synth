import { isAbsolute, normalize } from 'node:path';
import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { serializeProject } from '../serialize.js';

/**
 * Нормализует workspace перед сохранением: относительный путь очищается от
 * ведущих './' и '/' (остаётся относительным — резолв происходит при
 * использовании), абсолютный путь остаётся как есть. '.' / '' → undefined.
 */
function normalizeWorkspace(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutTrailing = trimmed.replace(/[/\\]+$/, '');
  if (!withoutTrailing) return undefined;
  if (isAbsolute(withoutTrailing)) return normalize(withoutTrailing);
  const rel = normalize(withoutTrailing).replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  if (!rel || rel === '.' || rel === '..') return undefined;
  return rel;
}

export function createProjectRoutes(
  auth: AuthKit,
  store: ProjectStore,
): Hono {
  const app = new Hono();
  const LOCAL_USER = 'local';

  app.get('/', auth.requireAuth, async (c) => {
    const projects = await store.list(LOCAL_USER);
    return c.json(projects.map(serializeProject));
  });

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name?.trim();
    if (!name) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Имя обязательно' } }, 400);
    }

    const project = store.create(name, LOCAL_USER, {
      description: body.description,
      icon: body.icon,
      color: body.color,
      workspace: typeof body.workspace === 'string' ? normalizeWorkspace(body.workspace) : undefined,
      repos: body.repos || undefined,
    });
    await store.save(project);
    return c.json(serializeProject(project), 201);
  });

  app.get('/:id', auth.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    return c.json(serializeProject(project));
  });

  app.put('/:id', auth.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description;
    if (body.current_task !== undefined) project.currentTask = body.current_task;
    if (body.invariants !== undefined) project.invariants = body.invariants;
    if (body.icon !== undefined) project.icon = body.icon;
    if (body.color !== undefined) project.color = body.color;
    if (body.workspace !== undefined) {
      project.workspace = typeof body.workspace === 'string'
        ? normalizeWorkspace(body.workspace)
        : (body.workspace || undefined);
    }
    if (body.repos !== undefined) project.repos = body.repos;
    project.updatedAt = new Date().toISOString();
    await store.save(project);
    return c.json(serializeProject(project));
  });

  app.delete('/:id', auth.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    await store.delete(project.id);
    return c.body(null, 204);
  });

  return app;
}
