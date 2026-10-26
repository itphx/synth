import { z } from 'zod';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { Project, Session, WorkspaceOutsideRootPolicy, ProjectMcpSettings, ProjectSkillSettings } from '@itphx/synth-shared';
import {
  projectMcpUpdateSchema,
  projectMemoryUpdateSchema,
  PROJECT_ICON_KEYS,
  PROJECT_COLOR_KEYS,
  isProjectIconKey,
  isProjectColorKey,
} from '@itphx/synth-shared';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { provisionWorkspace, resolveWorkspaceForLocalProject } from '../../engine/workspace-provision.js';
import { serializeProject } from '../serialize.js';
import { isRemoteRef, toLocalId, toRemote, mergeItems, remoteErrorToHttp } from '../../remote/aggregate.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { WorktreeService } from '../../engine/worktree/service.js';
import { isWorktreeError, worktreeErrorHttpStatus } from '../../engine/worktree/errors.js';
import { worktreeCreateSchema } from '@itphx/synth-shared';

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
 * ADR-075: опции provisioning workspace локальных проектов (core standalone).
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
   * Managed-режим (ADR-075): включает строгую проверку явного пути (deny вне root)
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
   * ADR-089: доступ на чтение проекта по id (owner / любой `members` / LEAD / ADMIN).
   * Не задан — разрешено (standalone). Мутации (`canManage`/`canEditContent`) не
   * расширяются этим предикатом — VIEWER не получает прав на редактирование.
   */
  canRead?: (c: Context, project: Project, userId: string) => boolean;
  /**
   * ADR-089: сквозной обзор (ADMIN/LEAD) — `GET /` возвращает все проекты.
   * `undefined`/`false` — прежнее поведение (проекты пользователя).
   */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /** Сообщения (backend — i18n). */
  messages?: Partial<ProjectRouteMessages>;
  /**
   * Источник известных MCP-серверов (ADR-071 §2.4). Задан — регистрируются
   * `GET/PUT /:id/mcp` (RBAC — через `canManage`). Не задан — роутов нет.
   */
  getMcpServers?: () => string[];
  /**
   * ADR-071 §2.4 / ADR-046 §4.5: сид скоупа нового проекта (снимок системных
   * дефолтов). Не задан — проект создаётся без `mcp`/`skills` (legacy-гейт открыт).
   */
  getProjectSeeds?: () => Promise<{ mcp?: ProjectMcpSettings; skills?: ProjectSkillSettings }> | { mcp?: ProjectMcpSettings; skills?: ProjectSkillSettings };
  /** Менеджер сессий. Задан — регистрируется `GET /:id/stats`. */
  sessionManager?: ProjectStatsSource;
  /**
   * ADR-114: сервис worktree'ов проекта.
   *
   * Задан — регистрируется контур `/id/worktrees*` (список/создание/удаление/
   * prune). Не задан — роутов нет (поведение прежнее). Сервис создаётся в
   * composition root (`server/app/deps.ts`, `backend/app/deps.ts`) и
   * передаётся готовым: он знает корень worktree'ов, порт инвентаря и хук
   * `onUpdated` (публикация `worktree.updated`).
   */
  worktrees?: WorktreeService;
  /**
   * ADR-114: уведомление «инвентарь worktree'ов проекта изменился».
   *
   * Хук сервиса (`WorktreeService.onUpdated`) уже публикует событие шины,
   * поэтому этот колбэк — только для вызывающих, которым нужно **дополнительное**
   * уведомление (например, инвалидация кэша UI). Не задан — ничего не вызывается.
   */
  onWorktreeUpdated?: (projectId: string) => void;
}

/**
 * План проекта (ADR-039): структурированный объект ProjectPlan, создаётся/редактируется
 * движком (plan_write). Отдельной zod-схемы в shared нет — принимаем произвольный
 * объект (перенос между мирами), null очищает план.
 */
const planFieldSchema = z.unknown().nullable().optional();

