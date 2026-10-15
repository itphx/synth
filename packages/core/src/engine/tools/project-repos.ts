import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { nowISO, ToolCapability, normalizeGitRepoConfig } from '@itphx/synth-shared';
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  Project,
  Session,
  GitRepoConfig,
  RepoStatus,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { EventBus } from '../../events/bus.js';
import type { SSHKeyStore } from '../../storage/ssh-key-store.js';
import { GitService, deriveRepoName } from '../../git/git-service.js';
import { isSshUrl } from '../../git/ssh-env.js';
import { isAborted, abortedResult } from './abort.js';
import { loadSessionProject } from './project-manage.js';
import { canEditProject } from './project-access.js';
import { resolveSshEnvById } from './git-ssh.js';
import { t as sm, i18n as i18nMeta, type SystemMessageKey } from '../system-messages.js';

/**
 * ADR-076: тулы управления git-репозиториями проекта (clone/init/add/fetch/remove).
 * Проект и его workspace берутся из сессии — path-параметры проекта от агента не
 * принимаются; регистрация записи идёт в `project.repos` (ProjectStore.save).
 */

interface ProjectReposExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreContract;
  sessionId?: string;
  eventBus?: EventBus;
  /** ADR-075: корень managed-workspace для резолва относительного `workspace`. */
  workspacesRoot?: string;
  /** ADR-076: git-сервис (containment + операции). */
  gitService?: GitService;
  /** ADR-076: хранилище SSH-ключей для сетевых операций. */
  sshKeyStore?: SSHKeyStore;
}

function getExtra(ctx: ToolContext): ProjectReposExtra {
  return (ctx.extra ?? {}) as ProjectReposExtra;
}

function argError(toolName: string, issues: z.ZodIssue[]): string {
  return sm('tool.args_error', { tool: toolName, issues: issues
    .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    .join('; ') });
}

function missingDepsError(toolName: string): ToolResult {
  return { content: sm('project.deps_unavailable', { tool: toolName }), isError: true };
}

function i18nError(key: SystemMessageKey, params?: Record<string, string>): ToolResult {
  return { content: sm(key, params), isError: true, metadata: { i18n: i18nMeta(key, params) } };
}

function toolExecError(tool: string, err: unknown): ToolResult {
  return {
    content: sm('tool.exec_error', { tool, error: err instanceof Error ? err.message : String(err) }),
    isError: true,
  };
}

type LoadedContext =
  | { ok: false; error: ToolResult }
  | { ok: true; extra: ProjectReposExtra; store: ProjectStoreContract; session: Session | null; project: Project; wsAbs: string; git: GitService };

/**
 * Общий преамбул: зависимости, проект сессии, права и абсолютный workspace.
 * `gitService`/`projectStore` обязательны — без них тул недоступен.
 */
