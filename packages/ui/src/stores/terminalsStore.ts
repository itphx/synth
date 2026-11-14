/**
 * Стор терминалов (PROP-132, Ф3б).
 *
 * Реестр живых терминалов + точечные операции. **Потока вывода в сторе нет**:
 * вывод — волатильный класс, он приходит отдельным HTTP-потоком NDJSON
 * (`GET /api/v2/terminals/:id/stream`, `lib/api/terminals.ts`), а по шине
 * приходят только метаданные терминала
 * (`terminal.created|updated|exited|deleted`).
 *
 * Источник истины — сервер: `GET /api/v2/terminals` (страница) + live-события.
 */

import { create } from 'zustand'
import {
  terminalsApi,
  toTerminalDto,
  toTerminalPatch,
  type CreateTerminalInput,
  type TerminalDto,
  type TerminalListOptions,
  type TerminalPatch,
} from '@/lib/api/terminals'

export interface TerminalsState {
  /** Терминалы по id. */
  terminalsById: Record<string, TerminalDto>
  /** Порядок отображения (свежие сверху). */
  order: string[]
  /**
   * id терминалов по ключу выборки (`project:<id>`/`session:<id>`/`all`).
   *
   * Реестр общий для всех потребителей (панель «Процессы», плавающая кнопка,
   * шапка сессии), поэтому выборка **сливается** с реестром, а не заменяет его:
   * чужой срез (терминалы другого проекта/сессии) терять нельзя. По этому же
   * ключу вычищаются только те записи, которые пришли из **этой** выборки и
   * больше сервер не отдаёт.
   */
  queryIds: Record<string, string[]>
  /** Идёт ли загрузка реестра. */
  loading: boolean
  /** Последняя ошибка чтения/мутации. */
  error: string | null

  /** Перечитать реестр терминалов. */
  load: (options?: TerminalListOptions) => Promise<void>
  /** Создать терминал (вернёт DTO или `null` при ошибке). */
  create: (input: CreateTerminalInput) => Promise<TerminalDto | null>
  /** Закрыть терминал (сервер убивает PTY). */
  close: (id: string) => Promise<void>
  /** Отправить ввод пользователя. */
  sendInput: (id: string, data: string) => Promise<void>
  /** Сообщить серверу новую геометрию терминала. */
  resize: (id: string, cols: number, rows: number) => Promise<void>
  /** Точечная правка (переименование / привязка к сессии). */
  patch: (id: string, patch: TerminalPatch) => Promise<void>
  /** Применить live-событие `terminal.*` (только метаданные). */
  applyEvent: (type: string, payload: Record<string, unknown>) => void
  /** Очистить реестр (смена пользователя/инстанса). */
  clear: () => void
}

/**
 * Порядок терминалов: свежие сверху, по `lastActivityAt`.
 *
 * Сортируются **все** записи реестра (выборки сливаются), а не только строки
 * последнего ответа.
 */
function sortOrder(byId: Record<string, TerminalDto>): string[] {
  return Object.keys(byId)
    .sort((a, b) => {
      const left = byId[a]?.lastActivityAt ?? 0
      const right = byId[b]?.lastActivityAt ?? 0
      if (left === right) return a < b ? 1 : -1
      return left < right ? 1 : -1
    })
}

/** Ключ выборки списка терминалов (по проекту / по сессии / по всему). */
function queryKey(options?: TerminalListOptions): string {
  if (options?.sessionId) return `session:${options.sessionId}`
  if (options?.projectId) return `project:${options.projectId}`
  return 'all'
}

/** id терминала из payload события (`terminal_id`). */
function eventTerminalId(payload: Record<string, unknown>): string {
  const value = payload['terminal_id'] ?? payload['terminalId'] ?? payload['id']
  return typeof value === 'string' ? value : ''
}

