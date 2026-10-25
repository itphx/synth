// processesStore: единый реестр фоновых прогонов (PROP-096/097).
//
// Реестр обслуживает два вида фоновой работы:
//   - `process`  — фоновая шелл-команда;
//   - `subagent` — фоновая дочерняя сессия саб-агента.
//
// Записи персистентны на сервере (порт `BackgroundRunRepository`, ADR-096):
// список восстанавливается по `GET /api/v2/processes`, а live-обновление
// приходит событиями `process.*`/`child.*` (диспетчер
// `stores/transportStore.ts`).
//
// Порядок записей — свежие первыми (по `startedAt` убывающе).

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type {
  BackgroundRunRecord,
  BackgroundRunStatus,
  ProcessesListOptions,
} from '@/lib/api/synthApi'

/** Накопленный лог фонового процесса. */
export interface ProcessLogState {
  /** Накопленный текст лога. */
  content: string
  /** Смещение (байты) следующего запрошенного отрезка. */
  offset: number
  /** Полный размер лога, байт (0 — неизвестно). */
  totalBytes: number
  /** Лог обрезан по лимиту записи (хвост потерян). */
  truncated: boolean
}

/** Отрезок лога, приходящий из API (или из стора при слиянии). */
export interface ProcessLogChunk {
  /** Текст отрезка. */
  content: string
  /** Смещение, с которого начат отрезок. */
  offset: number
  /** Смещение следующего отрезка (конец текущего). */
  nextOffset?: number
  /** Полный размер лога, байт. */
  totalBytes?: number
  /** Лог обрезан по лимиту записи. */
  truncated?: boolean
}

interface ProcessesState {
  /** Записи реестра по id. */
  byId: Record<string, BackgroundRunRecord>
  /** id записей в порядке «свежие первыми» (`startedAt` убыв.). */
  order: string[]
  /** Накопленные логи по id прогона. */
  logs: Record<string, ProcessLogState>
  /** id прогонов, пришедших из live-событий и ещё не подтверждённых списком сервера. */
  pendingIds: string[]
  /** Ошибка загрузки списка (текст). */
  error: string | null

  /** Загрузить реестр и слить его с текущим состоянием. */
  load: (options?: ProcessesListOptions) => Promise<void>
  /** Применить live-событие (`process.*`/`child.*`). */
  applyEvent: (type: string, payload: Record<string, unknown>) => void
  /** Добавить или заменить запись реестра. */
  upsert: (run: BackgroundRunRecord) => void
  /** Убрать запись реестра (и её лог). */
  remove: (id: string) => void
  /** Очистить реестр целиком. */
  clear: () => void
  /** Слить отрезок лога в накопленный текст. */
  mergeLog: (id: string, chunk: ProcessLogChunk) => void
}

