import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { Project, Session, WorkspaceOutsideRootPolicy, ProjectMcpSettings, ProjectSkillSettings } from '@itphx/synth-shared';
import {
  projectMcpUpdateSchema,
  PROJECT_ICON_KEYS,
  PROJECT_COLOR_KEYS,
  isProjectIconKey,
  isProjectColorKey,
} from '@itphx/synth-shared';
import type { ProjectStore } from '../../storage/project-store.js';
import { provisionWorkspace, resolveWorkspaceForLocalProject } from '../../engine/workspace-provision.js';
import { serializeProject } from '../serialize.js';
import { isRemoteRef, toLocalId, toRemote, mergeItems, remoteErrorToHttp } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно, как в providers.ts). */
export interface ProjectRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы по умолчанию. */
export interface ProjectRouteMessages {
  nameRequired: (c: Context) => string;
  notFound: (c: Context) => string;
  forbidden: (c: Context) => string;
}

const DEFAULT_MESSAGES: ProjectRouteMessages = {
  nameRequired: () => 'Имя обязательно',
  notFound: () => 'Проект не найден',
  forbidden: () => 'Доступ запрещён',
};

/** Источник сессий проекта для `/stats` (структурно совместим с core/backend SessionManager). */
export interface ProjectStatsSource {
  listSessions(filter?: { projectId?: string; userId?: string }): Promise<Session[]>;
}

/**
 * AD-075: опции provisioning workspace локальных проектов (core standalone).
 */
export interface ProjectRoutesOptions {
  /**
   * Корень managed-каталогов workspace. Относительные пути резолвятся
   * относительно него, абсолютные внутри него нормализуются в относительные.
   * Не задан — provisioning пропускается (legacy: только нормализация строки).
   */
  getWorkspacesRoot?: () => string;
  /** Политика для абсолютного пути вне root; дефолт — `confirm`. */
  getOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy;
  /**
   * Managed-режим (AD-075): включает строгую проверку явного пути (deny вне root)
   * и авто-имя workspace при пустом значении. Core standalone — `false`.
   */
  autoProvisionWorkspace?: boolean;
  /** userId текущего запроса; core — константа `'local'`, backend — `user.id`. */
  getCurrentUserId?: (c: Context) => string | Promise<string>;
  /**
   * RBAC: может управлять проектом (удаление, смена `workspace`, MCP-скоуп).
   * Не задан — разрешено (standalone: единый пользователь).
   */
  canManage?: (c: Context, project: Project, userId: string) => boolean;
  /**
   * RBAC: может редактировать контент проекта (`name`/`description`/…/`plan`).
   * Не задан — разрешено (standalone: единый пользователь).
   */
  canEditContent?: (c: Context, project: Project, userId: string) => boolean;
  /**
   * AD-089: доступ на чтение проекта по id (owner / любой `members` / LEAD / ADMIN).
   * Не задан — разрешено (standalone). Мутации (`canManage`/`canEditContent`) не
   * расширяются этим предикатом — VIEWER не получает прав на редактирование.
   */
  canRead?: (c: Context, project: Project, userId: string) => boolean;
  /**
   * AD-089: сквозной обзор (ADMIN/LEAD) — `GET /` возвращает все проекты.
   * `undefined`/`false` — прежнее поведение (проекты пользователя).
   */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /** Сообщения (backend — i18n). */
  messages?: Partial<ProjectRouteMessages>;
  /**
   * Источник известных MCP-серверов (AD-071 §2.4). Задан — регистрируются
   * `GET/PUT /:id/mcp` (RBAC — через `canManage`). Не задан — роутов нет.
   */
  getMcpServers?: () => string[];
  /**
   * AD-071 §2.4 / AD-046 §4.5: сид скоупа нового проекта (снимок системных
   * дефолтов). Не задан — проект создаётся без `mcp`/`skills` (legacy-гейт открыт).
   */
  getProjectSeeds?: () => Promise<{ mcp?: ProjectMcpSettings; skills?: ProjectSkillSettings }> | { mcp?: ProjectMcpSettings; skills?: ProjectSkillSettings };
  /** Менеджер сессий. Задан — регистрируется `GET /:id/stats`. */
  sessionManager?: ProjectStatsSource;
}

