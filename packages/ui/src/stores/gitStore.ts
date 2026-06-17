import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { synthApi } from '@/lib/api/synthApi'
import type { RepoStatus, CommitInfo, CommitDetail } from '@synth/shared'

interface GitStore {
  reposByProject: Record<string, RepoStatus[]>
  commitsByRepo: Record<string, CommitInfo[]>
  loading: boolean
  error: string | null

  expandedProjects: Set<string>
  expandedRepos: Set<string>
  showMoreLimits: Record<string, number>

  loadRepos: (projectId: string, repos: { path: string }[]) => Promise<void>
  scanWorkspace: (projectId: string) => Promise<RepoStatus[] | null>
  initRepo: (projectId: string, path: string, defaultBranch?: string) => Promise<RepoStatus | null>
  cloneRepo: (projectId: string, url: string, path: string, branch?: string) => Promise<RepoStatus | null>
  loadCommitLog: (projectId: string, repoPath: string) => Promise<CommitInfo[] | null>
  loadCommitDetail: (projectId: string, repoPath: string, hash: string) => Promise<CommitDetail | null>

  toggleProjectExpand: (projectId: string) => void
  expandProject: (projectId: string) => void
  toggleRepoExpand: (projectId: string, repoPath: string) => void
  collapseAll: () => void

  setShowMoreLimit: (key: string, limit: number) => void
}

const MAX_VISIBLE_COMMITS = 10

function repoKey(projectId: string, repoPath: string): string {
  return `${projectId}::${repoPath}`
}

export const useGitStore = create<GitStore>()(
  persist(
    (set, get) => ({
  reposByProject: {},
  commitsByRepo: {},
  loading: false,
  error: null,

  expandedProjects: new Set<string>(),
  expandedRepos: new Set<string>(),
  showMoreLimits: {},

  loadRepos: async (projectId, repos) => {
    if (!repos || repos.length === 0) {
      set((s) => ({
        reposByProject: { ...s.reposByProject, [projectId]: [] },
      }))
      return
    }

    set((s) => ({
      loading: true,
      error: null,
      reposByProject: {
        ...s.reposByProject,
        [projectId]: repos.map((r) => ({
          path: r.path,
          isRepo: true,
        })),
      },
    }))
    set({ loading: false })
  },

  scanWorkspace: async (projectId) => {
    set({ loading: true, error: null })
    try {
      const result = await synthApi.scanGitRepos(projectId)
      set((s) => ({
        reposByProject: { ...s.reposByProject, [projectId]: result.repos },
        loading: false,
      }))
      return result.repos
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  initRepo: async (projectId, path, defaultBranch) => {
    set({ loading: true, error: null })
    try {
      const repo = await synthApi.initGitRepo(projectId, path, defaultBranch)
      set((s) => ({
        reposByProject: {
          ...s.reposByProject,
          [projectId]: [...(s.reposByProject[projectId] || []), repo],
        },
        loading: false,
      }))
      return repo
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
    }
  },

  cloneRepo: async (projectId, url, path, branch) => {
    set({ loading: true, error: null })
    try {
      const repo = await synthApi.cloneGitRepo(projectId, url, path, branch)
      set((s) => ({
        reposByProject: {
          ...s.reposByProject,
          [projectId]: [...(s.reposByProject[projectId] || []), repo],
        },
        loading: false,
      }))
      return repo
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
      return null
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
