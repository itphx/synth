import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { synthApi } from '@/lib/api/synthApi'
import type { GitRepoConfigData } from '@/lib/api/synthApi'
import type { RepoStatus, CommitInfo, CommitDetail } from '@itphx/synth-shared'

/**
 * AD-076: запись реестра проекта + git-статус, собранные для дерева Git-вкладки.
 * `path` — относительный путь внутри workspace; `''`/`.` — корень workspace.
 */
export interface GitRepoView extends GitRepoConfigData {
  isRepo?: boolean
  currentBranch?: string
  lastCommitAt?: string
  lastCommitSubject?: string
}

/** Нормализация пути репозитория для сопоставления scan ↔ реестр. */
function normRepoPath(path: string): string {
  return path === '' || path === '.' ? '' : path
}

interface GitStore {
  reposByProject: Record<string, GitRepoView[]>
  commitsByRepo: Record<string, CommitInfo[]>
  loading: boolean
  error: string | null

  expandedProjects: Set<string>
  expandedRepos: Set<string>
  showMoreLimits: Record<string, number>

  loadRepos: (projectId: string, repos: GitRepoConfigData[] | null) => Promise<void>
  scanWorkspace: (projectId: string) => Promise<RepoStatus[] | null>
  initRepo: (
    projectId: string,
    path: string,
    defaultBranch?: string,
    name?: string,
    sshKeyId?: string,
  ) => Promise<RepoStatus | null>
  cloneRepo: (
    projectId: string,
    url: string,
    path?: string,
    branch?: string,
    name?: string,
    sshKeyId?: string,
  ) => Promise<RepoStatus | null>
  registerRepo: (
    projectId: string,
    entry: { path: string; name?: string; url?: string; type?: 'https' | 'ssh'; defaultBranch?: string; sshKeyId?: string },
  ) => Promise<GitRepoConfigData | null>
  removeRepo: (projectId: string, opts: { id?: string; path?: string; deleteLocal?: boolean }) => Promise<boolean>
  fetchRepo: (projectId: string, opts: { id?: string; path?: string }) => Promise<boolean>
  loadCommitLog: (projectId: string, repoPath: string) => Promise<CommitInfo[] | null>
  loadCommitDetail: (projectId: string, repoPath: string, hash: string) => Promise<CommitDetail | null>

  toggleProjectExpand: (projectId: string) => void
  expandProject: (projectId: string) => void
  toggleRepoExpand: (projectId: string, repoPath: string) => void
  expandAll: (projectIds: string[]) => void
  collapseAll: () => void

  setShowMoreLimit: (key: string, limit: number) => void
}

function repoKey(projectId: string, repoPath: string): string {
  return `${projectId}::${repoPath}`
}

