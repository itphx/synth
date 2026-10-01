import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FileEntry } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'

/** fs.changed: окно коалесинга refresh дерева на проект. */
const FS_REFRESH_DEBOUNCE_MS = 400
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Операция мутирующего тула, пришедшая в `fs.changed` (scope:'file'). */
export type FsChangeOp = 'write' | 'delete' | 'mkdir' | 'move'

/** fs.changed: накопленные за окно debounce подсказки по проекту. */
interface PendingFsChange {
  /** Хотя бы одно событие было широким (`scope:'all'`) — обновляем всё дерево. */
  all: boolean
  workspaceChanged: boolean
  /** Последняя операция по каждому пути за окно (coalescing: «последний wins»). */
  ops: Map<string, FsChangeOp | undefined>
}

const pendingChanges = new Map<string, PendingFsChange>()

export interface FsChangeHint {
  scope: 'file' | 'all'
  paths?: string[]
  workspaceChanged?: boolean
  op?: FsChangeOp
  /** Для `op:'move'` — исходный относительный POSIX-путь внутри workspace. */
  from?: string
  /** Для `op:'move'` — целевой относительный POSIX-путь внутри workspace. */
  to?: string
}

interface FilesStore {
  treesByProject: Record<string, FileEntry[]>
  /** fs.changed: счётчик успешных серверных refresh на проект (инвалидация редакторов). */
  revisionByProject: Record<string, number>
  /** fs.changed: пер-файловые ревизии, ключ `${projectId}::${path}` (инвалидация редакторов). */
  fileRevisions: Record<string, number>
  /** fs.changed: файлы, удалённые агентом, ключ `${projectId}::${path}`. */
  deletedFiles: Record<string, true>
  /** Черновики открытых редакторов, ключ `${projectId}::${path}`. Runtime-only. */
  draftContents: Record<string, string>
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
  moveEntry: (
    projectId: string,
    sourcePath: string,
    targetPath: string,
    targetProjectId?: string,
  ) => Promise<boolean>
  /** Префиксный перемап ключей поддерева при переносе/переименовании (без сети). */
  remapPath: (
    sourceProjectId: string,
    sourcePath: string,
    targetProjectId: string,
    targetPath: string,
  ) => void
  clearTree: (projectId: string) => void
  /** Запомнить черновик открытого редактора (равен оригиналу → удалить). */
  setDraft: (projectId: string, path: string, content: string, originalContent: string) => void
  /** Убрать черновик открытого редактора (идемпотентно). */
  clearDraft: (projectId: string, path: string) => void

  /** fs.changed: перечитывает корень и все загруженные каталоги проекта. */
  refreshProject: (projectId: string) => Promise<void>
  /** fs.changed: точечно перечитывает только указанные загруженные каталоги. */
  refreshDirs: (projectId: string, dirs: string[]) => Promise<void>
  /** fs.changed: снять пометку «удалён агентом» после успешного перечитывания. */
  clearDeletedFile: (projectId: string, path: string) => void
  /** Детект удаления по факту (404 при чтении): пометить файл удалённым. */
  markDeletedFile: (projectId: string, path: string) => void
  /** fs.changed: debounce-обёртка над refreshProject (коалесинг по проекту). */
  scheduleRefresh: (projectId: string, change: FsChangeHint) => void

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

      /**
       * Новый ключ при перемапе префикса: ровно `prefix` → `newPrefix`,
       * `prefix + '/'` → `newPrefix + остаток`. Иначе — `null` (не относится).
       */
      const remapKey = (key: string, prefix: string, newPrefix: string): string | null => {
        if (key === prefix) return newPrefix
        if (key.startsWith(`${prefix}/`)) return newPrefix + key.slice(prefix.length)
        return null
      }

      /** Перемап префиксных ключей записи; без изменений возвращает исходную ссылку. */
      const remapRecord = <T>(record: Record<string, T>, prefix: string, newPrefix: string): Record<string, T> => {
        let changed = false
        const next: Record<string, T> = {}
        for (const [key, value] of Object.entries(record)) {
          const mapped = remapKey(key, prefix, newPrefix)
          if (mapped === null) {
            next[key] = value
          } else {
            if (mapped !== key) changed = true
            next[mapped] = value
          }
        }
        return changed ? next : record
      }

      /**
       * Переписывает `path` записей листинга при переносе поддерева
       * (относительные пути): `sourcePath` → `targetPath` и `sourcePath/...` →
       * `targetPath/...`. Без изменений возвращает исходный массив.
       */
      const remapTreeEntries = (
        entries: FileEntry[],
        sourcePath: string,
        targetPath: string,
      ): FileEntry[] => {
        let changed = false
        const next = entries.map((e) => {
          let newPath: string | null = null
          if (e.path === sourcePath) {
            newPath = targetPath
          } else if (e.path.startsWith(`${sourcePath}/`)) {
            newPath = targetPath + e.path.slice(sourcePath.length)
          }
          if (newPath === null || newPath === e.path) return e
          changed = true
          return { ...e, path: newPath }
        })
        return changed ? next : entries
      }

