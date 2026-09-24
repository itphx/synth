import { readdir, access } from 'node:fs/promises';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolContext, Project, GitRepoConfig } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { runGit } from './git.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm } from '../system-messages.js';

interface ProjectContextExtra {
  sessionManager?: SessionManager;
  projectStore?: ProjectStore;
  sessionId?: string;
  /** Корень каталога workspaces для резолва относительного project.workspace (AD-014). */
  workspacesRoot?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__']);

/**
 * Резолвит рабочий каталог проекта: абсолютный workspace возвращается как есть
 * (normalize), относительный — относительно workspacesRoot. Без workspace —
 * fallback на рабочий каталог сессии.
 */
function resolveWorkspaceDir(
  project: Project | undefined,
  workspacesRoot: string | undefined,
  fallback: string,
): string {
  if (project?.workspace) {
    if (isAbsolute(project.workspace)) return normalize(project.workspace);
    if (workspacesRoot) return resolve(workspacesRoot, project.workspace);
    return project.workspace;
  }
  return fallback;
}

/**
 * Резолвит путь git-репозитория проекта: абсолютный — как есть (normalize),
 * относительный — относительно рабочего каталога проекта.
 */
function resolveRepoPath(repoPath: string, projectDir: string): string {
  return isAbsolute(repoPath) ? normalize(repoPath) : resolve(projectDir, repoPath);
}

interface RepoInfo {
  path: string;
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  hasChanges: boolean;
  lastCommit?: string;
}

async function detectRepoInfo(dir: string, signal?: AbortSignal): Promise<RepoInfo | null> {
  let isRepo = false;
  try {
    await access(join(dir, '.git'));
    isRepo = true;
  } catch {
    return null;
  }

  const info: RepoInfo = { path: dir, isRepo, hasChanges: false };

  try {
    const branch = (await runGit(['branch', '--show-current'], dir, signal)).stdout.trim();
    if (branch) info.branch = branch;
  } catch {
    // ветку не определить — пропускаем
  }

  try {
    const remoteUrl = (await runGit(['remote', 'get-url', 'origin'], dir, signal)).stdout.trim();
    if (remoteUrl) info.remoteUrl = remoteUrl;
  } catch {
    // remote не настроен — пропускаем
  }

  try {
    const status = (await runGit(['status', '--porcelain'], dir, signal)).stdout;
    info.hasChanges = status.trim().length > 0;
  } catch {
    // статус не определить — пропускаем
  }

  try {
    const lastCommit = (await runGit(['log', '-1', '--oneline'], dir, signal)).stdout.trim();
    if (lastCommit) info.lastCommit = lastCommit;
  } catch {
    // нет коммитов — пропускаем
  }

  return info;
}

async function findReposInDir(root: string, signal?: AbortSignal): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  const rootRepo = await detectRepoInfo(root, signal);
  if (rootRepo) repos.push(rootRepo);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return repos;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const repo = await detectRepoInfo(join(root, entry.name), signal);
    if (repo) repos.push(repo);
  }

  return repos;
}

async function loadProject(ctx: ToolContext): Promise<Project | undefined> {
  const extra = ctx.extra as ProjectContextExtra | undefined;
  if (!extra?.projectStore) return undefined;

  const sessionId = ctx.sessionId || extra.sessionId;
  if (!sessionId || !extra.sessionManager) return undefined;

  try {
    const session = await extra.sessionManager.getSession(sessionId);
    if (!session?.projectId) return undefined;
    const project = await extra.projectStore.load(session.projectId);
    return project ?? undefined;
  } catch {
    return undefined;
  }
}

/** Строки git-детекта репозитория (без заголовка `- path`). */
function repoDetailLines(repo: RepoInfo): string[] {
  const lines: string[] = [];
  if (repo.branch) lines.push(sm('projectctx.repo_branch', { branch: repo.branch }));
  if (repo.remoteUrl) lines.push(sm('projectctx.repo_remote', { url: repo.remoteUrl }));
  lines.push(sm('projectctx.repo_state', { state: repo.hasChanges ? sm('projectctx.repo_state_dirty') : sm('projectctx.repo_state_clean') }));
  if (repo.lastCommit) lines.push(sm('projectctx.repo_last_commit', { commit: repo.lastCommit }));
  return lines;
}

function formatRepo(repo: RepoInfo, label?: string): string {
  return [`- ${label ?? repo.path}`, ...repoDetailLines(repo)].join('\n');
}

/**
 * AD-076 §T6: строка записи реестра `project.repos` — относительный `path`,
 * абсолютный `destination` и метаданные (`name`/`url`/`type`/`defaultBranch`/
 * `sshKeyId`/`lastFetch`) плюс git-детект (`currentBranch`/`lastCommit`).
 */