async function loadProjectContext(ctx: ToolContext, toolName: string): Promise<LoadedContext> {
  const extra = getExtra(ctx);
  if (!extra.sessionManager || !extra.projectStore || !extra.sessionId || !extra.gitService) {
    return { ok: false, error: missingDepsError(toolName) };
  }

  const { session, project } = await loadSessionProject(ctx);
  if (!project) return { ok: false, error: i18nError('project.no_project') };
  if (!canEditProject(session, project)) return { ok: false, error: i18nError('project.write_forbidden') };
  if (!project.workspace) return { ok: false, error: i18nError('project.workspace_missing') };

  const wsAbs = isAbsolute(project.workspace)
    ? normalize(project.workspace)
    : resolve(extra.workspacesRoot ?? process.cwd(), project.workspace);
  return { ok: true, extra, store: extra.projectStore, session, project, wsAbs, git: extra.gitService };
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

/** Upsert записи реестра (по `id` либо `path`), сохранение проекта (как HTTP-роут). */
async function registerRepo(
  store: ProjectStoreContract,
  project: Project,
  input: {
    id?: string;
    path: string;
    name?: string;
    url?: string;
    type?: 'https' | 'ssh';
    defaultBranch?: string;
    sshKeyId?: string;
    lastFetch?: string;
  },
): Promise<GitRepoConfig> {
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
  await store.save({ ...project, repos: next, updatedAt: nowISO() });
  return entry;
}

function findRepo(repos: GitRepoConfig[], id?: string, path?: string): GitRepoConfig | undefined {
  if (id) return repos.find((r) => r.id === id);
  return repos.find((r) => r.path === path);
}

function deriveType(url?: string): 'https' | 'ssh' | undefined {
  if (!url) return undefined;
  return isSshUrl(url) ? 'ssh' : 'https';
}

/** Каталог существует и непустой (отсутствие каталога = пусто). */
async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Публикует `project.updated` — UI обновляет список проектов/Git-вкладку. */
function publishUpdated(extra: ProjectReposExtra, ctx: ToolContext, projectId: string): void {
  const sessionId = ctx.sessionId || extra.sessionId;
  if (sessionId) extra.eventBus?.publish(sessionId, 'project.updated', { project_id: projectId });
}

/** Containment-резолв пути репозитория; traversal → i18n-ошибка. */
function safeRelPath(
  git: GitService,
  wsAbs: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; error: ToolResult } {
  try {
    return { ok: true, abs: git.resolveRepoPath(wsAbs, relPath) };
  } catch {
    return { ok: false, error: i18nError('git.repo_path_invalid', { path: relPath }) };
  }
}

const repoCloneSchema = z.object({
  url: z.string().min(1).describe('Repository URL'),
  path: z.string().optional().describe('Relative path inside the project workspace'),
  name: z.string().optional().describe('Display name of the repository'),
  branch: z.string().optional().describe('Branch to clone'),
  sshKeyId: z.string().optional().describe('SSH key id (required for SSH URLs)'),
});

export const projectRepoCloneTool: ToolDefinition = {
  name: 'project_repo_clone',
  description:
    'Clone a git repository into the current project workspace and register it in the project. '
    + 'Requires write access to the project. SSH URLs need an sshKeyId.',
  parameters: repoCloneSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { url: string; path?: string; name?: string; branch?: string; sshKeyId?: string };

    const loaded = await loadProjectContext(ctx, this.name);
    if (!loaded.ok) return loaded.error;
    const { extra, store, project, wsAbs, git } = loaded;

    const relPath = params.path || deriveRepoName(params.url);
    if (isSshUrl(params.url) && !params.sshKeyId) {
      return i18nError('git.ssh_key_required', { path: relPath });
    }

    const containment = safeRelPath(git, wsAbs, relPath);
    if (!containment.ok) return containment.error;
    if (await dirHasEntries(containment.abs)) {
      return i18nError('git.repo_exists', { path: relPath });
    }

    const ssh = await resolveSshEnvById(extra.sshKeyStore, params.sshKeyId);
    if (ssh.error) return i18nError(ssh.error as SystemMessageKey, ssh.errorParams);

    let repo: RepoStatus;
    try {
      repo = await git.cloneRepo(wsAbs, params.path ?? '', params.url, params.branch, ssh.env ? { env: ssh.env } : undefined);
    } catch (err) {
      return toolExecError(this.name, err);
    } finally {
      await ssh.cleanup();
    }

    const entry = await registerRepo(store, project, {
      path: repo.path,
      name: params.name,
      url: params.url,
      type: deriveType(params.url),
      defaultBranch: params.branch,
      sshKeyId: params.sshKeyId,
      lastFetch: nowISO(),
    });
    publishUpdated(extra, ctx, project.id);

    return {
      content: sm('project.repo_cloned', { path: repo.path }),
      metadata: { path: repo.path, id: entry.id, i18n: i18nMeta('project.repo_cloned', { path: repo.path }) },
    };
  },
};

const repoInitSchema = z.object({
  path: z.string().min(1).describe('Relative path inside the project workspace'),
  defaultBranch: z.string().optional().describe('Initial branch name'),
  name: z.string().optional().describe('Display name of the repository'),
});

export const projectRepoInitTool: ToolDefinition = {
  name: 'project_repo_init',
  description:
    'Initialize a new git repository inside the current project workspace and register it. '
    + 'Requires write access to the project.',
  parameters: repoInitSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { path: string; defaultBranch?: string; name?: string };

    const loaded = await loadProjectContext(ctx, this.name);
    if (!loaded.ok) return loaded.error;
    const { extra, store, project, wsAbs, git } = loaded;

    const containment = safeRelPath(git, wsAbs, params.path);
    if (!containment.ok) return containment.error;

    let repo: RepoStatus;
    try {
      repo = await git.initRepo(wsAbs, params.path, params.defaultBranch);
    } catch (err) {
      return toolExecError(this.name, err);
    }

    await registerRepo(store, project, {
      path: repo.path,
      name: params.name,
      defaultBranch: params.defaultBranch,
    });
    publishUpdated(extra, ctx, project.id);

    return {
      content: sm('project.repo_initialized', { path: repo.path }),
      metadata: { path: repo.path, i18n: i18nMeta('project.repo_initialized', { path: repo.path }) },
    };
  },
};

const repoAddSchema = z.object({
  path: z.string().min(1).describe('Relative path inside the project workspace'),
  name: z.string().optional().describe('Display name of the repository'),
  url: z.string().optional().describe('Repository URL'),
  type: z.enum(['https', 'ssh']).optional().describe('Repository transport type'),
  defaultBranch: z.string().optional().describe('Default branch name'),
  sshKeyId: z.string().optional().describe('SSH key id'),
});

