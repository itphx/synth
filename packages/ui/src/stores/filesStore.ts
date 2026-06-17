import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FileEntry } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

interface FilesStore {
  treesByProject: Record<string, FileEntry[]>
  loading: boolean
  error: string | null
  expandedProjects: Set<string>
  expandedDirs: Set<string>
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
  expandProject: (projectId: string) => void
  expandAll: () => void
  collapseAll: () => void

  toggleDirExpand: (projectId: string, dirPath: string) => void
  ensureDirExpanded: (projectId: string, dirPath: string) => void
  collapseAllDirs: () => void

  toggleSelectionMode: () => void
  toggleSelectedPath: (key: string) => void
  clearSelection: () => void
  deleteSelectedEntries: (projectId: string) => Promise<void>
  toggleShowHidden: () => void
}

export const useFilesStore = create<FilesStore>()(
  persist(
    (set, get) => {
      const getParentPath = (path: string): string => {
        const idx = path.lastIndexOf('/')
        return idx === -1 ? '' : path.slice(0, idx)
      }

      const reloadDir = async (projectId: string, dirPath: string) => {
        const { showHidden } = get()
        const result = await synthApi.listDirectory(projectId, dirPath, showHidden)
        set((s) => ({
          treesByProject: {
            ...s.treesByProject,
            [dirPath ? `${projectId}/${dirPath}` : projectId]: result.entries,
          },
        }))
      }

      const removeSubTree = (projectId: string, subPath: string) => {
        set((s) => {
          const trees = { ...s.treesByProject }
          const prefix = `${projectId}/${subPath}`
          for (const key of Object.keys(trees)) {
            if (key === prefix || key.startsWith(`${prefix}/`)) {
              delete trees[key]
            }
          }
          return { treesByProject: trees }
        })
      }

      return {
        treesByProject: {},
        loading: false,
        error: null,
        expandedProjects: new Set<string>(),
        expandedDirs: new Set<string>(),
        showHidden: false,
        selectionMode: false,
        selectedPaths: {},

        loadFileTree: async (projectId, path = '') => {
          set({ loading: true, error: null })
          try {
            const { showHidden } = get()
            const result = await synthApi.listDirectory(projectId, path, showHidden)
            set((s) => ({
              treesByProject: {
                ...s.treesByProject,
                [path ? `${projectId}/${path}` : projectId]: result.entries,
              },
              loading: false,
            }))
          } catch (e) {
            set({ error: (e as Error).message, loading: false })
          }
        },

        loadSubDirectory: async (projectId, dirPath) => {
          try {
            const { showHidden } = get()
            const result = await synthApi.listDirectory(projectId, dirPath, showHidden)
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
            await reloadDir(projectId, dirPath)
            return true
          } catch (e) {
            set({ error: (e as Error).message })
            return false
          }
        },

        createDirectory: async (projectId, path) => {
          try {
            await synthApi.createDirectory(projectId, path)
            await reloadDir(projectId, getParentPath(path))
            return true
          } catch (e) {
            set({ error: (e as Error).message })
            return false
          }
        },

        createFile: async (projectId, path) => {
          try {
            await synthApi.writeFile(projectId, path, '')
            await reloadDir(projectId, getParentPath(path))
            return true
          } catch (e) {
            set({ error: (e as Error).message })
            return false
          }
        },

        moveEntry: async (projectId, sourcePath, targetPath) => {
          try {
            await synthApi.moveEntry(projectId, sourcePath, targetPath)
            const srcParent = getParentPath(sourcePath)
            const dstParent = getParentPath(targetPath)

            removeSubTree(projectId, sourcePath)

            await reloadDir(projectId, srcParent)
            if (dstParent !== srcParent) {
              await reloadDir(projectId, dstParent)
            }
            return true
          } catch (e) {
            set({ error: (e as Error).message })
            return false
          }
        },

        deleteEntry: async (projectId, path) => {
          try {
            await synthApi.deleteEntry(projectId, path)
            removeSubTree(projectId, path)
            await reloadDir(projectId, getParentPath(path))
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

        expandProject: (projectId) => {
          set((s) => {
            if (s.expandedProjects.has(projectId)) return s
            const next = new Set(s.expandedProjects)
            next.add(projectId)
            return { expandedProjects: next }
          })
        },

        expandAll: () => {
          // no-op: projects are expanded individually
        },

        collapseAll: () => {
          set({ expandedProjects: new Set() })
        },

        toggleDirExpand: (projectId, dirPath) => {
          const key = `${projectId}/${dirPath}`
          set((s) => {
            const next = new Set(s.expandedDirs)
            if (next.has(key)) {
              next.delete(key)
            } else {
              next.add(key)
              const { loadSubDirectory } = get()
              loadSubDirectory(projectId, dirPath)
            }
            return { expandedDirs: next }
          })
        },

        ensureDirExpanded: (projectId, dirPath) => {
          const key = `${projectId}/${dirPath}`
          set((s) => {
            if (s.expandedDirs.has(key)) return s
            const next = new Set(s.expandedDirs)
            next.add(key)
            return { expandedDirs: next }
          })
        },

        collapseAllDirs: () => {
          set({ expandedDirs: new Set() })
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
          const affectedParents = new Set<string>()

          for (const key of Object.keys(state.selectedPaths)) {
            const sepIdx = key.indexOf('::')
            if (sepIdx === -1) continue
            const pid = key.slice(0, sepIdx)
            if (pid !== projectId) continue
            const filePath = key.slice(sepIdx + 2)
            try {
              await synthApi.deleteEntry(projectId, filePath)
              affectedParents.add(getParentPath(filePath))
              removeSubTree(projectId, filePath)
            } catch { /* continue */ }
          }

          for (const parent of affectedParents) {
            try { await reloadDir(projectId, parent) } catch { /* best effort */ }
          }

          get().clearSelection()
        },

        toggleShowHidden: () => {
          set((s) => ({ showHidden: !s.showHidden }))
        },
      }
    },
    {
      name: 'synth-ui-files',
      partialize: (state) => ({
        expandedProjects: [...state.expandedProjects],
        expandedDirs: [...state.expandedDirs],
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        return {
          ...current,
          expandedProjects: Array.isArray(p?.expandedProjects)
            ? new Set(p.expandedProjects as string[])
            : current.expandedProjects,
          expandedDirs: Array.isArray(p?.expandedDirs)
            ? new Set(p.expandedDirs as string[])
            : current.expandedDirs,
        }
      },
    }
  )
)