function formatRegistryRepo(cfg: GitRepoConfig, destination: string, repo: RepoInfo | null): string {
  const lines: string[] = [`- ${cfg.path}`];
  lines.push(sm('projectctx.repo_destination', { dir: destination }));
  if (cfg.name) lines.push(sm('projectctx.repo_name', { name: cfg.name }));
  if (cfg.url) lines.push(sm('projectctx.repo_url', { url: cfg.url }));
  if (cfg.type) lines.push(sm('projectctx.repo_type', { type: cfg.type }));
  if (cfg.defaultBranch) lines.push(sm('projectctx.repo_default_branch', { branch: cfg.defaultBranch }));
  if (cfg.sshKeyId) lines.push(sm('projectctx.repo_ssh_key', { id: cfg.sshKeyId }));
  if (cfg.lastFetch) lines.push(sm('projectctx.repo_last_fetch', { time: cfg.lastFetch }));
  if (repo) {
    lines.push(...repoDetailLines(repo));
  } else {
    lines.push(sm('projectctx.repo_not_found', { path: destination }));
  }
  return lines.join('\n');
}

export const getProjectInfoTool: ToolDefinition = {
  name: 'get_project_info',
  description:
    'Get information about the current project of the session: name, path, id, and git repository if present.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — не начинаем выполнение (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parts: string[] = [];

    const project = await loadProject(ctx);
    // Каталог жёстко определён проектом (project.workspace); произвольный
    // ввод пути от агента инструмент не принимает (z.object({})).
    const extra = ctx.extra as ProjectContextExtra | undefined;
    const projectDir = resolveWorkspaceDir(project, extra?.workspacesRoot, ctx.workingDir);

    // AD-040: различаем «проекта нет» и «проект указан, но не найден».
    const sessionId = ctx.sessionId || extra?.sessionId;
    let sessionProjectId: string | undefined;
    if (sessionId && extra?.sessionManager) {
      try {
        const session = await extra.sessionManager.getSession(sessionId);
        sessionProjectId = session?.projectId ?? undefined;
      } catch {
        // сессию не определить — пропускаем
      }
    }

    if (project) {
      parts.push(sm('projectctx.info_title', { name: project.name }));
      parts.push(sm('projectctx.info_id', { id: project.id }));
      if (project.workspace) parts.push(sm('projectctx.info_workspace', { dir: projectDir }));
      if (project.description) parts.push(sm('projectctx.info_description', { description: project.description }));
    } else if (sessionProjectId) {
      parts.push(sm('projectctx.not_found', { id: sessionProjectId }));
      parts.push(sm('projectctx.working_dir', { dir: ctx.workingDir }));
    } else {
      parts.push(sm('projectctx.missing'));
      parts.push(sm('projectctx.working_dir', { dir: ctx.workingDir }));
      parts.push(sm('projectctx.no_plan_hint'));
    }

    const repo = await detectRepoInfo(projectDir, ctx.abortSignal);
    if (repo) {
      parts.push('');
      parts.push(sm('projectctx.git_section'));
      parts.push(formatRepo(repo, projectDir));
    }

    return {
      content: parts.join('\n'),
      metadata: {
        workingDir: ctx.workingDir,
        ...(project?.workspace ? { projectWorkspace: projectDir } : {}),
      },
    };
  },
};

export const listReposTool: ToolDefinition = {
  name: 'list_repos',
  description:
    'List git repositories related to the project. If the project has configured repos — lists them, '
    + 'otherwise scans the working directory for git repositories.',
  parameters: z.object({}),
  capabilities: [ToolCapability.RUNTIME],
  async execute(_args, ctx) {
    // «Стоп» пришёл до запуска — не начинаем выполнение (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parts: string[] = [];

    const project = await loadProject(ctx);
    // Каталог жёстко определён проектом (project.workspace); произвольный
    // ввод пути от агента инструмент не принимает (z.object({})).
    const extra = ctx.extra as ProjectContextExtra | undefined;
    const projectDir = resolveWorkspaceDir(project, extra?.workspacesRoot, ctx.workingDir);

    if (project?.repos && project.repos.length > 0) {
      parts.push(sm('projectctx.repos_title', { name: project.name }));
      for (const repoCfg of project.repos) {
        // Относительные пути репозиториев резолвим относительно рабочего
        // каталога проекта: `destination` — абсолютный путь внутри workspace,
        // git-детект ищет в правильном месте (AD-076).
        const destination = resolveRepoPath(repoCfg.path, projectDir);
        const repo = await detectRepoInfo(destination, ctx.abortSignal);
        parts.push(formatRegistryRepo(repoCfg, destination, repo));
      }
    } else {
      const repos = await findReposInDir(projectDir, ctx.abortSignal);
      if (repos.length === 0) {
        return {
          content: sm('projectctx.repos_none', { dir: projectDir }),
          metadata: {
            workingDir: ctx.workingDir,
            ...(project?.workspace ? { projectWorkspace: projectDir } : {}),
            count: 0,
          },
        };
      }
      parts.push(sm('projectctx.repos_found', { dir: projectDir }));
      for (const repo of repos) {
        parts.push(formatRepo(repo, repo.path));
      }
    }

    const count = parts.filter((line) => line.startsWith('- ')).length;
    return {
      content: parts.join('\n'),
      metadata: {
        workingDir: ctx.workingDir,
        ...(project?.workspace ? { projectWorkspace: projectDir } : {}),
        count,
      },
    };
  },
};
