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
  /**
   * Удалённая сторона деградировала по факту ответа списка (`remote_offline`):
   * сервер мог ответить «локальным миром», хотя статус гибрида ещё не обновился.
   * Сбрасывается успешным `loadStatus` с `connected === true`.
   */
  remoteDegraded: boolean
  /** Timestamp последней успешной/попытки проверки статуса (для кеша loadStatus). */
  lastCheckedAt: number | null

  loadStatus: () => Promise<void>
  /** Отметить/снять offline-деградацию удалённой стороны (из списков). */
  markRemoteDegraded: (value: boolean) => void
  startPolling: (intervalMs?: number) => void
  stopPolling: () => void
}

/** Гибрид включён, но backend недоступен — удалённые сущности неактивны. */
export const selectIsOffline = (
  s: Pick<HybridStore, 'enabled' | 'connected'> & { remoteDegraded?: boolean },
): boolean => (s.enabled && !s.connected) || s.remoteDegraded === true

let pollTimer: ReturnType<typeof setInterval> | null = null

/** Кеш статуса: повторный loadStatus в пределах окна не делает запрос (не плодить трафик). */
const STATUS_CACHE_MS = 5_000

export const useHybridStore = create<HybridStore>((set, get) => ({
  enabled: false,
  connected: false,
  backendUrl: null,
  user: null,
  loading: false,
  remoteDegraded: false,
  lastCheckedAt: null,

  // GET /api/v2/hybrid/status (без auth). Ошибка → гибрид выключен (сброс).
  loadStatus: async () => {
    const { lastCheckedAt } = get()
    const now = Date.now()
    // Свежий кеш (< 5с) — не ходим на сервер (клик по индикатору, повторный
    // mount баннера и т.п.). Поллинг 30с всегда проходит окно и делает запрос.
    if (lastCheckedAt !== null && now - lastCheckedAt < STATUS_CACHE_MS) {
      return
    }
    set({ loading: true, lastCheckedAt: now })
    try {
      const status: HybridStatus = await synthApi.getHybridStatus()
      set({
        enabled: status.enabled,
        connected: status.connected,
        backendUrl: status.backendUrl ?? null,
        user: status.user ?? null,
        loading: false,
        // Успешный статус с живым подключением снимает деградацию, отмеченную
        // списками (`remote_offline`): причина исчезла.
        ...(status.connected ? { remoteDegraded: false } : {}),
      })
    } catch {
      // Эндпоинт недоступен (сервер без hybrid-роута) — считаем, что гибрид выключен.
      set({ enabled: false, connected: false, backendUrl: null, user: null, loading: false })
    }
  },

  markRemoteDegraded: (value: boolean) => {
    if (get().remoteDegraded === value) return
    set({ remoteDegraded: value })
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
