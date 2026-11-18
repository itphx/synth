// git: домен API v2 (ADR-095) — объект `gitApi` и его DTO.

import type {
  CommitDetail,
  CommitInfo,
  GitWorktreeDiff,
  GitWorktreeStatusResponse,
  RepoStatus,
} from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

/**
 * ADR-076: запись реестра git-репозиториев проекта. Полная форма
 * (`GitRepoConfig` из shared); `path` — относительный путь внутри workspace.
 */
export interface GitRepoConfigData {
  id?: string
  name?: string
  url?: string
  type?: 'https' | 'ssh'
  /** Относительный путь внутри `project.workspace`; `''`/`.` — корень workspace. */
  path: string
  defaultBranch?: string
  sshKeyId?: string
  lastFetch?: string
}

export const gitApi = {
  // Git
  async scanGitRepos(projectId: string): Promise<{ repos: RepoStatus[] }> {
    return fetchJSON(`${BASE_URL}/git/scan`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    })
  },

  async initGitRepo(
    projectId: string,
    path: string,
    defaultBranch?: string,
    name?: string,
    sshKeyId?: string,
  ): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/init`, {
      method: 'POST',
      body: JSON.stringify({ projectId, path, defaultBranch, name, sshKeyId }),
    })
  },

  async cloneGitRepo(
    projectId: string,
    url: string,
    path?: string,
    branch?: string,
    name?: string,
    sshKeyId?: string,
    /** Отмена клонирования (`AbortController`): сеть может идти минутами. */
    signal?: AbortSignal,
  ): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/clone`, {
      method: 'POST',
      body: JSON.stringify({ projectId, url, path, branch, name, sshKeyId }),
      signal,
    })
  },

  /** ADR-076: upsert записи реестра (идемпотентно по `path`). */
  async registerGitRepo(
    projectId: string,
    entry: { path: string; name?: string; url?: string; type?: 'https' | 'ssh'; defaultBranch?: string; sshKeyId?: string },
  ): Promise<GitRepoConfigData> {
    return fetchJSON(`${BASE_URL}/git/repos/register`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...entry }),
    })
  },

  /** ADR-076: удаление записи реестра; `deleteLocal` — удалить и локальные файлы. */
  async removeGitRepo(
    projectId: string,
    opts: { id?: string; path?: string; deleteLocal?: boolean },
  ): Promise<{ removed: GitRepoConfigData; deletedLocal: boolean }> {
    return fetchJSON(`${BASE_URL}/git/repos/remove`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...opts }),
    })
  },

  /** ADR-076: fetch репозитория реестра (обновление `lastFetch`). */
  async fetchGitRepo(
    projectId: string,
    opts: { id?: string; path?: string },
    /** Отмена операции (`AbortController`) — сеть может идти минутами. */
    signal?: AbortSignal,
  ): Promise<{ path: string; lastFetch: string }> {
    return fetchJSON(`${BASE_URL}/git/repos/fetch`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...opts }),
      signal,
    })
  },

  async getCommitLog(projectId: string, repoPath?: string, maxCount?: number): Promise<{ commits: CommitInfo[] }> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath || '' })
    if (maxCount) params.set('max_count', String(maxCount))
    return fetchJSON(`${BASE_URL}/git/log?${params.toString()}`)
  },

  async getCommitDetail(projectId: string, repoPath: string, hash: string): Promise<{ commit: CommitDetail }> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath, hash })
    return fetchJSON(`${BASE_URL}/git/commit?${params.toString()}`)
  },

  /**
   * ADR-076 (этап 1): состояние рабочего дерева репозиториев проекта.
   * `repoPath` — путь относительно workspace (`''` — корень).
   */
  async getGitStatus(projectId: string, repoPath?: string): Promise<GitWorktreeStatusResponse> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath ?? '' })
    return fetchJSON(`${BASE_URL}/git/status?${params.toString()}`)
  },

  /**
   * ADR-076 (этап 1): diff рабочего дерева. Без `path` — сводный diff
   * репозитория; `staged` — diff индекса.
   */
  async getGitDiff(
    projectId: string,
    repoPath: string,
    opts?: { path?: string; staged?: boolean; context?: number },
  ): Promise<GitWorktreeDiff> {
    const params = new URLSearchParams({ project_id: projectId, repo_path: repoPath })
    if (opts?.path) params.set('path', opts.path)
    if (opts?.staged) params.set('staged', 'true')
    if (opts?.context !== undefined) params.set('context', String(opts.context))
    const res = await fetchJSON<{ diff: GitWorktreeDiff }>(`${BASE_URL}/git/diff?${params.toString()}`)
    return res.diff
  },
}
