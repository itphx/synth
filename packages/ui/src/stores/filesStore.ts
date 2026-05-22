import { create } from 'zustand'
import type { FileEntry } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

interface FilesStore {
  treesByProject: Record<string, FileEntry[]>
  loading: boolean
  error: string | null

  loadFileTree: (projectId: string, path?: string) => Promise<void>
  readFileContent: (projectId: string, path: string) => Promise<string | null>
  clearTree: (projectId: string) => void
}

export const useFilesStore = create<FilesStore>((set) => ({
  treesByProject: {},
  loading: false,
  error: null,

  loadFileTree: async (projectId, path = '') => {
    set({ loading: true, error: null })
    try {
      const result = await synthApi.listDirectory(projectId, path)
      set((s) => ({
        treesByProject: { ...s.treesByProject, [projectId]: result.entries },
        loading: false,
      }))
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  readFileContent: async (projectId, path) => {
    try {
      const result = await synthApi.readFile(projectId, path)
      return result.content
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  clearTree: (projectId) => {
    set((s) => {
      const trees = { ...s.treesByProject }
      delete trees[projectId]
      return { treesByProject: trees }
    })
  },
}))
