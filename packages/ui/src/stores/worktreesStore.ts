// worktreesStore: инвентарь git-worktree'ов проекта (ADR-114).
//
// Источник истины — сервер (`GET /api/v2/projects/:id/worktrees`, ADR-114 §5):
// записи живут в порте `WorktreeRepository` и переживают рестарт. Список
// хранится по проектам (`byProject`), потому что инвентарь — ресурс проекта,
// а не одной сессии.
//
// Live-обновление — событие `worktree.updated` (`{ project_id, worktree_id?,
// action }`): ядро публикует его в **каналы сессий проекта** (ADR-024/ADR-114
// §6), поэтому подписчики соседних сессий тоже видят изменение. Событие —
// сигнал «перечитай инвентарь», поэтому обработчик просто перезапрашивает
// список проекта. Рядом ядро публикует `fs.changed { scope: 'all' }`: структура
// каталогов изменилась — дерево Files перечитывается (debounce — как у
// соседних сторов).
//
// Привязка сессии к worktree — не часть инвентаря: она хранится в самой
// сессии (`session.worktree`, snake_case-снимок). `bind()` обновляет снимок в
// `sessionsStore`, чтобы шапка сессии и селектор показывали актуальную
// привязку без дополнительного запроса.

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type {
  WorktreeCreateInput,
  WorktreeCreateResult,
  WorktreePruneResult,
  WorktreeSummary,
} from '@/lib/api/synthApi'
import { useFilesStore } from './filesStore'
import { useSessionsStore } from './sessionsStore'

/** Payload события `worktree.updated` (ADR-114 §6). */
export interface WorktreeUpdatedEvent {
  /** Проект-владелец инвентаря. */
  project_id?: string
  /** Id изменившейся записи (нет — для prune/sweep). */
  worktree_id?: string
  /** Характер изменения. */
  action?: string
  /** `fs.changed`: область инвалидации ФС (`file` — точечно, `all` — целиком). */
  scope?: 'file' | 'all'
  /** `fs.changed`: затронутые пути (для точечной инвалидации дерева). */
  paths?: string[]
  /** `fs.changed`: сменился ли рабочий каталог проекта. */
  workspace_changed?: boolean
  /** `fs.changed`: характер изменения ФС. */
  op?: 'write' | 'delete' | 'mkdir' | 'move'
}

interface WorktreesState {
  /** Записи по проектам. */
  byProject: Record<string, WorktreeSummary[]>
  /** Флаг загрузки по проектам. */
  loadingByProject: Record<string, boolean>
  /** Ошибка последней операции (текст). */
  error: string | null

  /** Перечитать инвентарь проекта. */
  refresh: (projectId: string) => Promise<void>
  /** Создать worktree. */
  create: (projectId: string, input?: WorktreeCreateInput) => Promise<WorktreeCreateResult>
  /** Удалить worktree (`force` — снимать вместе с незакоммиченными изменениями). */
  remove: (projectId: string, id: string, opts?: { force?: boolean }) => Promise<void>
  /** Вычистить записи без каталога (`git worktree prune`). */
  prune: (projectId: string) => Promise<WorktreePruneResult>
  /** Привязать сессию к worktree (`null` — снять привязку). */
  bind: (sessionId: string, worktreeId: string | null) => Promise<void>
  /** Обработать live-событие шины (`worktree.updated`/`fs.changed`). */
  applyEvent: (type: string, payload: WorktreeUpdatedEvent) => void
  /** Записи проекта (пустой массив, если проекта нет в сторе). */
  list: (projectId: string) => WorktreeSummary[]
}

export const useWorktreesStore = create<WorktreesState>()((set, get) => ({
  byProject: {},
  loadingByProject: {},
  error: null,

  refresh: async (projectId) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      error: null,
    }))
    try {
      const worktrees = await synthApi.listWorktrees(projectId)
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: worktrees },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
        error: null,
      }))
    } catch (err) {
      set((s) => ({
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  },

  create: async (projectId, input = {}) => {
    const result = await synthApi.createWorktree(projectId, input)
    await get().refresh(projectId)
    return result
  },

  remove: async (projectId, id, opts = {}) => {
    await synthApi.removeWorktree(projectId, id, opts)
    await get().refresh(projectId)
  },

  prune: async (projectId) => {
    const result = await synthApi.pruneWorktrees(projectId)
    await get().refresh(projectId)
    return result
  },

  bind: async (sessionId, worktreeId) => {
    const session = await synthApi.bindWorktree(sessionId, worktreeId)
    // Ответ PATCH — полная сессия: обновляем снимок привязки в сторе сессий.
    useSessionsStore.getState().upsertSession(session)
  },

  applyEvent: (type, payload) => {
    if (type === 'fs.changed') {
      // Каталоги на диске изменились — перечитываем дерево Files (debounce).
      //
      // Область инвалидации пробрасываем из payload: транспорт уже запланировал
      // точечную инвалидацию (`scope:'file'` + пути), и жёсткий `scope:'all'`
      // здесь переводил бы дерево Files на полное перечитывание — редакторы
      // перестали бы видеть изменение файла на диске (ADR-044/ADR-075).
      const projectId = payload.project_id
      if (!projectId) return
      const scope = payload.scope === 'file' ? 'file' : 'all'
      const paths = Array.isArray(payload.paths) ? payload.paths : undefined
      const workspaceChanged = Boolean(payload.workspace_changed)
      const op =
        payload.op === 'write' || payload.op === 'delete' || payload.op === 'mkdir' || payload.op === 'move'
          ? payload.op
          : undefined
      useFilesStore.getState().scheduleRefresh(projectId, { scope, paths, workspaceChanged, op })
      return
    }
    if (type !== 'worktree.updated') return
    const projectId = payload.project_id
    if (!projectId) return
    // Инвентарь изменился — перечитываем список проекта (событие — сигнал).
    void get().refresh(projectId)
  },

  list: (projectId) => get().byProject[projectId] ?? [],
}))

/** Запись worktree по id (в загруженных инвентарях). */
export function findWorktree(
  state: { byProject: Record<string, WorktreeSummary[]> },
  worktreeId: string,
): WorktreeSummary | undefined {
  for (const worktrees of Object.values(state.byProject)) {
    const found = worktrees.find((w) => w.id === worktreeId)
    if (found) return found
  }
  return undefined
}
