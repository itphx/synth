import { create } from 'zustand'
import { synthApi } from '@/lib/api/synthApi'
import type { HybridStatus } from '@/lib/api/synthApi'

export interface HybridUser {
  id: string
  username: string
  roles: string[]
}

interface HybridStore {
  enabled: boolean
  connected: boolean
  backendUrl: string | null
  user: HybridUser | null
  loading: boolean

  loadStatus: () => Promise<void>
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export const useHybridStore = create<HybridStore>((set, get) => ({
  enabled: false,
  connected: false,
  backendUrl: null,
  user: null,
  loading: false,

  // GET /api/v2/hybrid/status (без auth). Ошибка → гибрид выключен (сброс).
  loadStatus: async () => {
    set({ loading: true })
    try {
      const status: HybridStatus = await synthApi.getHybridStatus()
      set({
        enabled: status.enabled,
        connected: status.connected,
        backendUrl: status.backendUrl ?? null,
        user: status.user ?? null,
        loading: false,
      })
    } catch {
      // Эндпоинт недоступен (сервер без hybrid-роута) — считаем, что гибрид выключен.
      set({ enabled: false, connected: false, backendUrl: null, user: null, loading: false })
    }
  },

  startPolling: (intervalMs = 30_000) => {
    get().stopPolling()
    void get().loadStatus()
    pollTimer = setInterval(() => {
      void get().loadStatus()
    }, intervalMs)
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  },
}))