/** Момент старта прогона в миллисекундах (0 — дата не разбирается). */
function startedAtMs(run: BackgroundRunRecord | undefined): number {
  const parsed = Date.parse(run?.startedAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Порядок записей: свежие первыми, при равенстве — по id (стабильно). */
function sortOrder(byId: Record<string, BackgroundRunRecord>): string[] {
  return Object.keys(byId).sort((a, b) => {
    const diff = startedAtMs(byId[b]) - startedAtMs(byId[a])
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** Статус прогона из поля `state` события (неизвестное — `running`). */
function statusFromState(state: unknown): BackgroundRunStatus {
  switch (state) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'orphaned':
    case 'running':
      return state
    default:
      return 'running'
  }
}

/** Статус терминального события `child.*` по типу события. */
function statusFromChildEvent(type: string): BackgroundRunStatus {
  if (type === 'child.failed') return 'failed'
  if (type === 'child.cancelled') return 'cancelled'
  return 'completed'
}

/** Читает строковое поле payload. */
function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Читает числовое поле payload. */
function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const useProcessesStore = create<ProcessesState>()((set) => ({
  byId: {},
  order: [],
  logs: {},
  pendingIds: [],
  error: null,

  load: async (options) => {
    try {
      const runs = await synthApi.listProcesses(options)
      set((s) => {
        const byId: Record<string, BackgroundRunRecord> = { ...s.byId }
        const fetched = new Set(runs.map((run) => run.id))
        for (const run of runs) {
          byId[run.id] = { ...byId[run.id], ...run }
        }
        // Записи, которых больше нет в ответе сервера, убираем — кроме тех,
        // что пришли из live-событий и ещё не видны в списке (событие могло
        // прийти раньше ответа сервера).
        for (const id of Object.keys(byId)) {
          if (!fetched.has(id) && !s.pendingIds.includes(id)) delete byId[id]
        }
        return {
          byId,
          order: sortOrder(byId),
          pendingIds: s.pendingIds.filter((id) => !fetched.has(id)),
          error: null,
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  applyEvent: (type, payload) => {
    const backgroundRunId = str(payload, 'background_run_id')
    const isChild = type.startsWith('child.')
    const isProcess = type.startsWith('process.')
    if (!isChild && !isProcess) return

    const sessionId =
      str(payload, 'session_id') ?? str(payload, 'parent_session_id') ?? ''
    const childSessionId = isChild ? str(payload, 'child_session_id') : undefined
    const id = backgroundRunId ?? childSessionId ?? str(payload, 'process_id')
    if (!id) return

    const terminal = type === 'process.exited' || type === 'process.stopped' || isChild
    const status = isChild
      ? statusFromChildEvent(type)
      : terminal
        ? statusFromState(payload.state)
        : 'running'

    set((s) => {
      const prev = s.byId[id]
      const now = new Date().toISOString()
      const patch: Partial<BackgroundRunRecord> = {
        kind: isChild ? 'subagent' : 'process',
        status,
        sessionId: sessionId || prev?.sessionId || '',
        ...(prev?.projectId !== undefined ? { projectId: prev.projectId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        ...(isProcess ? { command: str(payload, 'command') ?? prev?.command } : {}),
        ...(isProcess ? { cwd: str(payload, 'cwd') ?? prev?.cwd } : {}),
        ...(isProcess ? { pid: num(payload, 'pid') ?? prev?.pid } : {}),
        ...(isProcess && str(payload, 'log_path')
          ? { logPath: str(payload, 'log_path') }
          : {}),
        ...(num(payload, 'exit_code') !== undefined
          ? { exitCode: num(payload, 'exit_code') }
          : {}),
        ...(str(payload, 'signal') ? { signal: str(payload, 'signal') } : {}),
        ...(isChild && str(payload, 'description')
          ? { description: str(payload, 'description') }
          : {}),
        startedAt: prev?.startedAt ?? now,
        updatedAt: now,
      }
      if (terminal) patch.finishedAt = now

      const byId = { ...s.byId, [id]: { ...prev, ...patch } as BackgroundRunRecord }
      const pendingIds = s.pendingIds.includes(id)
        ? s.pendingIds
        : [...s.pendingIds, id]
      return { byId, order: sortOrder(byId), pendingIds }
    })
  },

  upsert: (run) => {
    set((s) => {
      const byId = { ...s.byId, [run.id]: { ...s.byId[run.id], ...run } }
      return { byId, order: sortOrder(byId) }
    })
  },

  remove: (id) => {
    set((s) => {
      if (!s.byId[id] && !s.logs[id]) return {}
      const byId = { ...s.byId }
      delete byId[id]
      const logs = { ...s.logs }
      delete logs[id]
      return {
        byId,
        logs,
        order: sortOrder(byId),
        pendingIds: s.pendingIds.filter((pending) => pending !== id),
      }
    })
  },

  clear: () => {
    set({ byId: {}, order: [], logs: {}, pendingIds: [], error: null })
  },

  mergeLog: (id, chunk) => {
    set((s) => {
      const prev = s.logs[id]
      const content = prev?.content ?? ''
      let nextContent: string
      if (chunk.offset === 0) {
        // Отрезок с начала — полная перезагрузка лога.
        nextContent = chunk.content
      } else if (chunk.offset < (prev?.offset ?? 0)) {
        // Отрезок уже получен — не дублируем.
        nextContent = content
      } else {
        nextContent = content + chunk.content
      }
      const nextOffset = Math.max(
        chunk.nextOffset ?? chunk.offset + chunk.content.length,
        prev?.offset ?? 0,
      )
      return {
        logs: {
          ...s.logs,
          [id]: {
            content: nextContent,
            offset: nextOffset,
            totalBytes: chunk.totalBytes ?? prev?.totalBytes ?? nextContent.length,
            truncated: chunk.truncated ?? prev?.truncated ?? false,
          },
        },
      }
    })
  },
}))

/** Сколько фоновых прогонов сейчас выполняется. */
export function runningCount(state: {
  byId: Record<string, BackgroundRunRecord>
}): number {
  return Object.values(state.byId).filter((run) => run.status === 'running').length
}

/** Записи реестра по сессии-владельцу (в порядке реестра — свежие первыми). */
export function bySession(
  state: { byId: Record<string, BackgroundRunRecord>; order: string[] },
  sessionId: string,
): BackgroundRunRecord[] {
  const out: BackgroundRunRecord[] = []
  for (const id of state.order) {
    const run = state.byId[id]
    if (run && run.sessionId === sessionId) out.push(run)
  }
  return out
}