export const projectRepoAddTool: ToolDefinition = {
  name: 'project_repo_add',
  description:
    'Register an existing repository (already present in the project workspace) in the project registry. '
    + 'Does not perform network operations. Requires write access to the project.',
  parameters: repoAddSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as {
      path: string; name?: string; url?: string; type?: 'https' | 'ssh'; defaultBranch?: string; sshKeyId?: string;
    };

    const loaded = await loadProjectContext(ctx, this.name);
    if (!loaded.ok) return loaded.error;
    const { extra, store, project, wsAbs, git } = loaded;

    // Containment: абсолютный/выходящий путь → i18n-ошибка.
    const containment = safeRelPath(git, wsAbs, params.path);
    if (!containment.ok) return containment.error;

    const entry = await registerRepo(store, project, {
      path: params.path,
      name: params.name,
      url: params.url,
      type: params.type ?? deriveType(params.url),
      defaultBranch: params.defaultBranch,
      sshKeyId: params.sshKeyId,
    });
    publishUpdated(extra, ctx, project.id);

    return {
      content: sm('project.repo_registered', { path: entry.path }),
      metadata: { path: entry.path, id: entry.id, i18n: i18nMeta('project.repo_registered', { path: entry.path }) },
    };
  },
};

const repoFetchSchema = z.object({
  id: z.string().optional().describe('Repository registry id'),
  path: z.string().optional().describe('Relative repository path inside the workspace'),
}).refine((v) => Boolean(v.id || v.path), { message: 'id or path is required' });

export const projectRepoFetchTool: ToolDefinition = {
  name: 'project_repo_fetch',
  description:
    'Fetch a registered project repository (network operation). '
    + 'Requires write access to the project.',
  parameters: repoFetchSchema,
  capabilities: [ToolCapability.GIT_WRITE],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { id?: string; path?: string };

    const loaded = await loadProjectContext(ctx, this.name);
    if (!loaded.ok) return loaded.error;
    const { extra, store, project, wsAbs, git } = loaded;

    const repos = normalizeRepos(project);
    const entry = findRepo(repos, params.id, params.path);
    if (!entry) {
      return i18nError('project.repo_not_found', { path: params.path ?? params.id ?? '' });
    }
    if (entry.url && isSshUrl(entry.url) && !entry.sshKeyId) {
      return i18nError('git.ssh_key_required', { path: entry.path });
    }

    const containment = safeRelPath(git, wsAbs, entry.path);
    if (!containment.ok) return containment.error;

    const ssh = await resolveSshEnvById(extra.sshKeyStore, entry.sshKeyId);
    if (ssh.error) return i18nError(ssh.error as SystemMessageKey, ssh.errorParams);

    try {
      await git.fetchRepo(wsAbs, entry.path, ssh.env ? { env: ssh.env } : undefined);
    } catch (err) {
      return toolExecError(this.name, err);
    } finally {
      await ssh.cleanup();
    }

    const updated: GitRepoConfig = { ...entry, lastFetch: nowISO() };
    await store.save({
      ...project,
      repos: repos.map((r) => (r === entry ? updated : r)),
      updatedAt: nowISO(),
    });
    publishUpdated(extra, ctx, project.id);

    return {
      content: sm('project.repo_fetched', { path: entry.path }),
      metadata: { path: entry.path, lastFetch: updated.lastFetch, i18n: i18nMeta('project.repo_fetched', { path: entry.path }) },
    };
  },
};

const repoRemoveSchema = z.object({
  id: z.string().optional().describe('Repository registry id'),
  path: z.string().optional().describe('Relative repository path inside the workspace'),
}).refine((v) => Boolean(v.id || v.path), { message: 'id or path is required' });

export const projectRepoRemoveTool: ToolDefinition = {
  name: 'project_repo_remove',
  description:
    'Remove a repository from the project registry (the local directory is NOT deleted). '
    + 'Requires write access to the project.',
  parameters: repoRemoveSchema,
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: argError(this.name, parsed.error.issues), isError: true };
    }
    const params = parsed.data as { id?: string; path?: string };

    const loaded = await loadProjectContext(ctx, this.name);
    if (!loaded.ok) return loaded.error;
    const { extra, store, project } = loaded;

    const repos = normalizeRepos(project);
    const entry = findRepo(repos, params.id, params.path);
    if (!entry) {
      return i18nError('project.repo_not_found', { path: params.path ?? params.id ?? '' });
    }

    // deleteLocal не поддерживаем — локальный каталог не удаляем.
    await store.save({
      ...project,
      repos: repos.filter((r) => r !== entry),
      updatedAt: nowISO(),
    });
    publishUpdated(extra, ctx, project.id);

    return {
      content: sm('project.repo_removed', { path: entry.path }),
      metadata: { path: entry.path, i18n: i18nMeta('project.repo_removed', { path: entry.path }) },
    };
  },
};
