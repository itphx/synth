import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { Project, Session, WorkspaceOutsideRootPolicy, ProjectMcpSettings, ProjectSkillSettings } from '@itphx/synth-shared';
import {
  projectMcpUpdateSchema,
  projectMemoryUpdateSchema,
  projectPlanSchema,
  PROJECT_ICON_KEYS,
  PROJECT_COLOR_KEYS,
  isProjectIconKey,
  isProjectColorKey,
} from '@itphx/synth-shared';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import { provisionWorkspace, resolveWorkspaceForLocalProject } from '../../engine/workspace-provision.js';
import { serializeProject, serializeProjectSummary } from '../serialize.js';
import { paginate, parseBoundedInt } from '../pagination.js';
import {
  isRemoteRef, toLocalId, toRemote, mergeItems, remoteErrorToHttp,
  toRemoteWorktree, toRemoteWorktreeList,
} from '../../remote/aggregate.js';
// Гибридный merge списков: общий порядок миров + нарезка страницы после merge.
import { localEntries, remoteEntries, sortHybridList } from './hybrid-list.js';
import type { HybridListEntry } from './hybrid-list.js';
import { RemoteError } from '../../remote/types.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { WorktreeService, WorktreeUpdateDetail } from '../../engine/worktree/service.js';
import { isWorktreeError, worktreeErrorHttpStatus } from '../../engine/worktree/errors.js';
import { worktreeCreateSchema, worktreePruneSchema } from '@itphx/synth-shared';

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
   * PROP-125: источник каждого известного MCP-сервера (`local`/`server`) — для
   * бейджа «серверный» в UI (панель «Проект» → «MCP-серверы»).
   *
   * Не задан — `sources` пустой (поле в ответе остаётся, UI бейдж не рисует).
   * Remote-ветка (`remote:`-проект) этот источник **не** использует: сервер
   * отдаёт состав и источники своих серверов сам.
   */
  getMcpServerSources?: () => Record<string, 'local' | 'server'>;
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
   *
   * Второй аргумент — что изменилось (`WorktreeUpdateDetail`): действие и,
   * когда известно, id записи (ADR-114 §6).
   */
  onWorktreeUpdated?: (projectId: string, detail: WorktreeUpdateDetail) => void;
  /**
   * ADR-118 §4: проект изменён (`PUT /:id`) или удалён (`DELETE /:id`) —
   * уведомить сессии проекта. Реализация в точке сборки публикует
   * `project.updated`/`project.deleted` в канал каждой сессии проекта
   * (инвентарь/контейнер — ресурс проекта, ADR-014). Для `deleted` колбэк
   * вызывается **до** удаления, пока сессии ещё перечисляются.
   */
  onProjectChanged?: (projectId: string, kind: ProjectChangeKind) => void | Promise<void>;
}

/** Вид изменения проекта для `ProjectRoutesOptions.onProjectChanged`. */
export type ProjectChangeKind = 'updated' | 'deleted';

/**
 * План проекта (ADR-039): структурированный объект `ProjectPlan`.
 *
 * Схема — из `@itphx/synth-shared` (`projectPlanSchema`); `null` очищает план.
 * Неизвестные поля сохраняются (passthrough) — план переносится между мирами
 * и может нести поля, которых ещё нет в модели.
 */
const planFieldSchema = projectPlanSchema.nullable().optional();

/** Мутирующие поля контента проекта (всё, кроме `workspace`): требуют прав редактора. */
const projectContentFields = [
  'name', 'description', 'current_task', 'invariants', 'icon', 'color', 'repos', 'plan', 'memory',
] as const;

/** Сообщение о недопустимом значении метаданных с перечнем допустимых ключей. */
function invalidMetaMessage(label: 'icon' | 'color', value: unknown, allowed: readonly string[]): string {
  return `Недопустимое значение ${label}: "${String(value)}". Допустимые: ${allowed.join(', ')}`;
}

/**
 * Пагинация списка проектов (решение владельца): страница по умолчанию 100,
 * максимум 500 — как у списка сессий (ADR-118 §4).
 */
