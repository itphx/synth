import { create } from 'zustand'
import type { FileEntry } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

interface FilesStore {
  treesByProject: Record<string, FileEntry[]>
  loading: boolean
  error: string | null
  expandedProjects: Set<string>
  showHidden: boolean
  selectionMode: boolean
  selectedPaths: Record<string, true>

  loadFileTree: (projectId: string, path?: string) => Promise<void>
  loadSubDirectory: (projectId: string, dirPath: string) => Promise<void>
  readFileContent: (projectId: string, path: string) => Promise<string | null>
  writeFile: (projectId: string, path: string, content: string) => Promise<boolean>
  uploadFile: (projectId: string, dirPath: string, file: File) => Promise<boolean>
  createDirectory: (projectId: string, path: string) => Promise<boolean>
  createFile: (projectId: string, path: string) => Promise<boolean>
  deleteEntry: (projectId: string, path: string) => Promise<boolean>
  moveEntry: (projectId: string, sourcePath: string, targetPath: string) => Promise<boolean>
  clearTree: (projectId: string) => void

  toggleProjectExpand: (projectId: string) => void
  expandAll: () => void
  collapseAll: () => void

  toggleSelectionMode: () => void
  toggleSelectedPath: (key: string) => void
  clearSelection: () => void
  deleteSelectedEntries: (projectId: string) => Promise<void>
  toggleShowHidden: () => void
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  treesByProject: {},
  loading: false,
  error: null,
  expandedProjects: new Set<string>(),
  showHidden: false,
  selectionMode: false,
  selectedPaths: {},

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

  loadSubDirectory: async (projectId, dirPath) => {
    try {
      const result = await synthApi.listDirectory(projectId, dirPath)
      set((s) => ({
        treesByProject: {
          ...s.treesByProject,
          [`${projectId}/${dirPath}`]: result.entries,
        },
      }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  readFileContent: async (projectId, path) => {
    try {
      const result = await synthApi.readFile(projectId, path)
      if (result.encoding === 'binary') {
        return `[Бинарный файл, ${result.size} байт]`
      }
      return result.content
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  writeFile: async (projectId, path, content) => {
    try {
      await synthApi.writeFile(projectId, path, content)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  uploadFile: async (projectId, dirPath, file) => {
    try {
      await synthApi.uploadFile(projectId, dirPath, file)
      await get().loadFileTree(projectId)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  createDirectory: async (projectId, path) => {
    try {
      await synthApi.createDirectory(projectId, path)
      await get().loadFileTree(projectId)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  createFile: async (projectId, path) => {
    try {
      await synthApi.writeFile(projectId, path, '')
      await get().loadFileTree(projectId)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  moveEntry: async (projectId, sourcePath, targetPath) => {
    try {
      await synthApi.moveEntry(projectId, sourcePath, targetPath)
      await get().loadFileTree(projectId)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  deleteEntry: async (projectId, path) => {
    try {
      await synthApi.deleteEntry(projectId, path)
      await get().loadFileTree(projectId)
      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  clearTree: (projectId) => {
    set((s) => {
      const trees = { ...s.treesByProject }
      delete trees[projectId]
      return { treesByProject: trees }
    })
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

  expandAll: () => {
    // no-op: projects are expanded individually
  },

  collapseAll: () => {
    set({ expandedProjects: new Set() })
  },

  toggleSelectionMode: () => {
    set((s) => ({ selectionMode: !s.selectionMode }))
  },

  toggleSelectedPath: (key) => {
    set((s) => {
      const next = { ...s.selectedPaths }
      if (next[key]) {
        delete next[key]
      } else {
        next[key] = true
      }
      return { selectedPaths: next }
    })
  },

  clearSelection: () => {
    set({ selectedPaths: {} })
  },

  deleteSelectedEntries: async (projectId) => {
    const state = get()
    for (const key of Object.keys(state.selectedPaths)) {
      const sepIdx = key.indexOf('::')
      if (sepIdx === -1) continue
      const pid = key.slice(0, sepIdx)
      if (pid !== projectId) continue
      const filePath = key.slice(sepIdx + 2)
      try {
        await synthApi.deleteEntry(projectId, filePath)
      } catch { /* continue */ }
    }
    await get().loadFileTree(projectId)
    get().clearSelection()
  },

  toggleShowHidden: () => {
    set((s) => ({ showHidden: !s.showHidden }))
  },
}))
