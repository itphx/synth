import { isAbsolute, normalize } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { serializeProject } from '../serialize.js';
import { isRemoteRef, toLocalId, toRemote, mergeItems, remoteErrorToHttp } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';

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

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

export function createProjectRoutes(
  auth: AuthKit,
  store: ProjectStore,
  remoteClient?: RemoteBackendClient,
): Hono {
  const app = new Hono();
  const LOCAL_USER = 'local';

  app.get('/', auth.requireAuth, async (c) => {
    const projects = await store.list(LOCAL_USER);
    if (!remoteClient) {
      return c.json(projects.map(serializeProject));
    }
    try {
      const remote = (await remoteClient.listProjects()) as Array<Record<string, unknown>>;
      return c.json(mergeItems(projects as unknown as Array<Record<string, unknown>>, remote));
    } catch (err) {
      // Offline-деградация: сервер недоступен — отдаём локальный мир.
      if (err instanceof RemoteError) {
        console.warn(`[hybrid] удалённый backend недоступен (${err.code}): ${err.message}`);
        return c.json(projects.map(serializeProject));
      }
      throw err;
    }
  });

  app.post('/', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Гибрид: создание удалённого проекта на backend.
    if (body.origin === 'remote') {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const forwarded: Record<string, unknown> = { ...body };
      delete forwarded.origin;
      try {
        const created = (await remoteClient.createProject(forwarded)) as Record<string, unknown>;
        return c.json(toRemote(created), 201);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

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
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        const remote = (await remoteClient.getProject(toLocalId(id))) as Record<string, unknown>;
        return c.json(toRemote(remote));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const project = await store.load(id);
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    return c.json(serializeProject(project));
  });

  app.put('/:id', auth.requireAuth, async (c) => {
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      const body = await c.req.json().catch(() => ({}));
      try {
        const updated = (await remoteClient.updateProject(toLocalId(id), body)) as Record<string, unknown>;
        return c.json(toRemote(updated));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }
    const project = await store.load(id);
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
    const id = c.req.param('id');
    if (isRemoteRef(id)) {
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      try {
        await remoteClient.deleteProject(toLocalId(id));
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
      return c.body(null, 204);
    }
    const project = await store.load(id);
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    }
    await store.delete(project.id);
    return c.body(null, 204);
  });

  return app;
}
