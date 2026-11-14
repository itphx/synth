/**
 * ADR-126 §4: HTTP-контур сниппетов (`#`).
 *
 * Одна реализация для standalone (core) и managed (backend): различаются
 * только guard'ы, резолвер пользователя и тексты (`opts`) — как у
 * `createSkillRoutes`/`createCommandRoutes`.
 *
 * | Маршрут | Назначение |
 * |---|---|
 * | `GET /api/v2/snippets` | список (`?projectId=`, `?scope=`) + диагностика |
 * | `POST /api/v2/snippets` | создание (`instance` / `project` / `user`) |
 * | `PATCH /api/v2/snippets/:name` | правка / переименование / перенос уровня |
 * | `DELETE /api/v2/snippets/:name` | удаление |
 * | `POST /api/v2/snippets/expand` | предпросмотр раскрытия (без записи) |
 *
 * Права (ADR-126 §4 «Кто пишет»):
 * - `instance` — администратор (guard `opts.writeGuard`; standalone — пользователь один);
 * - `user` — только сам пользователь (каталог изолирован по `userId`);
 * - `project` — право изменения содержимого проекта (`OWNER`/`EDITOR`, инвариант 21).
 *
 * Доступ к проекту проверяется **на границе** (инвариант 16): правила проекта
 * приходят из `opts.canReadProject`/`opts.canEditProject` (в backend — общий
 * резолвер `resolveProjectAccess`), копии предиката здесь нет.
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Project } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { SnippetError } from '../../engine/snippets/service.js';
import type { SnippetErrorCode, SnippetService } from '../../engine/snippets/service.js';
import { SNIPPET_NAME_REGEX, SNIPPET_SCOPES } from '../../engine/snippets/types.js';
import type { Snippet, SnippetScope } from '../../engine/snippets/types.js';
import { LOCAL_USER_ID } from '../local-owner.js';

/** Структурный контракт хранилища проектов (core/backend реализации совместимы). */
export interface SnippetProjectStore {
  load(id: string): Promise<Project | null>;
}

export interface SnippetRoutesDeps {
  /** Доменный сервис сниппетов (ADR-126 §4). */
  snippetService: SnippetService;
  /** Порт хранилища проектов (ADR-096): доступ к проекту и его workspace. */
  projectStore?: SnippetProjectStore;
  /** Резолв абсолютного рабочего каталога проекта по id (project-сниппеты). */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
}

export interface SnippetRoutesMessages {
  notFound: string;
  validation: string;
  conflict: string;
  forbidden: string;
  instanceForbidden: string;
  projectRequired: string;
}

const DEFAULT_MESSAGES: SnippetRoutesMessages = {
  notFound: 'Сниппет не найден',
  validation: 'Некорректные данные сниппета',
  conflict: 'Сниппет уже существует',
  forbidden: 'Недостаточно прав для операции со сниппетом',
  instanceForbidden: 'Запись инстансных сниппетов доступна только администратору',
  projectRequired: 'Для проектного сниппета нужен projectId',
};

export interface SnippetRoutesOptions {
  /**
   * Guard записи инстанс-уровня (managed — `requireAdmin`).
   *
   * Guard вызывается **внутри** обработчика: уровень сниппета известен из
   * тела запроса, поэтому навесить middleware на маршрут целиком нельзя —
   * иначе запись user/project-уровня закрылась бы для не-ADMIN.
   */
  writeGuard?: MiddlewareHandler;
  /** Право записи инстанс-уровня (managed — роль ADMIN). */
  canWriteInstance?: (c: Context) => boolean | Promise<boolean>;
  /** userId текущего запроса (core — `local`, backend — id пользователя). */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Право чтения проекта (не задано — разрешено; standalone — пользователь один). */
  canReadProject?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** Право изменения содержимого проекта (не задано — разрешено). */
  canEditProject?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** Сообщения (backend — i18n). */
  messages?: (c: Context) => SnippetRoutesMessages;
}

/** Доменный код ошибки → HTTP-код и код API (ADR-126 §4, общий формат `{error:{code,message}}`). */
const SNIPPET_ERROR_HTTP: Record<SnippetErrorCode, { status: 400 | 404 | 409; code: string }> = {
  'invalid-name': { status: 400, code: 'VALIDATION_ERROR' },
  'invalid-alias': { status: 400, code: 'VALIDATION_ERROR' },
  'missing-user': { status: 400, code: 'VALIDATION_ERROR' },
  'missing-workspace': { status: 400, code: 'VALIDATION_ERROR' },
  'not-found': { status: 404, code: 'NOT_FOUND' },
  'conflict': { status: 409, code: 'CONFLICT' },
};