/** Мутирующие поля контента проекта (всё, кроме `workspace`): требуют прав редактора. */
const projectContentFields = [
  'name', 'description', 'current_task', 'invariants', 'icon', 'color', 'repos', 'plan', 'memory',
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
 * API проектов (ADR-014/ADR-017/ADR-075). Единая реализация для core (standalone)
 * и backend (managed): RBAC-хуки, i18n-сообщения, MCP-скоуп (ADR-071 §2.4) и
 * статистика задаются через `opts`. Гибридные ветки активны только при переданном
 * `getRemoteClient` (managed его не передаёт).
 */
export function createProjectRoutes(
  auth: ProjectRoutesAuth,
  store: ProjectRepository,
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
    // ADR-089: elevated (ADMIN/LEAD) — все проекты; иначе — проекты пользователя.
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

    // ADR-075: нормализация + создание каталога workspace (managed — авто-имя).
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

    // ADR-071 §2.4 / ADR-046 §4.5: сид скоупа проекта из системных дефолтов.
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
    // ADR-089: чтение проекта — owner / любой участник / LEAD / ADMIN. Права на
    // редактирование (canManage/canEditContent) этим не расширяются.
    if (!canRead(c, project, await currentUserId(c))) {
      return jsonForbidden(c);
    }
    return c.json(serializeProject(project));
  });

  // ADR-071 §2.4: проектный MCP-скоуп (только при заданном источнике серверов).
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
    // - смена workspace — только владелец / LEAD / ADMIN (ADR-075);
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

    // ADR-107: политика памяти проекта (`{enabled}`). Поле не задано — не
    // трогаем; `enabled: undefined` внутри объекта тоже не затирает значение.
    if (body.memory !== undefined) {
      const parsedMemory = projectMemoryUpdateSchema.safeParse(body.memory);
      if (!parsedMemory.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedMemory.error.message } }, 400);
      }
      if (parsedMemory.data.enabled !== undefined) {
        project.memory = { ...project.memory, enabled: parsedMemory.data.enabled };
      }
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
        // ADR-075: нормализация + создание каталога workspace (mkdir -p).
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

  // ADR-114: контур worktree'ов проекта (инвентарь, создание, удаление, prune).
  // Права — по правилам проекта (инвариант 21): чтение — право чтения,
  // мутации — право изменения содержимого (`VIEWER` читает, но не мутирует).
  if (opts.worktrees) {
    const worktrees = opts.worktrees;

    /** Ошибка подсистемы worktree → HTTP-ответ (код + статус из карты ошибок). */
    const worktreeError = (c: Context, err: unknown): Response => {
      if (!isWorktreeError(err)) {
        return c.json(
          { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } },
          500,
        );
      }
      const status = worktreeErrorHttpStatus(err.code);
      // `WORKTREE_DIRTY` — нужен явный `force`: признак отдаётся в теле,
      // чтобы UI показал подтверждение, а не «ошибку без деталей».
      const forceRequired = err.code === 'WORKTREE_DIRTY';
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(forceRequired ? { forceRequired: true } : {}),
          },
        },
        status,
      );
    };

    // Список worktree'ов проекта.
    app.get('/:id/worktrees', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canRead(c, project, userId)) return jsonForbidden(c);
      const summaries = await worktrees.list(project.id, project);
      return c.json({ worktrees: summaries });
    });

    // Создание worktree'а. Статический сегмент `prune` объявлен ниже, но
    // пути различаются по методу — конфликта нет.
    app.post('/:id/worktrees', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);

      const body = await c.req.json().catch(() => ({}));
      const parsed = worktreeCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }

      try {
        const result = await worktrees.create(project.id, project, parsed.data, userId);
        opts.onWorktreeUpdated?.(project.id);
        return c.json(
          { worktree: result.worktree, ...(result.setup ? { setup: result.setup } : {}) },
          201,
        );
      } catch (err) {
        return worktreeError(c, err);
      }
    });

    // Prune: записи без каталога + `git worktree prune`.
    app.post('/:id/worktrees/prune', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);
      try {
        const result = await worktrees.prune(project.id, project);
        if (result.recordsRemoved > 0) opts.onWorktreeUpdated?.(project.id);
        return c.json({ recordsRemoved: result.recordsRemoved, gitPruned: result.gitPruned });
      } catch (err) {
        return worktreeError(c, err);
      }
    });

    // Удаление worktree'а: `?force=true` — снимать и с незакоммиченными
    // изменениями; `?force` без значения тоже трактуется как true.
    app.delete('/:id/worktrees/:wid', auth.requireAuth, async (c) => {
      const project = await store.load(c.req.param('id'));
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);
      const forceParam = c.req.query('force');
      const force = forceParam === 'true' || forceParam === '1' || forceParam === '';
      try {
        await worktrees.remove(project.id, c.req.param('wid'), project, force ? { force: true } : {});
        opts.onWorktreeUpdated?.(project.id);
        return c.body(null, 204);
      } catch (err) {
        return worktreeError(c, err);
      }
    });
  }

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
