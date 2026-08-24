import { create } from 'zustand'

export const PERMISSION_ASK_TIMEOUT_MS = 30_000

export interface PermissionRequest {
  approvalId: string
  toolName: string
  params: Record<string, unknown>
  reason: string
  askedAt: string
  timeoutMs: number
  /** true — пользователь нажал «Остановить таймер»: UI-таймер снят, запрос живёт до ответа. */
  held?: boolean
}

interface PermissionStore {
  /** Очередь запросов подтверждения по сессиям. Первый элемент — текущий запрос. */
  requestsBySession: Record<string, PermissionRequest[]>

  addRequest: (sessionId: string, req: PermissionRequest) => void
  removeRequest: (sessionId: string, approvalId: string) => void
  clearSession: (sessionId: string) => void
  /** «Остановить таймер»: снять UI-таймер для approvalId и пометить запрос как held. */
  holdRequest: (sessionId: string, approvalId: string) => void
}

/** Таймеры истечения по approval_id (вне состояния, чтобы не вызывать ре-рендеры). */
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearExpiryTimer(approvalId: string): void {
  const timer = expiryTimers.get(approvalId)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(approvalId)
  }
}

export const usePermissionStore = create<PermissionStore>()((set, get) => ({
  requestsBySession: {},

  addRequest: (sessionId, req) => {
    clearExpiryTimer(req.approvalId)

    const requests = [...(get().requestsBySession[sessionId] || [])]
    if (requests.some((r) => r.approvalId === req.approvalId)) return

    requests.push(req)
    set((s) => ({
      requestsBySession: { ...s.requestsBySession, [sessionId]: requests },
    }))

    // Таймаут ask: если пользователь не ответил — запрос убирается из полосы.
    // Backend самостоятельно сбросит ask по таймауту (approved:false).
    // timeoutMs <= 0 → «без таймаута»: таймер не ставим, запрос живёт до ответа.
    if (req.timeoutMs > 0) {
      expiryTimers.set(req.approvalId, setTimeout(() => {
        get().removeRequest(sessionId, req.approvalId)
      }, req.timeoutMs))
    }
  },

  removeRequest: (sessionId, approvalId) => {
    clearExpiryTimer(approvalId)

    const requests = get().requestsBySession[sessionId]
    if (!requests) return

    const next = requests.filter((r) => r.approvalId !== approvalId)
    if (next.length === 0) {
      set((s) => {
        const requestsBySession = { ...s.requestsBySession }
        delete requestsBySession[sessionId]
        return { requestsBySession }
      })
    } else {
      set((s) => ({
        requestsBySession: { ...s.requestsBySession, [sessionId]: next },
      }))
    }
  },

  clearSession: (sessionId) => {
    const requests = get().requestsBySession[sessionId] || []
    for (const r of requests) {
      clearExpiryTimer(r.approvalId)
    }
    set((s) => {
      const requestsBySession = { ...s.requestsBySession }
      delete requestsBySession[sessionId]
      return { requestsBySession }
    })
  },

  holdRequest: (sessionId, approvalId) => {
    clearExpiryTimer(approvalId)
    const requests = get().requestsBySession[sessionId]
    if (!requests) return
    const next = requests.map((r) =>
      r.approvalId === approvalId ? { ...r, held: true } : r,
    )
    set((s) => ({
      requestsBySession: { ...s.requestsBySession, [sessionId]: next },
    }))
  },
}))