const snippetCreateSchema = z
  .object({
    name: z.string(),
    body: z.string(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    scope: z.enum(SNIPPET_SCOPES),
    projectId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

const snippetUpdateSchema = z
  .object({
    name: z.string().optional(),
    body: z.string().optional(),
    /** `null` — сброс описания. */
    description: z.string().nullable().optional(),
    /** `[]` — сброс алиасов. */
    aliases: z.array(z.string()).optional(),
    scope: z.enum(SNIPPET_SCOPES).optional(),
    projectId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

const snippetExpandSchema = z
  .object({
    text: z.string(),
    projectId: z.string().optional(),
  })
  .strict();

/** Слот записи: уровень + контекст (пользователь / рабочий каталог проекта). */
interface WriteTarget {
  scope: SnippetScope;
  /** Владелец user-уровня (всегда — текущий пользователь). */
  userId?: string;
  /** Рабочий каталог project-уровня. */
  projectWorkspace?: string;
  /** id проекта (project-уровень) — нужен для проверки права. */
  projectId?: string;
}

/** Найденный сниппет + слот, в котором он лежит. */
interface ResolvedSnippet {
  snippet: Snippet;
  target: WriteTarget;
}

/**
 * ADR-126 §4: HTTP-контур сниппетов.
 */
export function createSnippetRoutes(
  auth: AuthKit,
  deps: SnippetRoutesDeps,
  opts?: SnippetRoutesOptions,
): Hono {
  const app = new Hono();
  const messages = (c: Context): SnippetRoutesMessages => opts?.messages?.(c) ?? DEFAULT_MESSAGES;
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);

  const jsonError = (
    c: Context,
    status: 400 | 403 | 404 | 409 | 500,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);

  const notFound = (c: Context) =>
    jsonError(c, 404, 'NOT_FOUND', messages(c).notFound);

  const forbidden = (c: Context) =>
    jsonError(c, 403, 'FORBIDDEN', messages(c).forbidden);

  const validationError = (c: Context, detail?: string) =>
    jsonError(
      c,
      400,
      'VALIDATION_ERROR',
      detail ? `${messages(c).validation}: ${detail}` : messages(c).validation,
    );

  /** Прогон доменной операции с маппингом `SnippetError` → HTTP. */
  const runSnippetOp = async <T>(
    c: Context,
    op: () => Promise<T>,
  ): Promise<T | Response> => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof SnippetError) {
        const mapped = SNIPPET_ERROR_HTTP[err.code] ?? SNIPPET_ERROR_HTTP['invalid-name'];
        return jsonError(c, mapped.status, mapped.code, err.message, { reason: err.code });
      }
      throw err;
    }
  };

  /** Имя сниппета: `[a-z][a-z0-9_-]{0,79}` (ADR-126 §4 «Формат»). */
  const validateName = (c: Context, raw: string): Response | undefined => {
    const name = raw.trim();
    if (!SNIPPET_NAME_REGEX.test(name)) {
      return validationError(c, `недопустимое имя "${raw}"`);
    }
    return undefined;
  };

  /** Право записи инстанс-уровня: guard (managed — ADMIN) + предикат. */
  const authorizeInstanceWrite = async (c: Context): Promise<Response | undefined> => {
    if (opts?.canWriteInstance && !(await opts.canWriteInstance(c))) {
      return jsonError(c, 403, 'FORBIDDEN', messages(c).instanceForbidden);
    }
    const guard = opts?.writeGuard;
    if (!guard) return undefined;
    // Guard — middleware: вызываем вручную, `next` ничего не делает. Отказ
    // возвращает готовый ответ (401/403) — отдаём его как есть.
    const denied = await guard(c, async () => {});
    return denied instanceof Response ? denied : undefined;
  };

  /** Рабочий каталог проекта (абсолютный). */
  const resolveWorkspace = async (
    projectId: string,
    project: Project,
  ): Promise<string | undefined> => {
    if (deps.resolveProjectWorkspace) {
      const resolved = await deps.resolveProjectWorkspace(projectId).catch(() => undefined);
      if (resolved) return resolved;
    }
    return project.workspace;
  };

  /**
   * Доступ к проекту (на границе, инвариант 16): проект + workspace.
   *
   * `access: 'read'` — право чтения, `'write'` — право изменения содержимого
   * (`OWNER`/`EDITOR`; `VIEWER` читает, но не мутирует — инвариант 21).
   */
  const authorizeProject = async (
    c: Context,
    projectId: string,
    access: 'read' | 'write',
  ): Promise<{ project: Project; workspace: string } | Response> => {
    if (!deps.projectStore) {
      return jsonError(c, 500, 'INTERNAL_ERROR', 'projectStore не настроен');
    }
    const project = await deps.projectStore.load(projectId);
    if (!project) return notFound(c);
    const userId = await resolveUserId(c);
    const allowed =
      access === 'read'
        ? opts?.canReadProject
          ? await opts.canReadProject(c, project, userId)
          : true
        : opts?.canEditProject
          ? await opts.canEditProject(c, project, userId)
          : true;
    if (!allowed) return forbidden(c);
    const workspace = await resolveWorkspace(projectId, project);
    if (!workspace) {
      return validationError(c, 'у проекта не задан рабочий каталог');
    }
    return { project, workspace };
  };

  /** Слот записи по уровню (с проверкой прав). */
  const buildWriteTarget = async (
    c: Context,
    scope: SnippetScope,
    input: { projectId?: string; userId?: string },
  ): Promise<WriteTarget | Response> => {
    if (scope === 'instance') {
      const denied = await authorizeInstanceWrite(c);
      if (denied) return denied;
      return { scope: 'instance' };
    }
    if (scope === 'user') {
      const current = (await resolveUserId(c)).trim();
      const requested = input.userId?.trim();
      if (requested && requested !== current) {
        // Чужой user-уровень: писать в каталог другого пользователя нельзя.
        return forbidden(c);
      }
      if (!current) return validationError(c, 'не удалось определить пользователя');
      return { scope: 'user', userId: current };
    }
    const projectId = input.projectId?.trim();
    if (!projectId) return validationError(c, messages(c).projectRequired);
    const access = await authorizeProject(c, projectId, 'write');
    if (access instanceof Response) return access;
    return { scope: 'project', projectId, projectWorkspace: access.workspace };
  };

  /** Право на изменение сниппета в конкретном слоте. */
  const authorizeSlotWrite = async (c: Context, target: WriteTarget): Promise<Response | undefined> => {
    if (target.scope === 'instance') return authorizeInstanceWrite(c);
    if (target.scope === 'project' && target.projectId) {
      const access = await authorizeProject(c, target.projectId, 'write');
      return access instanceof Response ? access : undefined;
    }
    // user-уровень: каталог изолирован по `userId` — чужой сниппет не виден.
    return undefined;
  };

  /** Контекст доменного сервиса для слота. */
  const slotContext = (target: WriteTarget): { userId?: string; projectWorkspace?: string } => ({
    ...(target.userId ? { userId: target.userId } : {}),
    ...(target.projectWorkspace ? { projectWorkspace: target.projectWorkspace } : {}),
  });

  /**
   * Поиск сниппета по каноническому имени в видимом контексте
   * (user-уровень текущего пользователя + instance + project по `projectId`).
   *
   * Источник — **видимый** сниппет (слияние уровней `user > project > instance`),
   * как его разрешает `#name` в чате; целевой уровень задаёт тело PATCH.
   */
  const findSnippet = async (
    c: Context,
    name: string,
    input: { projectId?: string },
  ): Promise<ResolvedSnippet | Response | undefined> => {
    const userId = await resolveUserId(c);
    let workspace: string | undefined;
    if (input.projectId) {
      const access = await authorizeProject(c, input.projectId, 'read');
      if (access instanceof Response) return access;
      workspace = access.workspace;
    }
    const { snippets } = await deps.snippetService.list({
      userId,
      projectWorkspace: workspace,
    });
    const found = snippets.find((s) => s.name === name);
    if (!found) return undefined;
    const target: WriteTarget =
      found.scope === 'user'
        ? { scope: 'user', userId }
        : found.scope === 'project'
          ? { scope: 'project', projectId: input.projectId, projectWorkspace: workspace }
          : { scope: 'instance' };
    return { snippet: found, target };
  };

  // Список сниппетов: instance + свой user-уровень (+ project — при доступе).
  app.get('/', auth.requireAuth, async (c) => {
    const scopeQuery = c.req.query('scope');
    if (scopeQuery && !SNIPPET_SCOPES.includes(scopeQuery as SnippetScope)) {
      return validationError(c, `неизвестный уровень "${scopeQuery}"`);
    }
    const scopeFilter = scopeQuery as SnippetScope | undefined;
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const userId = await resolveUserId(c);
    let projectWorkspace: string | undefined;
    if (projectId) {
      const access = await authorizeProject(c, projectId, 'read');
      if (access instanceof Response) return access;
      projectWorkspace = access.workspace;
    }
    const { snippets, diagnostics } = await deps.snippetService.list({
      userId,
      projectWorkspace,
    });
    const visible = scopeFilter
      ? snippets.filter((s) => s.scope === scopeFilter)
      : snippets;
    return c.json({ snippets: visible, diagnostics });
  });

  // Предпросмотр раскрытия `#`-токенов (без записи).
  app.post('/expand', auth.requireAuth, async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = snippetExpandSchema.safeParse(raw);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
    }
    const userId = await resolveUserId(c);
    let projectWorkspace: string | undefined;
    const projectId = parsed.data.projectId?.trim();
    if (projectId) {
      const access = await authorizeProject(c, projectId, 'read');
      if (access instanceof Response) return access;
      projectWorkspace = access.workspace;
    }
    const result = await runSnippetOp(c, () =>
      deps.snippetService.expandText(parsed.data.text, { userId, projectWorkspace }),
    );
    if (result instanceof Response) return result;
    return c.json({ text: result.text, applied: result.applied, diagnostics: result.diagnostics });
  });

  // Создание сниппета.
  app.post('/', auth.requireAuth, async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = snippetCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;
    const name = input.name.trim();
    if (!SNIPPET_NAME_REGEX.test(name)) {
      return validationError(c, `недопустимое имя "${input.name}"`);
    }
    const target = await buildWriteTarget(c, input.scope, {
      projectId: input.projectId,
      userId: input.userId,
    });
    if (target instanceof Response) return target;
    const created = await runSnippetOp(c, () =>
      deps.snippetService.create({
        name,
        body: input.body,
        description: input.description?.trim() || undefined,
        aliases: input.aliases,
        scope: target.scope,
        ...slotContext(target),
      }),
    );
    if (created instanceof Response) return created;
    return c.json(created, 201);
  });

  // Правка / переименование / перенос уровня.
  app.patch('/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    const nameError = validateName(c, name);
    if (nameError) return nameError;
    const raw = await c.req.json().catch(() => ({}));
    const parsed = snippetUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
    }
    const patch = parsed.data;
    const projectId = patch.projectId?.trim() || undefined;
    if (patch.scope === 'project' && !projectId) {
      return validationError(c, messages(c).projectRequired);
    }
    const found = await findSnippet(c, name.trim(), { projectId });
    if (found instanceof Response) return found;
    if (!found) return notFound(c);
    // Право на исходный слот (перезапись/удаление исходного сниппета).
    const sourceDenied = await authorizeSlotWrite(c, found.target);
    if (sourceDenied) return sourceDenied;
    // Целевой слот (может отличаться — перенос между уровнями).
    const finalScope = patch.scope ?? found.target.scope;
    const target = await buildWriteTarget(c, finalScope, {
      projectId,
      userId: patch.userId,
    });
    if (target instanceof Response) return target;

    const newName = (patch.name ?? found.snippet.name).trim();
    if (!SNIPPET_NAME_REGEX.test(newName)) {
      return validationError(c, `недопустимое имя "${patch.name}"`);
    }
    const newBody = patch.body ?? found.snippet.body;
    const newDescription =
      'description' in patch
        ? patch.description?.trim() || undefined
        : found.snippet.description;
    const newAliases = 'aliases' in patch ? patch.aliases ?? [] : found.snippet.aliases;

    const sameSlot = finalScope === found.target.scope && newName === found.snippet.name;
    if (sameSlot) {
      const updated = await runSnippetOp(c, () =>
        deps.snippetService.update({
          name: newName,
          body: newBody,
          description: newDescription,
          aliases: newAliases,
          scope: finalScope,
          ...slotContext(target),
        }),
      );
      if (updated instanceof Response) return updated;
      return c.json(updated);
    }

    // Перенос/переименование: создать в новом слоте, затем убрать старый.
    const created = await runSnippetOp(c, () =>
      deps.snippetService.create({
        name: newName,
        body: newBody,
        description: newDescription,
        aliases: newAliases,
        scope: finalScope,
        ...slotContext(target),
      }),
    );
    if (created instanceof Response) return created;
    const removed = await runSnippetOp(c, () =>
      deps.snippetService.delete({
        name: found.snippet.name,
        scope: found.target.scope,
        ...slotContext(found.target),
      }),
    );
    if (removed instanceof Response) {
      // Откат: новый слот убран, исходный остался на месте.
      await deps.snippetService
        .delete({ name: newName, scope: finalScope, ...slotContext(target) })
        .catch(() => false);
      return removed;
    }
    return c.json(created);
  });

  // Удаление сниппета.
  app.delete('/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    const nameError = validateName(c, name);
    if (nameError) return nameError;
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const found = await findSnippet(c, name.trim(), { projectId });
    if (found instanceof Response) return found;
    if (!found) return notFound(c);
    const denied = await authorizeSlotWrite(c, found.target);
    if (denied) return denied;
    const removed = await runSnippetOp(c, () =>
      deps.snippetService.delete({
        name: found.snippet.name,
        scope: found.target.scope,
        ...slotContext(found.target),
      }),
    );
    if (removed instanceof Response) return removed;
    if (!removed) return notFound(c);
    return c.json({ status: 'deleted', name: found.snippet.name, scope: found.target.scope });
  });

  return app;
}
