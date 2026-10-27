import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { ZodError } from 'zod';
import type { GitRepoConfig, Project } from '@itphx/synth-shared';
import {
  nowISO,
  normalizeGitRepoConfig,
  gitScanBodySchema,
  gitInitBodySchema,
  gitCloneBodySchema,
  gitReposRegisterBodySchema,
  gitReposRemoveBodySchema,
  gitReposFetchBodySchema,
  gitLogQuerySchema,
  gitCommitQuerySchema,
} from '@itphx/synth-shared';
import { GitService, deriveRepoName, resolveRepoPath } from '../../git/git-service.js';
import type { ExecutionPort, ExecSecret } from '../../execution/ports/index.js';
import { isSshUrl } from '../../git/ssh-env.js';
import { resolveSshEnvById } from '../../engine/tools/git-ssh.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';

/**
 * ADR-076 §T3: git-роуты ядра (`/api/v2/git`). Единая реализация для core
 * (standalone) и backend (managed, T4 — через `writeGuard`/`authorizeProject`).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный контракт auth-фабрики (структурно совместим с core/backend AuthKit). */
export interface GitRoutesAuth {
  requireAuth: Middleware;
}

/** Структурный контракт хранилища проектов (совместим с core/backend ProjectStore). */
export interface GitProjectStore {
  load(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
}

export interface GitRoutesOptions {
  /** Хранилище SSH-ключей; без него `sshKeyId` → 404. */
  sshKeyStore?: SSHKeyRepository;
  /** Guard на write-эндпоинты; по умолчанию — `requireAuth`. */
  writeGuard?: Middleware;
  /**
   * Проверка доступа к проекту для WRITE-эндпоинтов (managed RBAC);
   * `false` → 403. Не задана — проверки нет (standalone: один пользователь).
   */
  authorizeProject?: (c: Context, projectId: string) => Promise<boolean>;
  /**
   * Проверка доступа к проекту для READ-эндпоинтов (`scan`/`log`/`commit`);
   * `false` → 403. Управ — owner/участник проекта/`LEAD`/`ADMIN`
   * (ADR-089, `canReadProject`).
   *
   * Не задана — берётся `authorizeProject` (строже: чтение требует прав на
   * изменение контента). Не заданы оба — проверки нет (standalone: один
   * пользователь инстанса, доступ к проекту не разграничивается).
   */
  authorizeRead?: (c: Context, projectId: string) => Promise<boolean>;
  /**
   * ADR-077: порт исполнения git-команд. В remote-режиме те же команды уходят
   * исполнителю (control plane без toolchain'а). Не задан — inline.
   */
  execution?: ExecutionPort;
}

interface RouteError {
  error: string;
  code: string;
}

/**
 * Ключ контекста Hono: id проекта, РАЗРЕШЁННЫЙ граничным guard'ом.
 *
 * Единственный источник id проекта для обработчиков (ADR-089, инвариант 16):
 * guard резолвит id ОДИН раз и кладёт его в контекст; обработчик берёт id
 * ТОЛЬКО отсюда. Если бы обработчик читал id из тела сам, guard и обработчик
 * могли бы разрешить РАЗНЫЕ проекты — доступ проверен по одному, а действие
 * выполнено по другому (IDOR).
 */
export const GIT_PROJECT_ID_CONTEXT_KEY = 'gitProjectId';

/** Вход upsert записи реестра (merge с существующей по `id`/`path`). */
interface RegisterInput {
  id?: string;
  path: string;
  name?: string;
  url?: string;
  type?: 'https' | 'ssh';
  defaultBranch?: string;
  sshKeyId?: string;
  lastFetch?: string;
}

function codeToStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
    case 'WORKSPACE_NOT_FOUND':
    case 'sshkey.not_found':
      return 404;
    case 'FORBIDDEN':
    case 'PATH_TRAVERSAL':
      return 403;
    case 'git.repo_path_invalid':
    case 'git.ssh_key_required':
    case 'WORKSPACE_NOT_SET':
    case 'NOT_A_DIRECTORY':
    case 'VALIDATION_ERROR':
      return 400;
    case 'git.repo_exists':
      return 409;
    default:
      return 500;
  }
}