/**
 * План проекта (AD-039): структурированный объект ProjectPlan, создаётся/редактируется
 * движком (plan_write). Отдельной zod-схемы в shared нет — принимаем произвольный
 * объект (перенос между мирами), null очищает план.
 */
const planFieldSchema = z.unknown().nullable().optional();

/** Мутирующие поля контента проекта (всё, кроме `workspace`): требуют прав редактора. */
const projectContentFields = [
  'name', 'description', 'current_task', 'invariants', 'icon', 'color', 'repos', 'plan',
] as const;

/** Сообщение о недопустимом значении метаданных с перечнем допустимых ключей. */
function invalidMetaMessage(label: 'icon' | 'color', value: unknown, allowed: readonly string[]): string {
  return `Недопустимое значение ${label}: "${String(value)}". Допустимые: ${allowed.join(', ')}`;
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

/**
 * API проектов (AD-014/AD-017/AD-075). Единая реализация для core (standalone)
 * и backend (managed): RBAC-хуки, i18n-сообщения, MCP-скоуп (AD-071 §2.4) и
 * статистика задаются через `opts`. Гибридные ветки активны только при переданном
 * `getRemoteClient` (managed его не передаёт).
 */
export function createProjectRoutes(
  auth: ProjectRoutesAuth,
  store: ProjectStore,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts: ProjectRoutesOptions = {},
): Hono {
  const app = new Hono();
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  const workspaceRoot = (): string | undefined => opts.getWorkspacesRoot?.() || undefined;
  const outsideRootPolicy = (): WorkspaceOutsideRootPolicy => opts.getOutsideRootPolicy?.() ?? 'confirm';
  const managed = opts.autoProvisionWorkspace === true;

  const currentUserId = async (c: Context): Promise<string> =>
    opts.getCurrentUserId ? await opts.getCurrentUserId(c) : 'local';
  const canManage = (c: Context, project: Project, userId: string): boolean =>
    opts.canManage ? opts.canManage(c, project, userId) : true;
  const canEditContent = (c: Context, project: Project, userId: string): boolean =>
    opts.canEditContent ? opts.canEditContent(c, project, userId) : true;
  const canRead = (c: Context, project: Project, userId: string): boolean =>
    opts.canRead ? opts.canRead(c, project, userId) : true;

  const messages: ProjectRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  const jsonForbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);
  const jsonNotFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.notFound(c) } }, 404);

  app.get('/', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    // AD-089: elevated (ADMIN/LEAD) — все проекты; иначе — проекты пользователя.
    const elevated = (await opts.resolveElevated?.(c)) ?? false;
    const userId = await currentUserId(c);
    const projects = elevated ? await store.list() : await store.list(userId);
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
    const remoteClient = resolveClient();
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.nameRequired(c) } }, 400);
    }

    // Метаданные (icon/color): только канонические ключи; null/undefined — сброс.
    if (body.icon !== undefined && body.icon !== null && !isProjectIconKey(body.icon)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('icon', body.icon, PROJECT_ICON_KEYS) },
      }, 400);
    }
    if (body.color !== undefined && body.color !== null && !isProjectColorKey(body.color)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('color', body.color, PROJECT_COLOR_KEYS) },
      }, 400);
    }

    // AD-075: нормализация + создание каталога workspace (managed — авто-имя).
    const resolved = await provisionWorkspace(
      store,
      name,
      body.workspace,
      body.confirmOutsideRoot,
      workspaceRoot(),
      outsideRootPolicy(),
      managed,
    );
    if (!resolved.ok) {
      return c.json({ error: { code: resolved.code, message: resolved.message } }, resolved.status);
    }

    // AD-071 §2.4 / AD-046 §4.5: сид скоупа проекта из системных дефолтов.
    const seeds = await Promise.resolve(opts.getProjectSeeds?.()).catch(() => undefined);

    const project = store.create(name, await currentUserId(c), {
      description: body.description,
      icon: body.icon ?? undefined,
      color: body.color ?? undefined,
      workspace: resolved.workspace,
      repos: body.repos || undefined,
      ...(seeds ? { mcp: seeds.mcp, skills: seeds.skills } : {}),
    });
    const planResult = planFieldSchema.safeParse(body.plan);
    if (planResult.success && planResult.data !== undefined) {
      project.plan = (planResult.data ?? undefined) as Project['plan'] | undefined;
    }
    await store.save(project);
    return c.json(serializeProject(project), 201);
  });

  app.get('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
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
      return jsonNotFound(c);
    }
    // AD-089: чтение проекта — owner / любой участник / LEAD / ADMIN. Права на
    // редактирование (canManage/canEditContent) этим не расширяются.
    if (!canRead(c, project, await currentUserId(c))) {
      return jsonForbidden(c);
    }
    return c.json(serializeProject(project));
  });

  // AD-071 §2.4: проектный MCP-скоуп (только при заданном источнике серверов).
  if (opts.getMcpServers) {
    const knownMcpServers = (): string[] => opts.getMcpServers?.() ?? [];

    app.get('/:id/mcp', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canManage(c, project, userId)) return jsonForbidden(c);
      return c.json({
        enabled: project.mcp?.enabled ?? [],
        defaultOn: project.mcp?.defaultOn ?? [],
        knownServers: knownMcpServers(),
      });
    });

    app.put('/:id/mcp', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canManage(c, project, userId)) return jsonForbidden(c);

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
  }

  app.put('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
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
      return jsonNotFound(c);
    }
    const body = await c.req.json().catch(() => ({}));
    const userId = await currentUserId(c);

    // D5: горизонтальная авторизация. Проверки до любых мутаций — при отказе
    // проект не меняется вовсе.
    // - смена workspace — только владелец / LEAD / ADMIN (AD-075);
    // - изменение контента (name/description/…/plan) — владелец / EDITOR / LEAD / ADMIN.
    if (body.workspace !== undefined && !canManage(c, project, userId)) {
      return jsonForbidden(c);
    }
    if (
      projectContentFields.some((field) => body[field] !== undefined)
      && !canEditContent(c, project, userId)
    ) {
      return jsonForbidden(c);
    }

    // Метаданные (icon/color): только канонические ключи; null/undefined — сброс.
    if (body.icon !== undefined && body.icon !== null && !isProjectIconKey(body.icon)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('icon', body.icon, PROJECT_ICON_KEYS) },
      }, 400);
    }
    if (body.color !== undefined && body.color !== null && !isProjectColorKey(body.color)) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: invalidMetaMessage('color', body.color, PROJECT_COLOR_KEYS) },
      }, 400);
    }

    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description;
    if (body.current_task !== undefined) project.currentTask = body.current_task;
    if (body.invariants !== undefined) project.invariants = body.invariants;
    if (body.icon !== undefined) project.icon = body.icon ?? undefined;
    if (body.color !== undefined) project.color = body.color ?? undefined;
    if (body.workspace !== undefined) {
      if (managed) {
        if (typeof body.workspace === 'string' && body.workspace.trim()) {
          const resolved = await provisionWorkspace(
            store,
            body.name ?? project.name,
            body.workspace,
            body.confirmOutsideRoot,
            workspaceRoot(),
            outsideRootPolicy(),
            true,
          );
          if (!resolved.ok) {
            return c.json({ error: { code: resolved.code, message: resolved.message } }, resolved.status);
          }
          project.workspace = resolved.workspace;
        } else {
          // Явная очистка workspace — без авто-имени.
          project.workspace = undefined;
        }
      } else if (typeof body.workspace === 'string') {
        // AD-075: нормализация + создание каталога workspace (mkdir -p).
        const resolved = await resolveWorkspaceForLocalProject(
          body.workspace,
          body.confirmOutsideRoot,
          workspaceRoot(),
          outsideRootPolicy(),
        );
        if (!resolved.ok) {
          return c.json({ error: { code: resolved.code, message: resolved.message } }, resolved.status);
        }
        project.workspace = resolved.workspace;
      } else {
        project.workspace = body.workspace || undefined;
      }
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

  app.delete('/:id', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
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
      return jsonNotFound(c);
    }
    const userId = await currentUserId(c);
    if (!canManage(c, project, userId)) {
      return jsonForbidden(c);
    }
    await store.delete(project.id);
    return c.body(null, 204);
  });

  if (opts.sessionManager) {
    const sessionManager = opts.sessionManager;

    // GET /api/v2/projects/:id/stats
    app.get('/:id/stats', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
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
  }

  return app;
}
