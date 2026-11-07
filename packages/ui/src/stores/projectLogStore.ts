// projectLogStore: страница журнала проекта (PROP-054).
//
// Журнал **вынесен из детали проекта** (`GET /projects/:id` больше не несёт
// `log`): единственный источник — постраничный `GET /projects/:id/log`
// (событие `project.updated` с `kind: 'log'`). Стор держит страницу по
// проектам — журнал — ресурс проекта, а не одной сессии.
//
// Live-обновление — событие `project.updated { project_id, kind: 'log' }`:
// это сигнал «перечитай страницу», поэтому обработчик просто запрашивает
// первую страницу заново. Модальное окно (`WorkModal`) читает тот же стор,
// поэтому открытое окно журнала обновляется по событию.
//
// Записи журнала создаёт модель (`project_log_write`) и пользователь;
// авто-ленты событий в этом инкременте нет.

import { create } from 'zustand'

import { synthApi, type ProjectLogEntryDto } from '@/lib/api/synthApi'

/** Размер страницы журнала (сервер по умолчанию — 50, максимум 200). */
export const PROJECT_LOG_PAGE_LIMIT = 50

/** Состояние страницы журнала одного проекта. */
export interface ProjectLogPageState {
  /** Записи текущей страницы (новые сверху). */
  entries: ProjectLogEntryDto[]
  /** Всего записей (счётчик в шапке). */
  total: number
  /** Смещение текущей страницы. */
  offset: number
  /** Размер страницы. */
  limit: number
  /** Курсор следующей страницы; `null` — страница последняя. */
  nextOffset: number | null
  /** Идёт загрузка первой страницы. */
  loading: boolean
  /** Идёт догрузка следующей страницы. */
  loadingMore: boolean
  /** Текст ошибки последней операции. */
  error: string | null
}

/** Payload события `project.updated` (PROP-054). */
export interface ProjectUpdatedEvent {
  /** Проект-владелец журнала. */
  project_id?: string
  /** Что изменилось: `log` | `invariants`. */
  kind?: string
}

interface ProjectLogState {
  /** Страницы журнала по проектам. */
  byProject: Record<string, ProjectLogPageState>
  /** Перечитать первую страницу журнала. */
  refresh: (projectId: string) => Promise<void>
  /** Догрузить следующую страницу журнала. */
  loadMore: (projectId: string) => Promise<void>
  /** Обработать live-событие шины (`project.updated`). */
  applyEvent: (type: string, payload: ProjectUpdatedEvent) => void
  /** Страница журнала проекта (пустая — если проекта нет в сторе). */
  page: (projectId: string) => ProjectLogPageState | undefined
}

/** Пустая страница журнала — для проекта, который ещё не грузили. */
function emptyPage(): ProjectLogPageState {
  return {
    entries: [],
    total: 0,
    offset: 0,
    limit: PROJECT_LOG_PAGE_LIMIT,
    nextOffset: null,
    loading: false,
    loadingMore: false,
    error: null,
  }
}

export const useProjectLogStore = create<ProjectLogState>()((set, get) => ({
  byProject: {},

  refresh: async (projectId) => {
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...(s.byProject[projectId] ?? emptyPage()), loading: true, error: null },
      },
    }))
    try {
      const page = await synthApi.getProjectLogPage(projectId, {
        limit: PROJECT_LOG_PAGE_LIMIT,
        offset: 0,
      })
      const entries = page.entries ?? []
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: {
            entries,
            total: page.total ?? entries.length,
            offset: 0,
            limit: page.limit ?? PROJECT_LOG_PAGE_LIMIT,
            nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
            loading: false,
            loadingMore: false,
            error: null,
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: {
            ...(s.byProject[projectId] ?? emptyPage()),
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      }))
    }
  },

  loadMore: async (projectId) => {
    const current = get().byProject[projectId]
    if (!current || current.loading || current.loadingMore) return
    const offset = current.entries.length
    if (current.nextOffset === null) return
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...current, loadingMore: true, error: null },
      },
    }))
    try {
      const page = await synthApi.getProjectLogPage(projectId, {
        limit: current.limit || PROJECT_LOG_PAGE_LIMIT,
        offset,
      })
      const incoming = page.entries ?? []
      set((s) => {
        const state = s.byProject[projectId] ?? emptyPage()
        const seen = new Set(state.entries.map((e) => e.id))
        const merged = [...state.entries, ...incoming.filter((e) => !seen.has(e.id))]
        return {
          byProject: {
            ...s.byProject,
            [projectId]: {
              ...state,
              entries: merged,
              total: page.total ?? state.total,
              nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
              loadingMore: false,
            },
          },
        }
      })
    } catch (err) {
      set((s) => ({
        byProject: {
          ...s.byProject,
          [projectId]: {
            ...(s.byProject[projectId] ?? emptyPage()),
            loadingMore: false,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      }))
    }
  },

  applyEvent: (type, payload) => {
    if (type !== 'project.updated') return
    if (payload.kind !== 'log') return
    const projectId = payload.project_id
    if (!projectId) return
    // Журнал изменился — перечитываем первую страницу (событие — сигнал).
    void get().refresh(projectId)
  },

  page: (projectId) => get().byProject[projectId],
}))
