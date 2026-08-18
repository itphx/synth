import { readdir, access } from 'node:fs/promises';
import { basename, join, isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { ToolCapability } from '@itphx/shared';
import type { ToolDefinition, ToolContext, Project } from '@itphx/shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStore } from '../../storage/project-store.js';
import { runGit } from './git.js';

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

async function detectRepoInfo(dir: string): Promise<RepoInfo | null> {
  let isRepo = false;
  try {
    await access(join(dir, '.git'));
    isRepo = true;
  } catch {
    return null;
  }

  const info: RepoInfo = { path: dir, isRepo, hasChanges: false };

  try {
    const branch = (await runGit(['branch', '--show-current'], dir)).stdout.trim();
    if (branch) info.branch = branch;
  } catch {
    // ветку не определить — пропускаем
  }

  try {
    const remoteUrl = (await runGit(['remote', 'get-url', 'origin'], dir)).stdout.trim();
    if (remoteUrl) info.remoteUrl = remoteUrl;
  } catch {
    // remote не настроен — пропускаем
  }

  try {
    const status = (await runGit(['status', '--porcelain'], dir)).stdout;
    info.hasChanges = status.trim().length > 0;
  } catch {
    // статус не определить — пропускаем
  }

  try {
    const lastCommit = (await runGit(['log', '-1', '--oneline'], dir)).stdout.trim();
    if (lastCommit) info.lastCommit = lastCommit;
  } catch {
    // нет коммитов — пропускаем
  }

  return info;
}

async function findReposInDir(root: string): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  const rootRepo = await detectRepoInfo(root);
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
    const repo = await detectRepoInfo(join(root, entry.name));
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

function formatRepo(repo: RepoInfo, label?: string): string {
  const lines = [`- ${label ?? repo.path}`];
  if (repo.branch) lines.push(`  - Ветка: ${repo.branch}`);
  if (repo.remoteUrl) lines.push(`  - Remote: ${repo.remoteUrl}`);
  lines.push(`  - Состояние: ${repo.hasChanges ? 'есть изменения' : 'чисто'}`);
  if (repo.lastCommit) lines.push(`  - Последний коммит: ${repo.lastCommit}`);
  return lines.join('\n');
}

export const getProjectInfoTool: ToolDefinition = {
  name: 'get_project_info',
  description:
    'Get information about the current project of the session: name, path, id, and git repository if present.',
  parameters: z.object({}),
  capabilities: [ToolCapability.FILE_READ],
  async execute(_args, ctx) {
    const parts: string[] = [];

    const project = await loadProject(ctx);
    // Каталог жёстко определён проектом (project.workspace); произвольный
    // ввод пути от агента инструмент не принимает (z.object({})).
    const extra = ctx.extra as ProjectContextExtra | undefined;
    const projectDir = resolveWorkspaceDir(project, extra?.workspacesRoot, ctx.workingDir);

    if (project) {
      parts.push(`# Проект: ${project.name}`);
      parts.push(`- ID: ${project.id}`);
      if (project.workspace) parts.push(`- Рабочий каталог проекта: ${projectDir}`);
      if (project.description) parts.push(`- Описание: ${project.description}`);
    } else {
      const name = basename(ctx.workingDir) || ctx.workingDir;
      parts.push(`# Проект: ${name}`);
      parts.push(`- Путь: ${ctx.workingDir}`);

      const sessionId = ctx.sessionId || extra?.sessionId;
      if (sessionId && extra?.sessionManager) {
        try {
          const session = await extra.sessionManager.getSession(sessionId);
          if (session?.projectId) {
            parts.push(`- ID: ${session.projectId}`);
          }
        } catch {
          // сессию не определить — пропускаем
        }
      }
    }

    const repo = await detectRepoInfo(projectDir);
    if (repo) {
      parts.push('');
      parts.push('## Git-репозиторий');
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
  capabilities: [ToolCapability.GIT_READ],
  async execute(_args, ctx) {
    const parts: string[] = [];

    const project = await loadProject(ctx);
    // Каталог жёстко определён проектом (project.workspace); произвольный
    // ввод пути от агента инструмент не принимает (z.object({})).
    const extra = ctx.extra as ProjectContextExtra | undefined;
    const projectDir = resolveWorkspaceDir(project, extra?.workspacesRoot, ctx.workingDir);

    if (project?.repos && project.repos.length > 0) {
      parts.push(`# Репозитории проекта ${project.name}:`);
      for (const repoCfg of project.repos) {
        // Относительные пути репозиториев резолвим относительно рабочего
        // каталога проекта, чтобы git-детект искал в правильном месте.
        const repoPath = resolveRepoPath(repoCfg.path, projectDir);
        const repo = await detectRepoInfo(repoPath);
        if (repo) {
          parts.push(formatRepo(repo, repoPath));
        } else {
          parts.push(`- ${repoPath} (не найден или не git-репозиторий)`);
        }
      }
    } else {
      const repos = await findReposInDir(projectDir);
      if (repos.length === 0) {
        return {
          content: `Git-репозитории в "${projectDir}" не найдены`,
          metadata: {
            workingDir: ctx.workingDir,
            ...(project?.workspace ? { projectWorkspace: projectDir } : {}),
            count: 0,
          },
        };
      }
      parts.push(`# Git-репозитории в ${projectDir}:`);
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