function toRouteError(err: unknown): RouteError {
  if (err instanceof ZodError) {
    return {
      error: err.issues.map((e) => e.message).join('; ') || 'Некорректное тело запроса',
      code: 'VALIDATION_ERROR',
    };
  }
  const e = err as Partial<RouteError> | undefined;
  if (e && typeof e.code === 'string') {
    // Traversal пути репозитория — единый ответ `git.repo_path_invalid` (400).
    if (e.code === 'PATH_TRAVERSAL') {
      return { error: e.error ?? 'Недопустимый путь репозитория', code: 'git.repo_path_invalid' };
    }
    return { error: e.error ?? e.code, code: e.code };
  }
  return { error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' };
}

/** Legacy `repos` (`string[]` / `{ path }`) → `GitRepoConfig[]`. */
function normalizeRepos(project: Project): GitRepoConfig[] {
  const out: GitRepoConfig[] = [];
  for (const raw of project.repos ?? []) {
    const normalized = normalizeGitRepoConfig(raw);
    if (normalized) out.push(normalized);
  }
  return out;
}

function deriveType(url?: string): 'https' | 'ssh' | undefined {
  if (!url) return undefined;
  return isSshUrl(url) ? 'ssh' : 'https';
}

export function createGitRoutes(
  auth: GitRoutesAuth,
  projectStore: GitProjectStore,
  workspacesRoot: string,
  opts: GitRoutesOptions = {},
): Hono {
  const app = new Hono();
  const gitService = new GitService(workspacesRoot, { execution: opts.execution });
  // `auth.requireAuth` уже навешан на write-эндпоинты выше, поэтому дефолтный
  // writeGuard — no-op (в backend передаётся requireAdmin/RBAC).
  const writeGuard: Middleware = opts.writeGuard ?? (async (_c, next) => { await next(); });

  async function loadProject(id: string): Promise<Project> {
    const project = await projectStore.load(id);
    if (!project) throw { error: 'Проект не найден', code: 'NOT_FOUND' } satisfies RouteError;
    return project;
  }

  async function resolveWorkspace(project: Project): Promise<string> {
    if (!project.workspace) {
      throw { error: 'Workspace не задан для проекта', code: 'WORKSPACE_NOT_SET' } satisfies RouteError;
    }
    const wsAbs = isAbsolute(project.workspace)
      ? resolve(project.workspace)
      : resolve(workspacesRoot, project.workspace);

    if (!isAbsolute(project.workspace)) {
      const rel = relative(resolve(workspacesRoot), wsAbs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw { error: 'Workspace проекта выходит за пределы разрешённого корня', code: 'PATH_TRAVERSAL' } satisfies RouteError;
      }
    }

    const s = await stat(wsAbs).catch(() => null);
    if (!s || !s.isDirectory()) {
      throw { error: `Workspace не найден: ${wsAbs}`, code: 'WORKSPACE_NOT_FOUND' } satisfies RouteError;
    }
    return wsAbs;
  }

  /**
   * id проекта запроса — ЕДИНЫЙ резолвер (query `project_id` либо тело
   * `projectId`).
   *
   * Расхождение (в query один id, в теле — другой) НЕ разрешается в пользу
   * тела: запрос неоднозначен → `ambiguous` (fail-closed, 403): ни один проект
   * не авторизуется и ни один не затрагивается.
   */
  async function resolveProjectId(c: Context): Promise<{ id?: string; ambiguous: boolean }> {
    const fromQuery = c.req.query('project_id');
    let fromBody: string | undefined;
    try {
      const body = (await c.req.json()) as { projectId?: unknown } | null;
      const id = body?.projectId;
      fromBody = typeof id === 'string' && id.length > 0 ? id : undefined;
    } catch {
      fromBody = undefined;
    }
    if (fromQuery && fromBody && fromQuery !== fromBody) return { ambiguous: true, id: undefined };
    return { id: fromQuery ?? fromBody, ambiguous: false };
  }

  /**
   * id проекта, РАЗРЕШЁННЫЙ guard'ом (из контекста) — единственный источник
   * для обработчика. Guard не разрешил id → обработчик обязан отказать
   * (fail-closed), а не взять id из тела: иначе guard и обработчик разошлись
   * бы по проекту (IDOR).
   */
  function authorizedProjectId(c: Context): string {
    const id = c.get(GIT_PROJECT_ID_CONTEXT_KEY as never) as string | undefined;
    if (!id) {
      throw { error: 'Не указан проект', code: 'VALIDATION_ERROR' } satisfies RouteError;
    }
    return id;
  }

  /** Единый ответ об отказе в доступе к проекту (формат git-роутов). */
  function forbidden(c: Context): Response {
    return c.json(
      { error: { error: 'Доступ к проекту запрещён', code: 'FORBIDDEN' } satisfies RouteError },
      403,
    );
  }

  /**
   * ГРАНИЧНАЯ проверка доступа к проекту (ADR-089, инвариант 16): выполняется
   * ДО обработчика, правило — в одной точке (внутри обработчиков проверок нет).
   *
   * `read` — эндпоинты чтения git-данных (`scan`/`log`/`commit`): право чтения
   * проекта. `write` — эндпоинты изменения реестра/репозиториев: право на
   * изменение контента проекта. Отказ — 403 `FORBIDDEN` (fail-closed).
   *
   * Разрешённый id кладётся в контекст (`GIT_PROJECT_ID_CONTEXT_KEY`) —
   * обработчик работает только с ним (см. `authorizedProjectId`).
   */
  const projectGuard = (kind: 'read' | 'write'): MiddlewareHandler => async (c, next) => {
    const { id, ambiguous } = await resolveProjectId(c);
    if (ambiguous) {
      // Два разных id проекта в одном запросе — неоднозначный запрос: не
      // авторизуем ни один проект (fail-closed).
      return forbidden(c);
    }
    if (!id) {
      // id не извлёкся — проверять нечего; обработчик обязан отказать сам
      // (400/404), взять id из тела он больше не может.
      return next();
    }
    c.set(GIT_PROJECT_ID_CONTEXT_KEY as never, id as never);
    const authorize = kind === 'read'
      ? (opts.authorizeRead ?? opts.authorizeProject)
      : opts.authorizeProject;
    if (!authorize) return next();
    const allowed = await authorize(c, id).catch(() => false);
    if (!allowed) return forbidden(c);
    return next();
  };

  /**
   * SSH-доступ по `sshKeyId`: без id — пусто; нет ключа — 404.
   *
   * Возвращается **секрет вызова** (`ExecSecret`, ADR-077 протокол 4), а не
   * готовый `GIT_SSH_COMMAND`: материал готовит точка исполнения (в
   * remote-режиме — исполнитель; путь control plane в его контейнере не
   * существует).
   */
  async function resolveSshEnv(
    sshKeyId?: string,
  ): Promise<{ secrets?: ExecSecret[]; cleanup?: () => Promise<void> }> {
    const res = await resolveSshEnvById(opts.sshKeyStore, sshKeyId);
    if (res.error === 'sshkey.env_failed') {
      // ADR-041: наружу — i18n-ключ, не сырой текст ошибки.
      throw { error: 'sshkey.env_failed', code: 'VALIDATION_ERROR' } satisfies RouteError;
    }
    if (res.error) {
      throw { error: `SSH-ключ ${sshKeyId} не найден`, code: 'sshkey.not_found' } satisfies RouteError;
    }
    return { secrets: res.secrets, cleanup: res.cleanup };
  }

  /** Upsert записи реестра (по `id` либо `path`), сохранение проекта. */
  async function registerRepo(project: Project, input: RegisterInput): Promise<GitRepoConfig> {
    const repos = normalizeRepos(project);
    const byId = input.id ? repos.findIndex((r) => r.id === input.id) : -1;
    const existing = byId >= 0 ? repos[byId] : repos.find((r) => r.path === input.path);

    const entry: GitRepoConfig = {
      id: existing?.id ?? input.id ?? randomUUID(),
      path: input.path,
      name: input.name ?? existing?.name,
      url: input.url ?? existing?.url,
      type: input.type ?? existing?.type,
      defaultBranch: input.defaultBranch ?? existing?.defaultBranch,
      sshKeyId: input.sshKeyId ?? existing?.sshKeyId,
      lastFetch: input.lastFetch ?? existing?.lastFetch,
    };

    const next = existing
      ? repos.map((r) => (r === existing ? entry : r))
      : [...repos, entry];
    await projectStore.save({ ...project, repos: next, updatedAt: nowISO() });
    return entry;
  }

  function findRepo(repos: GitRepoConfig[], id?: string, path?: string): GitRepoConfig | undefined {
    if (id) return repos.find((r) => r.id === id);
    return repos.find((r) => r.path === path);
  }

  async function pathHasEntries(dir: string): Promise<boolean> {
    try {
      const entries = await readdir(dir);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  // POST /api/v2/git/scan
  app.post('/scan', auth.requireAuth, projectGuard('read'), async (c) => {
    try {
      gitScanBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);
      const repos = await gitService.scanWorkspace(wsPath);
      return c.json({ repos });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/init
  app.post('/repos/init', auth.requireAuth, writeGuard, projectGuard('write'), async (c) => {
    try {
      const body = gitInitBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);
      const ssh = await resolveSshEnv(body.sshKeyId);
      try {
        const repo = await gitService.initRepo(
          wsPath,
          body.path,
          body.defaultBranch,
          ssh.secrets ? { secrets: ssh.secrets } : undefined,
        );
        await registerRepo(project, {
          path: body.path,
          name: body.name,
          defaultBranch: body.defaultBranch,
          sshKeyId: body.sshKeyId,
        });
        return c.json(repo, 201);
      } finally {
        await ssh.cleanup?.();
      }
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/clone
  app.post('/repos/clone', auth.requireAuth, writeGuard, projectGuard('write'), async (c) => {
    try {
      const body = gitCloneBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);

      const relPath = body.path || deriveRepoName(body.url);
      if (isSshUrl(body.url) && !body.sshKeyId) {
        throw { error: `Для репозитория «${relPath}» требуется SSH-ключ`, code: 'git.ssh_key_required' } satisfies RouteError;
      }
      if (await pathHasEntries(resolveRepoPath(wsPath, relPath))) {
        throw { error: `Репозиторий уже существует по пути «${relPath}»`, code: 'git.repo_exists' } satisfies RouteError;
      }

      const ssh = await resolveSshEnv(body.sshKeyId);
      try {
        const repo = await gitService.cloneRepo(
          wsPath,
          body.path || '',
          body.url,
          body.branch,
          ssh.secrets ? { secrets: ssh.secrets } : undefined,
        );
        await registerRepo(project, {
          path: repo.path,
          name: body.name,
          url: body.url,
          type: deriveType(body.url),
          defaultBranch: body.branch,
          sshKeyId: body.sshKeyId,
          lastFetch: nowISO(),
        });
        return c.json(repo, 201);
      } finally {
        await ssh.cleanup?.();
      }
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/register
  app.post('/repos/register', auth.requireAuth, writeGuard, projectGuard('write'), async (c) => {
    try {
      const body = gitReposRegisterBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);
      // Валидация containment: абсолютный/выходящий путь → 400 git.repo_path_invalid.
      resolveRepoPath(wsPath, body.path);

      const entry = await registerRepo(project, {
        path: body.path,
        name: body.name,
        url: body.url,
        type: body.type ?? deriveType(body.url),
        defaultBranch: body.defaultBranch,
        sshKeyId: body.sshKeyId,
        lastFetch: nowISO(),
      });
      return c.json(entry);
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/remove
  app.post('/repos/remove', auth.requireAuth, writeGuard, projectGuard('write'), async (c) => {
    try {
      const body = gitReposRemoveBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));

      const repos = normalizeRepos(project);
      const removed = findRepo(repos, body.id, body.path);
      if (!removed) {
        throw { error: 'Репозиторий не найден в реестре', code: 'NOT_FOUND' } satisfies RouteError;
      }

      let deletedLocal = false;
      if (body.deleteLocal) {
        const wsPath = await resolveWorkspace(project);
        await gitService.removeLocal(wsPath, removed.path);
        deletedLocal = true;
      }

      await projectStore.save({
        ...project,
        repos: repos.filter((r) => r !== removed),
        updatedAt: nowISO(),
      });
      return c.json({ removed, deletedLocal });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/fetch
  app.post('/repos/fetch', auth.requireAuth, writeGuard, projectGuard('write'), async (c) => {
    try {
      const body = gitReposFetchBodySchema.parse(await c.req.json());
      const project = await loadProject(authorizedProjectId(c));

      const repos = normalizeRepos(project);
      const entry = findRepo(repos, body.id, body.path);
      if (!entry) {
        throw { error: 'Репозиторий не найден в реестре', code: 'NOT_FOUND' } satisfies RouteError;
      }
      if (entry.url && isSshUrl(entry.url) && !entry.sshKeyId) {
        throw { error: `Для репозитория «${entry.path}» требуется SSH-ключ`, code: 'git.ssh_key_required' } satisfies RouteError;
      }

      const wsPath = await resolveWorkspace(project);
      const ssh = await resolveSshEnv(entry.sshKeyId);
      const lastFetch = nowISO();
      try {
        await gitService.fetchRepo(wsPath, entry.path, ssh.secrets ? { secrets: ssh.secrets } : undefined);
      } finally {
        await ssh.cleanup?.();
      }

      const updated: GitRepoConfig = { ...entry, lastFetch };
      await projectStore.save({
        ...project,
        repos: repos.map((r) => (r === entry ? updated : r)),
        updatedAt: nowISO(),
      });
      return c.json({ path: entry.path, lastFetch });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // GET /api/v2/git/log
  app.get('/log', auth.requireAuth, projectGuard('read'), async (c) => {
    try {
      const query = gitLogQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        max_count: c.req.query('max_count'),
      });
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);
      const commits = await gitService.getLog(wsPath, query.repo_path, query.max_count || 30);
      return c.json({ commits });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // GET /api/v2/git/commit
  app.get('/commit', auth.requireAuth, projectGuard('read'), async (c) => {
    try {
      const query = gitCommitQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        hash: c.req.query('hash'),
      });
      const project = await loadProject(authorizedProjectId(c));
      const wsPath = await resolveWorkspace(project);
      const commit = await gitService.getCommitDetail(wsPath, query.repo_path, query.hash);
      return c.json({ commit });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  return app;
}
