// git: домен API v2 (ADR-095) — объект `gitApi` и его DTO.

import type { CommitDetail, CommitInfo, RepoStatus } from '@itphx/synth-shared/types'
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
  ): Promise<RepoStatus> {
    return fetchJSON(`${BASE_URL}/git/repos/clone`, {
      method: 'POST',
      body: JSON.stringify({ projectId, url, path, branch, name, sshKeyId }),
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
  ): Promise<{ path: string; lastFetch: string }> {
    return fetchJSON(`${BASE_URL}/git/repos/fetch`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...opts }),
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
}