export const useGitStore = create<GitStore>()(
  persist(
    (set) => ({
  reposByProject: {},
  commitsByRepo: {},
  loading: false,
  error: null,

  expandedProjects: new Set<string>(),
  expandedRepos: new Set<string>(),
  showMoreLimits: {},

  // Собирает отображаемый список реестра, сохраняя git-статус по совпадающему пути.
  loadRepos: async (projectId, repos) => {
    set((s) => {
      const prev = s.reposByProject[projectId] ?? []
      const byPath = new Map(prev.map((r) => [r.path, r]))
      const list = (repos ?? []) as Array<GitRepoConfigData | string>
      const next: GitRepoView[] = list.map((raw) => {
        const entry: GitRepoConfigData = typeof raw === 'string' ? { path: raw } : raw
        const prevEntry = byPath.get(entry.path)
        return { ...(prevEntry ?? {}), ...entry, isRepo: true }
      })
      return { reposByProject: { ...s.reposByProject, [projectId]: next }, error: null }
    })
  },

  scanWorkspace: async (projectId) => {
    set({ loading: true, error: null })
    try {
      const result = await synthApi.scanGitRepos(projectId)
      set((s) => {
        const statusByPath = new Map(result.repos.map((r) => [normRepoPath(r.path), r]))
        const prev = s.reposByProject[projectId] ?? []
        const next = prev.map((r) => {
          const status = statusByPath.get(normRepoPath(r.path))
          return status ? { ...r, ...status, path: r.path, isRepo: true } : r
        })
        return { reposByProject: { ...s.reposByProject, [projectId]: next }, loading: false }
      })
      return result.repos
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  initRepo: async (projectId, path, defaultBranch, name, sshKeyId) => {
    set({ loading: true, error: null })
    try {
      const repo = await synthApi.initGitRepo(projectId, path, defaultBranch, name, sshKeyId)
      set({ loading: false })
      return repo
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  cloneRepo: async (projectId, url, path, branch, name, sshKeyId) => {
    set({ loading: true, error: null })
    try {
      const repo = await synthApi.cloneGitRepo(projectId, url, path, branch, name, sshKeyId)
      set({ loading: false })
      return repo
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  registerRepo: async (projectId, entry) => {
    set({ loading: true, error: null })
    try {
      const registered = await synthApi.registerGitRepo(projectId, entry)
      set({ loading: false })
      return registered
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  removeRepo: async (projectId, opts) => {
    set({ loading: true, error: null })
    try {
      await synthApi.removeGitRepo(projectId, opts)
      set({ loading: false })
      return true
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return false
    }
  },

  fetchRepo: async (projectId, opts) => {
    set({ loading: true, error: null })
    try {
      await synthApi.fetchGitRepo(projectId, opts)
      set({ loading: false })
      return true
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return false
    }
  },

  loadCommitLog: async (projectId, repoPath) => {
    const key = repoKey(projectId, repoPath)
    try {
      const result = await synthApi.getCommitLog(projectId, repoPath || '')
      set((s) => ({
        commitsByRepo: { ...s.commitsByRepo, [key]: result.commits },
      }))
      return result.commits
    } catch {
      return null
    }
  },

  loadCommitDetail: async (projectId, repoPath, hash) => {
    try {
      const result = await synthApi.getCommitDetail(projectId, repoPath, hash)
      return result.commit
    } catch {
      return null
    }
  },

  toggleProjectExpand: (projectId) => {
    set((s) => {
      const next = new Set(s.expandedProjects)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return { expandedProjects: next }
    })
  },

  expandProject: (projectId) => {
    set((s) => {
      if (s.expandedProjects.has(projectId)) return {}
      const next = new Set(s.expandedProjects)
      next.add(projectId)
      return { expandedProjects: next }
    })
  },

  toggleRepoExpand: (projectId, repoPath) => {
    const key = repoKey(projectId, repoPath)
    set((s) => {
      const next = new Set(s.expandedRepos)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return { expandedRepos: next }
    })
  },

  // Раскрывает переданные проекты и все их репозитории (для кнопки «развернуть всё»).
  // Проекты вне списка (скрытые при onlyActiveProject) не трогает.
  expandAll: (projectIds) => {
    set((s) => {
      const nextProjects = new Set(s.expandedProjects)
      const nextRepos = new Set(s.expandedRepos)
      for (const projectId of projectIds) {
        nextProjects.add(projectId)
        for (const repo of s.reposByProject[projectId] ?? []) {
          nextRepos.add(repoKey(projectId, repo.path))
        }
      }
      return { expandedProjects: nextProjects, expandedRepos: nextRepos }
    })
  },

  collapseAll: () => {
    set({ expandedProjects: new Set(), expandedRepos: new Set() })
  },

  setShowMoreLimit: (key, limit) => {
    set((s) => ({
      showMoreLimits: { ...s.showMoreLimits, [key]: limit },
    }))
  },
    }),
    {
      name: 'synth-ui-git',
      partialize: (state) => ({
        expandedProjects: [...state.expandedProjects],
        expandedRepos: [...state.expandedRepos],
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        return {
          ...current,
          expandedProjects: Array.isArray(p?.expandedProjects)
            ? new Set(p.expandedProjects as string[])
            : current.expandedProjects,
          expandedRepos: Array.isArray(p?.expandedRepos)
            ? new Set(p.expandedRepos as string[])
            : current.expandedRepos,
        }
      },
    }
  )
)
