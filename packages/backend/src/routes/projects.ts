import { Hono } from 'hono';
import { z } from 'zod';
import { resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore } from '../storage/project-store.js';
import type { SessionManager, McpManager } from '@itphx/synth-core';
import { serializeProject } from '@itphx/synth-core';
import type { Project } from '@itphx/synth-shared';
import {
  ProjectRole,
  projectMcpUpdateSchema,
  slugifyWorkspaceName,
  uniqueWorkspaceName,
} from '@itphx/synth-shared';
import { t } from '../lib/i18n.js';
import { WorkspaceResolver } from '../lib/workspace-resolver.js';

/**
 * AD-075: результат provisioning workspace managed-проекта.
 * Успех возвращает нормализованный относительный workspace; ошибка — статус/код для API.
 */
type WorkspaceProvisionResult =
  | { ok: true; workspace: string }
  | { ok: false; status: 400 | 403 | 422; code: string; message: string };

/**
 * План проекта (AD-039): структурированный объект ProjectPlan, создаётся/редактируется
 * движком (plan_write). Отдельной zod-схемы в shared нет — принимаем произвольный
 * объект (перенос между мирами), null очищает план.
 */
const planFieldSchema = z.unknown().nullable().optional();

/**
 * AD-076 §T4: RBAC-хелперы проекта (owner/EDITOR/LEAD/ADMIN). Вынесены фабрикой,
 * чтобы их переиспользовали git-роуты core-фабрики (`authorizeProject`), а логика
 * ролей не дублировалась.
 */