const DEFAULT_PROJECTS_LIMIT = 100;
const MAX_PROJECTS_LIMIT = 500;

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

  /**
   * GET /api/v2/projects — **страница** списка проектов.
   *
   * Ответ — объект `{projects, total, offset, limit, next_offset}` (массив
   * больше не возвращается — обратная совместимость не поддерживается).
   *
   * DTO проекта в списке — **сводка**: тяжёлые поля `log` (журнал проекта) и
   * `plan` (ADR-039) не отдаются (списком они множили бы объём ответа);
   * полный DTO — в детали `GET /api/v2/projects/:id`.
   */
  app.get('/', auth.requireAuth, async (c) => {
    // Нечисловой/отрицательный `limit`/`offset` → 400 (не молча правим).
    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_PROJECTS_LIMIT, MAX_PROJECTS_LIMIT);
    if (limit === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'limit должен быть целым числом' } }, 400);
    }
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (offset === null) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'offset должен быть целым числом' } }, 400);
    }
    const remoteClient = resolveClient();
    // ADR-089: elevated (ADMIN/LEAD) — все проекты; иначе — проекты пользователя.
    const elevated = (await opts.resolveElevated?.(c)) ?? false;
    const userId = await currentUserId(c);
    const projects = elevated ? await store.list() : await store.list(userId);
    if (!remoteClient) {
      const { page, total, next_offset } = paginate(projects, offset, limit);
      const localDto = page.map(serializeProjectSummary);
      return c.json({ projects: localDto, total, offset, limit, next_offset });
    }
    try {
      // Гибрид: список **обоих** миров. Удалённая сторона забирается целиком
      // (обход страниц), merge сортируется по времени записи, и только потом
      // нарезается страница — иначе порядок «новые сверху» ломался бы на
      // границе миров, а курсор `next_offset` нельзя было бы выдать.
      const remoteAll = await remoteClient.listAllProjects();
      const entries: HybridListEntry<unknown>[] = [
        ...localEntries(projects),
        ...remoteEntries(mergeItems([], remoteAll.items)),
      ];
      const sorted = sortHybridList(entries);
      const { page, total, next_offset } = paginate(sorted, offset, limit);
      const merged = page.map((entry) => (entry.origin === 'local'
        ? serializeProjectSummary(entry.value as Project)
        : entry.value as Record<string, unknown>));
      // Кап страниц удалённого обхода: список неполон — курсор выдавать нельзя.
      if (remoteAll.truncated) {
        console.warn('[hybrid] удалённый список проектов обрезан капом страниц — next_offset не выдаётся');
        return c.json({ projects: merged, total, offset, limit, next_offset: null });
      }
      return c.json({ projects: merged, total, offset, limit, next_offset });
    } catch (err) {
      // Offline-деградация: сервер недоступен — отдаём локальный мир с
      // аддитивным признаком `remote_offline` (ADR-123).
      if (err instanceof RemoteError) {
        console.warn(`[hybrid] удалённый backend недоступен (${err.code}): ${err.message}`);
        const { page, total, next_offset } = paginate(projects, offset, limit);
        const localDto = page.map(serializeProjectSummary);
        return c.json({ projects: localDto, total, offset, limit, next_offset, remote_offline: true });
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
    // PROP-125: источник сервера (`local`/`server`) — бейдж «серверный» в UI.
    // Без опции — пустая карта (контракт ответа единый).
    const sources: () => Record<string, 'local' | 'server'> =
      opts.getMcpServerSources ?? (() => ({}));

    app.get('/:id/mcp', auth.requireAuth, async (c) => {
      const mcpId = c.req.param('id');
      // Гибрид (ADR-042): проектный MCP-скоуп удалённого проекта — на сервере.
      // `knownServers` берём **только** из ответа сервера: локальный реестр к
      // удалённому проекту отношения не имеет (иначе UI показал бы чужие имена).
      if (isRemoteRef(mcpId)) {
        const remoteClient = resolveClient();
        if (!remoteClient) {
          return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
        }
        try {
          return c.json(await remoteClient.getProjectMcp(toLocalId(mcpId)));
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(mcpId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canManage(c, project, userId)) return jsonForbidden(c);
      return c.json({
        enabled: project.mcp?.enabled ?? [],
        defaultOn: project.mcp?.defaultOn ?? [],
        knownServers: knownMcpServers(),
        // PROP-125: источник каждого сервера (`local`/`server`).
        sources: sources(),
      });
    });

    app.put('/:id/mcp', auth.requireAuth, async (c) => {
      const mcpId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const parsed = projectMcpUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }
      // Гибрид (ADR-042): права и известные серверы проверяет сервер проекта —
      // локальный список сюда не подмешивается.
      if (isRemoteRef(mcpId)) {
        const remoteClient = resolveClient();
        if (!remoteClient) {
          return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
        }
        try {
          return c.json(await remoteClient.updateProjectMcp(toLocalId(mcpId), parsed.data));
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(mcpId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canManage(c, project, userId)) return jsonForbidden(c);

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
        // PROP-125 §2: маркер авто-сида (`remoteSeeded`) сохраняем — иначе
        // правка панели стирала бы его и серверный дефолт возвращался в
        // проект при следующем коннекте, хотя пользователь его выключил.
        ...(current.remoteSeeded ? { remoteSeeded: current.remoteSeeded } : {}),
      };
      project.updatedAt = new Date().toISOString();
      await store.save(project);

      return c.json({
        enabled: project.mcp.enabled,
        defaultOn: project.mcp.defaultOn,
        knownServers: knownMcpServers(),
        // PROP-125: источник каждого сервера (`local`/`server`).
        sources: sources(),
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
    // ADR-118 §4: проект изменён — сессии проекта получают `project.updated`
    // (другие клиенты перечитывают проект/план/настройки).
    await opts.onProjectChanged?.(project.id, 'updated');
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
    // ADR-118 §4: уведомляем сессии проекта **до** удаления (пока они видны).
    await opts.onProjectChanged?.(project.id, 'deleted');
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

    /**
     * Гибрид (ADR-042): worktree'ы удалённого проекта исполняет сервер (в
     * managed backend — тот же `WorktreeService`). `id` проекта снимается до
     * локального, id worktree'а уходит как есть (он скоупится проектом).
     */
    const remoteWorktreeClient = (c: Context): RemoteBackendClient | Response => {
      const remoteClient = resolveClient();
      if (!remoteClient) {
        return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
      }
      return remoteClient;
    };

    // Список worktree'ов проекта.
    app.get('/:id/worktrees', auth.requireAuth, async (c) => {
      const wtProjectId = c.req.param('id');
      if (isRemoteRef(wtProjectId)) {
        const remoteClient = remoteWorktreeClient(c);
        if (remoteClient instanceof Response) return remoteClient;
        try {
          const list = (await remoteClient.listProjectWorktrees(toLocalId(wtProjectId))) as Record<string, unknown>;
          return c.json(toRemoteWorktreeList(list));
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(wtProjectId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canRead(c, project, userId)) return jsonForbidden(c);
      const summaries = await worktrees.list(project.id, project);
      return c.json({ worktrees: summaries });
    });

    // Создание worktree'а. Статический сегмент `prune` объявлен ниже, но
    // пути различаются по методу — конфликта нет.
    app.post('/:id/worktrees', auth.requireAuth, async (c) => {
      const wtProjectId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));
      const parsed = worktreeCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400);
      }
      if (isRemoteRef(wtProjectId)) {
        const remoteClient = remoteWorktreeClient(c);
        if (remoteClient instanceof Response) return remoteClient;
        try {
          const created = (await remoteClient.createProjectWorktree(
            toLocalId(wtProjectId),
            parsed.data as Record<string, unknown>,
          )) as Record<string, unknown>;
          return c.json(
            {
              ...(created.worktree && typeof created.worktree === 'object'
                ? { worktree: toRemoteWorktree(created.worktree as Record<string, unknown>) }
                : created),
              ...(created.setup ? { setup: created.setup } : {}),
            },
            201,
          );
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(wtProjectId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);

      try {
        const result = await worktrees.create(project.id, project, parsed.data, userId);
        opts.onWorktreeUpdated?.(project.id, { worktreeId: result.worktree.id, action: 'created' });
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
      const wtProjectId = c.req.param('id');
      // Тело опционально: пустое/отсутствующее — успех. Непустое — строгая
      // схема `worktreePruneSchema` (параметров у операции нет, лишнее поле —
      // ошибка валидации, а не молчаливое игнорирование).
      const rawBody = await c.req.json().catch(() => undefined);
      const bodyIsEmpty = rawBody === undefined
        || rawBody === null
        || (typeof rawBody === 'object' && !Array.isArray(rawBody) && Object.keys(rawBody).length === 0);
      if (!bodyIsEmpty) {
        const parsedPrune = worktreePruneSchema.safeParse(rawBody);
        if (!parsedPrune.success) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: parsedPrune.error.message } }, 400);
        }
      }
      if (isRemoteRef(wtProjectId)) {
        const remoteClient = remoteWorktreeClient(c);
        if (remoteClient instanceof Response) return remoteClient;
        try {
          return c.json(await remoteClient.pruneProjectWorktrees(toLocalId(wtProjectId)));
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(wtProjectId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);
      try {
        const result = await worktrees.prune(project.id, project);
        if (result.recordsRemoved > 0) opts.onWorktreeUpdated?.(project.id, { action: 'pruned' });
        return c.json({ recordsRemoved: result.recordsRemoved, gitPruned: result.gitPruned });
      } catch (err) {
        return worktreeError(c, err);
      }
    });

    // Удаление worktree'а: `?force=true` — снимать и с незакоммиченными
    // изменениями; `?force` без значения тоже трактуется как true.
    app.delete('/:id/worktrees/:wid', auth.requireAuth, async (c) => {
      const wtProjectId = c.req.param('id');
      const forceParam = c.req.query('force');
      const force = forceParam === 'true' || forceParam === '1' || forceParam === '';
      if (isRemoteRef(wtProjectId)) {
        const remoteClient = remoteWorktreeClient(c);
        if (remoteClient instanceof Response) return remoteClient;
        try {
          // id worktree'а — как есть: он адресуется внутри удалённого проекта.
          await remoteClient.removeProjectWorktree(
            toLocalId(wtProjectId),
            c.req.param('wid'),
            force ? { force: true } : {},
          );
          return c.body(null, 204);
        } catch (err) {
          const mapped = mapRemoteError(c, err);
          if (mapped) return mapped;
          throw err;
        }
      }
      const project = await store.load(wtProjectId);
      if (!project) return jsonNotFound(c);
      const userId = await currentUserId(c);
      if (!canEditContent(c, project, userId)) return jsonForbidden(c);
      try {
        const removed = await worktrees.remove(project.id, c.req.param('wid'), project, force ? { force: true } : {});
        opts.onWorktreeUpdated?.(project.id, { worktreeId: removed.id, action: 'removed' });
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
      // Список сессий **всегда лёгкий** (метаданные без истории) — полный
      // список с историями давал пик heap и OOM на больших инстансах.
      // Счётчик сообщений проекта (`total_messages`) **удалён**: по лёгкому
      // списку histories нет, а считать «0» было бы ложью. Число сообщений
      // одной сессии — в `GET /sessions/:id/stats`.
      const sessions = await sessionManager.listSessions({ projectId: project.id });
      let totalInput = 0;
      let totalOutput = 0;
      let totalTotal = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalReasoning = 0;
      for (const s of sessions) {
        totalInput += s.inputTokens;
        totalOutput += s.outputTokens;
        totalTotal += s.totalTokens;
        totalCacheRead += s.cacheReadTokens;
        totalCacheWrite += s.cacheWriteTokens;
        totalReasoning += s.reasoningTokens;
      }
      return c.json({
        total_sessions: sessions.length,
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_tokens: totalTotal,
        total_cache_read_tokens: totalCacheRead,
        total_cache_write_tokens: totalCacheWrite,
        total_reasoning_tokens: totalReasoning,
      });
    });
  }

  return app;
}