export const useTerminalsStore = create<TerminalsState>()((set, get) => ({
  terminalsById: {},
  order: [],
  queryIds: {},
  loading: false,
  error: null,

  load: async (options) => {
    set({ loading: true, error: null })
    try {
      const page = await terminalsApi.list(options)
      const key = queryKey(options)
      set((state) => {
        const terminalsById = { ...state.terminalsById }
        const fetched = new Set<string>()
        for (const terminal of page.terminals) {
          terminalsById[terminal.id] = terminal
          fetched.add(terminal.id)
        }
        // Вычищаем только записи **этой** выборки: чужой срез (другой проект
        // или другая сессия) не трогаем — он ещё нужен другому потребителю.
        for (const id of state.queryIds[key] ?? []) {
          if (!fetched.has(id)) delete terminalsById[id]
        }
        return {
          terminalsById,
          order: sortOrder(terminalsById),
          queryIds: { ...state.queryIds, [key]: [...fetched] },
          loading: false,
        }
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  create: async (input) => {
    set({ error: null })
    try {
      const terminal = await terminalsApi.create(input)
      set((state) => {
        const terminalsById = { ...state.terminalsById, [terminal.id]: terminal }
        const order = [terminal.id, ...state.order.filter((id) => id !== terminal.id)]
        return { terminalsById, order }
      })
      return terminal
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  close: async (id) => {
    set({ error: null })
    try {
      await terminalsApi.close(id)
      get().applyEvent('terminal.deleted', { terminal_id: id })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  sendInput: async (id, data) => {
    try {
      await terminalsApi.input(id, data)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  resize: async (id, cols, rows) => {
    try {
      await terminalsApi.resize(id, cols, rows)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  patch: async (id, patch) => {
    set({ error: null })
    try {
      const terminal = await terminalsApi.update(id, patch)
      set((state) => ({
        terminalsById: { ...state.terminalsById, [terminal.id]: terminal },
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  applyEvent: (type, payload) => {
    // Потока вывода по шине нет (сервер его не публикует) — в сторе только
    // метаданные терминала.
    if (type === 'terminal.deleted') {
      const terminalId = eventTerminalId(payload)
      if (!terminalId) return
      set((state) => {
        const terminalsById = { ...state.terminalsById }
        delete terminalsById[terminalId]
        return {
          terminalsById,
          order: state.order.filter((id) => id !== terminalId),
        }
      })
      return
    }

    if (type === 'terminal.exited') {
      const terminalId = eventTerminalId(payload)
      if (!terminalId) return
      const patch = toTerminalPatch(payload)
      set((state) => {
        const existing = state.terminalsById[terminalId]
        if (!existing) return state
        return {
          terminalsById: {
            ...state.terminalsById,
            [terminalId]: { ...existing, ...patch, id: terminalId, status: 'exited' },
          },
        }
      })
      return
    }

    if (type === 'terminal.created' || type === 'terminal.updated') {
      // Payload события плоский и несёт только изменившиеся поля — это патч.
      // Обёртка `{ terminal }` тоже принимается (как у HTTP-ответа).
      const source = (payload['terminal'] ?? payload) as Record<string, unknown>
      const patch = toTerminalPatch(source)
      const terminalId = patch.id ?? eventTerminalId(payload)
      if (!terminalId) return
      set((state) => {
        const existing = state.terminalsById[terminalId]
        const merged: TerminalDto = existing
          ? { ...existing, ...patch, id: terminalId }
          : { ...toTerminalDto(undefined), ...patch, id: terminalId }
        const terminalsById = { ...state.terminalsById, [terminalId]: merged }
        const order = state.order.includes(terminalId)
          ? state.order
          : [terminalId, ...state.order]
        return { terminalsById, order }
      })
    }
  },

  clear: () => {
    set({ terminalsById: {}, order: [], queryIds: {}, error: null })
  },
}))

/** Селектор: терминал по id. */
export function selectTerminal(state: TerminalsState, terminalId: string): TerminalDto | undefined {
  return state.terminalsById[terminalId]
}

/** Селектор: упорядоченный список терминалов. */
export function selectTerminalList(state: TerminalsState): TerminalDto[] {
  const result: TerminalDto[] = []
  for (const id of state.order) {
    const terminal = state.terminalsById[id]
    if (terminal) result.push(terminal)
  }
  return result
}

/** Селектор: терминалы проекта. */
export function selectProjectTerminals(
  state: TerminalsState,
  projectId: string | undefined,
): TerminalDto[] {
  return selectTerminalList(state).filter((terminal) =>
    projectId ? terminal.projectId === projectId : true,
  )
}

/**
 * Живые терминалы сессии (привязанные к ней и ещё не завершённые).
 *
 * «Живой» = статус не `exited`: завершённый терминал вкладку держит, но
 * плавающую кнопку и переход «терминал → сессия» показывать не о чем.
 */
export function selectLiveTerminalsForSession(
  state: TerminalsState,
  sessionId: string | undefined,
): TerminalDto[] {
  if (!sessionId) return []
  return selectTerminalList(state).filter(
    (terminal) => terminal.sessionId === sessionId && terminal.status !== 'exited',
  )
}

/** Селектор: первый живой терминал сессии (свежий сверху). */
export function selectLiveTerminalForSession(
  state: TerminalsState,
  sessionId: string | undefined,
): TerminalDto | undefined {
  return selectLiveTerminalsForSession(state, sessionId)[0]
}