export function createProjectAccess(kit: AuthKit) {
  type Ctx = Parameters<typeof kit.isAdmin>[0];

  /** AD-071 §2.4: owner проекта или глобальные LEAD/ADMIN (через AuthKit). */
  const canManageProject = (c: Ctx, project: Project, userId: string): boolean =>
    (typeof kit.isAdmin === 'function' && kit.isAdmin(c))
    || (typeof kit.hasRole === 'function' && kit.hasRole(c, 'LEAD'))
    || project.ownerId === userId
    || project.members?.[userId] === ProjectRole.OWNER;

  /** D5: owner / EDITOR / глобальные LEAD/ADMIN — редактирование контента проекта. */
  const canEditProjectContent = (c: Ctx, project: Project, userId: string): boolean =>
    canManageProject(c, project, userId)
    || project.members?.[userId] === ProjectRole.EDITOR;

  return { canManageProject, canEditProjectContent };
}

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
  const { canManageProject, canEditProjectContent } = createProjectAccess(kit);

  /**
   * D5: мутирующие поля контента проекта (всё, кроме `workspace`). Их изменение
   * требует прав редактора (owner/EDITOR/LEAD/ADMIN), а не просто аутентификации.
   */
  const projectContentFields = [
    'name', 'description', 'current_task', 'invariants', 'icon', 'color', 'repos', 'plan',
  ] as const;

  const knownMcpServers = (): string[] => Object.keys(mcpManager?.getConfig() ?? {});

  /** Все `workspace` известных проектов (относительные — как есть) для авто-имени. */
  async function collectExistingWorkspaces(): Promise<string[]> {
    const projects = await store.list();
    return projects
      .map((p) => p.workspace)
      .filter((w): w is string => typeof w === 'string' && w.length > 0);
  }

  /** D8: имена существующих подкаталогов корня (чтобы авто-имя не «всмерилось» в чужой каталог). */
  async function collectExistingRootDirs(): Promise<string[]> {
    try {
      const entries = await readdir(workspacesRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  const createFailed = (err: unknown): WorkspaceProvisionResult => ({
    ok: false,
    status: 422,
    code: 'WORKSPACE_CREATE_FAILED',
    message: `Не удалось создать каталог workspace: ${err instanceof Error ? err.message : String(err)}`,
  });

  /**
   * AD-075: нормализует и провижнит workspace managed-проекта.
   * - явный путь: `validateWorkspacePath` (абсолютный внутри root → относительный,
   *   вне root / traversal → 403), затем `mkdir -p` (вложенность разрешена);
   * - пустой: авто-имя. `taken` = workspace проектов + существующие подкаталоги root;
   *   имя занимается атомарно `mkdir` без `recursive` (top-level), при `EEXIST`
   *   берётся следующий суффикс `-2`, `-3`, … — два параллельных POST не получат
   *   один и тот же авто-workspace.
   */
  async function provisionWorkspace(name: string, rawWorkspace: unknown): Promise<WorkspaceProvisionResult> {
    if (typeof rawWorkspace === 'string' && rawWorkspace.trim()) {
      const validation = wsResolver.validateWorkspacePath(rawWorkspace);
      if (!validation.ok) return validation;
      try {
        await mkdir(resolve(workspacesRoot, validation.workspace), { recursive: true });
      } catch (err) {
        return createFailed(err);
      }
      return { ok: true, workspace: validation.workspace };
    }

    // Авто-имя: корень создаём заранее (top-level `mkdir` без recursive требует родителя).
    await mkdir(workspacesRoot, { recursive: true }).catch(() => {});
    const base = slugifyWorkspaceName(name);
    const taken = new Set<string>([
      ...(await collectExistingWorkspaces()),
      ...(await collectExistingRootDirs()),
    ]);

    for (let attempt = 0; attempt < 10_000; attempt++) {
      const candidate = uniqueWorkspaceName(base, [...taken]);
      try {
        await mkdir(resolve(workspacesRoot, candidate), { recursive: false });
        return { ok: true, workspace: candidate };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          // Каталог уже занят — следующий суффикс.
          taken.add(candidate);
          continue;
        }
        return createFailed(err);
      }
    }

    return {
      ok: false,
      status: 422,
      code: 'WORKSPACE_CREATE_FAILED',
      message: 'Не удалось подобрать свободное имя каталога workspace',
    };
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

    // AD-075: managed-провижнинг — нормализация пути и `mkdir -p` вместо проверки 422.
    // Создатель становится владельцем проекта, поэтому RBAC для POST не ограничивает.
    const provisioned = await provisionWorkspace(name, body.workspace);
    if (!provisioned.ok) {
      return c.json({ error: { code: provisioned.code, message: provisioned.message } }, provisioned.status);
    }

    const project = store.create(name, user.id, {
      description: body.description,
      icon: body.icon,
      color: body.color,
      workspace: provisioned.workspace,
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
    if (!canManageProject(c, project, user.id)) {
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
    if (!canManageProject(c, project, user.id)) {
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
    const user = (await kit.getCurrentUser(c))!;

    // D5: горизонтальная авторизация. Проверки до любых мутаций — при отказе
    // проект не меняется вовсе.
    // - смена workspace — только владелец / LEAD / ADMIN (AD-075);
    // - изменение контента (name/description/…/plan) — владелец / EDITOR / LEAD / ADMIN.
    if (body.workspace !== undefined && !canManageProject(c, project, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    if (
      projectContentFields.some((field) => body[field] !== undefined)
      && !canEditProjectContent(c, project, user.id)
    ) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }

    if (body.name !== undefined) project.name = body.name;
    if (body.description !== undefined) project.description = body.description;
    if (body.current_task !== undefined) project.currentTask = body.current_task;
    if (body.invariants !== undefined) project.invariants = body.invariants;
    if (body.icon !== undefined) project.icon = body.icon;
    if (body.color !== undefined) project.color = body.color;
    if (body.workspace !== undefined) {
      if (typeof body.workspace === 'string' && body.workspace.trim()) {
        // AD-075: нормализация пути + `mkdir -p` (абсолютный внутри root → относительный).
        const provisioned = await provisionWorkspace(body.name ?? project.name, body.workspace);
        if (!provisioned.ok) {
          return c.json({ error: { code: provisioned.code, message: provisioned.message } }, provisioned.status);
        }
        project.workspace = provisioned.workspace;
      } else {
        // Явная очистка workspace — без авто-имени.
        project.workspace = undefined;
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

  // DELETE /api/v2/projects/:id — удалить
  app.delete('/:id', kit.requireAuth, async (c) => {
    const project = await store.load(c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: t('errors.notFound.project', undefined, c) } }, 404);
    }
    // D5: удаление — только владелец / LEAD / ADMIN (EDITOR/VIEWER/посторонний → 403).
    const user = (await kit.getCurrentUser(c))!;
    if (!canManageProject(c, project, user.id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
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