      /**
       * Перемап ключей `treesByProject` + переписывание `path` записей у
       * перенесённого поддерева (ключи под `treePrefix`). Родительский листинг
       * (srcParent) остаётся как есть — он перечитывается с сервера.
       */
      const remapTrees = (
        trees: Record<string, FileEntry[]>,
        treePrefix: string,
        treeNewPrefix: string,
        sourcePath: string,
        targetPath: string,
      ): Record<string, FileEntry[]> => {
        let changed = false
        const next: Record<string, FileEntry[]> = {}
        for (const [key, entries] of Object.entries(trees)) {
          const mapped = remapKey(key, treePrefix, treeNewPrefix)
          const nextKey = mapped ?? key
          const nextEntries = mapped === null
            ? entries
            : remapTreeEntries(entries, sourcePath, targetPath)
          if (nextKey !== key || nextEntries !== entries) changed = true
          next[nextKey] = nextEntries
        }
        return changed ? next : trees
      }

      /** Перемап префиксных ключей Set; без изменений возвращает исходную ссылку. */
      const remapSet = (set: Set<string>, prefix: string, newPrefix: string): Set<string> => {
        let changed = false
        const next = new Set<string>()
        for (const key of set) {
          const mapped = remapKey(key, prefix, newPrefix)
          if (mapped === null) {
            next.add(key)
          } else {
            if (mapped !== key) changed = true
            next.add(mapped)
          }
        }
        return changed ? next : set
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

      /**
       * fs.changed: применяет накопленные за окно debounce подсказки.
       * `all` — полный refresh проекта; иначе — точечно родительские каталоги,
       * пер-файловые ревизии и пометки об удалении.
       */
      const applyFsChange = async (projectId: string, acc: PendingFsChange) => {
        if (acc.all || acc.workspaceChanged) {
          await get().refreshProject(projectId)
          return
        }
        const paths = [...acc.ops.keys()]
        if (paths.length === 0) return

        const parents = [...new Set(paths.map((p) => getParentPath(p)))]
        await get().refreshDirs(projectId, parents)

        set((s) => {
          const fileRevisions = { ...s.fileRevisions }
          const deletedFiles = { ...s.deletedFiles }
          for (const path of paths) {
            const key = `${projectId}::${path}`
            fileRevisions[key] = (fileRevisions[key] ?? 0) + 1
            const op = acc.ops.get(path)
            if (op === 'delete') {
              deletedFiles[key] = true
            } else if (op === 'write' || op === 'mkdir') {
              delete deletedFiles[key]
            }
            // op === 'move': файл перенесён (не удалён) — пометку удаления не
            // выставляем и не снимаем; ключи уже перемаплены `remapPath`.
          }
          return { fileRevisions, deletedFiles }
        })
      }

      return {
        treesByProject: {},
        revisionByProject: {},
        fileRevisions: {},
        deletedFiles: {},
        draftContents: {},
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

        remapPath: (sourceProjectId, sourcePath, targetProjectId, targetPath) => {
          set((s) => {
            // Префиксы ключей: `${pid}/${rel}` — деревья/раскрытие,
            // `${pid}::${rel}` — ревизии/удаления/черновики.
            const treePrefix = `${sourceProjectId}/${sourcePath}`
            const treeNewPrefix = `${targetProjectId}/${targetPath}`
            const filePrefix = `${sourceProjectId}::${sourcePath}`
            const fileNewPrefix = `${targetProjectId}::${targetPath}`
            const treesByProject = remapTrees(s.treesByProject, treePrefix, treeNewPrefix, sourcePath, targetPath)
            const expandedDirs = remapSet(s.expandedDirs, treePrefix, treeNewPrefix)
            const fileRevisions = remapRecord(s.fileRevisions, filePrefix, fileNewPrefix)
            const deletedFiles = remapRecord(s.deletedFiles, filePrefix, fileNewPrefix)
            const draftContents = remapRecord(s.draftContents, filePrefix, fileNewPrefix)
            if (
              treesByProject === s.treesByProject
              && expandedDirs === s.expandedDirs
              && fileRevisions === s.fileRevisions
              && deletedFiles === s.deletedFiles
              && draftContents === s.draftContents
            ) {
              return s
            }
            return { treesByProject, expandedDirs, fileRevisions, deletedFiles, draftContents }
          })
        },

        moveEntry: async (projectId, sourcePath, targetPath, targetProjectId) => {
          const dstProjectId = targetProjectId ?? projectId
          try {
            await synthApi.moveEntry(projectId, sourcePath, targetPath, targetProjectId)
            // Перемап поддерева по префиксу: дерево, раскрытие, файловые ревизии,
            // пометки удаления и черновики редакторов. Родителей перечитываем ниже
            // (актуальная запись перемещённого элемента), а содержимое поддерева
            // сохраняем перемапленным, чтобы раскрытый каталог не схлопывался.
            get().remapPath(projectId, sourcePath, dstProjectId, targetPath)

            const srcParent = getParentPath(sourcePath)
            const dstParent = getParentPath(targetPath)
            await reloadDir(projectId, srcParent)
            if (dstProjectId !== projectId || dstParent !== srcParent) {
              await reloadDir(dstProjectId, dstParent)
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

        setDraft: (projectId, path, content, originalContent) => {
          const key = `${projectId}::${path}`
          set((s) => {
            if (content === originalContent) {
              if (!(key in s.draftContents)) return s
              const draftContents = { ...s.draftContents }
              delete draftContents[key]
              return { draftContents }
            }
            if (s.draftContents[key] === content) return s
            return { draftContents: { ...s.draftContents, [key]: content } }
          })
        },

        clearDraft: (projectId, path) => {
          const key = `${projectId}::${path}`
          set((s) => {
            if (!(key in s.draftContents)) return s
            const draftContents = { ...s.draftContents }
            delete draftContents[key]
            return { draftContents }
          })
        },

        refreshProject: async (projectId) => {
          const { treesByProject, showHidden } = get()
          const projectPrefix = `${projectId}/`
          // Корень + все уже загруженные (в т.ч. раскрытые) каталоги проекта.
          const loadedDirs: string[] = []
          if (treesByProject[projectId]) loadedDirs.push('')
          for (const key of Object.keys(treesByProject)) {
            if (key.startsWith(projectPrefix)) loadedDirs.push(key.slice(projectPrefix.length))
          }

          await Promise.all(loadedDirs.map(async (dir) => {
            const key = dir ? `${projectId}/${dir}` : projectId
            try {
              const result = await synthApi.listDirectory(projectId, dir, showHidden)
              set((s) => ({
                treesByProject: {
                  ...s.treesByProject,
                  [key]: result.entries,
                },
              }))
            } catch {
              // Каталог мог исчезнуть (смена workspace/удаление) — убираем только
              // его ключ, не ломая остальные.
              set((s) => {
                if (!(key in s.treesByProject)) return s
                const trees = { ...s.treesByProject }
                delete trees[key]
                return { treesByProject: trees }
              })
            }
          }))

          // Инвалидация открытых редакторов: даже без загруженного дерева
          // (файл, открытый напрямую) ревизия должна вырасти.
          set((s) => ({
            revisionByProject: {
              ...s.revisionByProject,
              [projectId]: (s.revisionByProject[projectId] ?? 0) + 1,
            },
          }))
        },

        refreshDirs: async (projectId, dirs) => {
          const { treesByProject, showHidden } = get()
          const unique = [...new Set(dirs)]
          await Promise.all(unique.map(async (dir) => {
            const key = dir ? `${projectId}/${dir}` : projectId
            // Только уже загруженные каталоги: незагруженный UI не показывает,
            // новые ключи не создаём.
            if (!treesByProject[key]) return
            try {
              const result = await synthApi.listDirectory(projectId, dir, showHidden)
              set((s) => ({
                treesByProject: { ...s.treesByProject, [key]: result.entries },
              }))
            } catch {
              // Каталог мог исчезнуть — убираем только его ключ.
              set((s) => {
                if (!(key in s.treesByProject)) return s
                const trees = { ...s.treesByProject }
                delete trees[key]
                return { treesByProject: trees }
              })
            }
          }))
        },

        clearDeletedFile: (projectId, path) => {
          const key = `${projectId}::${path}`
          set((s) => {
            if (!(key in s.deletedFiles)) return s
            const deletedFiles = { ...s.deletedFiles }
            delete deletedFiles[key]
            return { deletedFiles }
          })
        },

        markDeletedFile: (projectId, path) => {
          const key = `${projectId}::${path}`
          set((s) => {
            if (s.deletedFiles[key]) return s
            return { deletedFiles: { ...s.deletedFiles, [key]: true } }
          })
        },

        scheduleRefresh: (projectId, change) => {
          const acc = pendingChanges.get(projectId)
            ?? { all: false, workspaceChanged: false, ops: new Map() }
          if (change.scope === 'all' || change.workspaceChanged) acc.all = true
          if (change.workspaceChanged) acc.workspaceChanged = true
          // `op:'move'` несёт from/to; дублируем их в paths, чтобы refreshDirs
          // перечитал родителей источника и назначения, даже если paths не задан.
          const paths = change.paths ? [...change.paths] : []
          if (change.from && !paths.includes(change.from)) paths.push(change.from)
          if (change.to && !paths.includes(change.to)) paths.push(change.to)
          for (const path of paths) {
            // «Последний wins» за окно: записан → удалён даёт delete и наоборот.
            acc.ops.set(path, change.op)
          }
          pendingChanges.set(projectId, acc)

          const existing = refreshTimers.get(projectId)
          if (existing) clearTimeout(existing)
          refreshTimers.set(projectId, setTimeout(() => {
            refreshTimers.delete(projectId)
            const pending = pendingChanges.get(projectId)
            pendingChanges.delete(projectId)
            if (!pending) return
            void applyFsChange(projectId, pending)
          }, FS_REFRESH_DEBOUNCE_MS))
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
