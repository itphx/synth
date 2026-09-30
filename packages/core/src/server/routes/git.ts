import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
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
import { isSshUrl } from '../../git/ssh-env.js';
import { resolveSshEnvById } from '../../engine/tools/git-ssh.js';
import type { SSHKeyStore } from '../../storage/ssh-key-store.js';

/**
 * AD-076 §T3: git-роуты ядра (`/api/v2/git`). Единая реализация для core
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
  sshKeyStore?: SSHKeyStore;
  /** Guard на write-эндпоинты; по умолчанию — `requireAuth`. */
  writeGuard?: Middleware;
  /** Проверка доступа к проекту (managed RBAC); `false` → 403. */
  authorizeProject?: (c: Context, projectId: string) => Promise<boolean>;
}

interface RouteError {
  error: string;
  code: string;
}

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
      error: err.errors.map((e) => e.message).join('; ') || 'Некорректное тело запроса',
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
  const gitService = new GitService(workspacesRoot);
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

  async function ensureAuthorized(c: Context, projectId: string): Promise<void> {
    if (!opts.authorizeProject) return;
    const allowed = await opts.authorizeProject(c, projectId);
    if (!allowed) throw { error: 'Доступ к проекту запрещён', code: 'FORBIDDEN' } satisfies RouteError;
  }

  /** SSH-окружение по `sshKeyId`: без id — пусто; нет ключа — 404; сбой env — 400. */
  async function resolveSshEnv(
    sshKeyId?: string,
  ): Promise<{ env?: Record<string, string>; cleanup?: () => Promise<void> }> {
    const res = await resolveSshEnvById(opts.sshKeyStore, sshKeyId);
    if (res.error === 'sshkey.env_failed') {
      // AD-041: наружу — i18n-ключ, не сырой текст ошибки.
      throw { error: 'sshkey.env_failed', code: 'VALIDATION_ERROR' } satisfies RouteError;
    }
    if (res.error) {
      throw { error: `SSH-ключ ${sshKeyId} не найден`, code: 'sshkey.not_found' } satisfies RouteError;
    }
    return { env: res.env, cleanup: res.cleanup };
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
  app.post('/scan', auth.requireAuth, async (c) => {
    try {
      const body = gitScanBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      const wsPath = await resolveWorkspace(project);
      const repos = await gitService.scanWorkspace(wsPath);
      return c.json({ repos });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // POST /api/v2/git/repos/init
  app.post('/repos/init', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = gitInitBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      await ensureAuthorized(c, body.projectId);
      const wsPath = await resolveWorkspace(project);
      const ssh = await resolveSshEnv(body.sshKeyId);
      try {
        const repo = await gitService.initRepo(
          wsPath,
          body.path,
          body.defaultBranch,
          ssh.env ? { env: ssh.env } : undefined,
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
  app.post('/repos/clone', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = gitCloneBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      await ensureAuthorized(c, body.projectId);
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
          ssh.env ? { env: ssh.env } : undefined,
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
  app.post('/repos/register', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = gitReposRegisterBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      await ensureAuthorized(c, body.projectId);
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
  app.post('/repos/remove', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = gitReposRemoveBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      await ensureAuthorized(c, body.projectId);

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
  app.post('/repos/fetch', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = gitReposFetchBodySchema.parse(await c.req.json());
      const project = await loadProject(body.projectId);
      await ensureAuthorized(c, body.projectId);

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
        await gitService.fetchRepo(wsPath, entry.path, ssh.env ? { env: ssh.env } : undefined);
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
  app.get('/log', auth.requireAuth, async (c) => {
    try {
      const query = gitLogQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        max_count: c.req.query('max_count'),
      });
      const project = await loadProject(query.project_id);
      const wsPath = await resolveWorkspace(project);
      const commits = await gitService.getLog(wsPath, query.repo_path, query.max_count || 30);
      return c.json({ commits });
    } catch (err) {
      const e = toRouteError(err);
      return c.json({ error: e }, codeToStatus(e.code) as 400 | 403 | 404 | 409 | 500);
    }
  });

  // GET /api/v2/git/commit
  app.get('/commit', auth.requireAuth, async (c) => {
    try {
      const query = gitCommitQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        hash: c.req.query('hash'),
      });
      const project = await loadProject(query.project_id);
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
