import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StatusType } from './useUIStore'

export type NotifyCategory = 'connection' | 'streaming' | 'queue' | 'message' | 'error' | 'system'

export interface NotificationItem {
  id: string
  text: string
  type: StatusType
  category: NotifyCategory
  sessionId?: string
  timestamp: number
  dismissed: boolean
  readAt: number
}

export interface NotifyOptions {
  text: string
  type: StatusType
  category: NotifyCategory
  sessionId?: string
}

interface NotificationPrefs {
  enabledCategories: Record<NotifyCategory, boolean>
}

const MAX_HISTORY = 50
/** Дефолтная доступность категорий — используется как `defaultValue` черновика настроек. */
export const DEFAULT_ENABLED: Record<NotifyCategory, boolean> = {
  connection: true,
  streaming: false,
  queue: true,
  message: false,
  error: true,
  system: true,
}

let msgCounter = 0

interface NotificationStore {
  history: NotificationItem[]
  addToHistory: (opts: NotifyOptions) => void
  dismiss: (id: string) => void
  dismissAll: () => void
  markRead: (id: string) => void
  markAllRead: () => void

  prefs: NotificationPrefs
  setCategoryEnabled: (category: NotifyCategory, enabled: boolean) => void
  /** Атомарно заменить весь набор категорий (persist через middleware). */
  setAllCategories: (enabledCategories: Record<NotifyCategory, boolean>) => void
  isCategoryEnabled: (category: NotifyCategory) => boolean

  sessionUnread: Record<string, number>
  incSessionUnread: (sessionId: string) => void
  clearSessionUnread: (sessionId: string) => void
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set, get) => ({
      history: [],
      addToHistory: (opts) =>
        set((state) => {
          msgCounter += 1
          const item: NotificationItem = {
            id: `n-${msgCounter}-${Date.now()}`,
            text: opts.text,
            type: opts.type,
            category: opts.category,
            sessionId: opts.sessionId,
            timestamp: Date.now(),
            dismissed: false,
            readAt: 0,
          }
          const next = [item, ...state.history].slice(0, MAX_HISTORY)
          return { history: next }
        }),
      dismiss: (id) =>
        set((state) => ({
          history: state.history.map((item) =>
            item.id === id ? { ...item, dismissed: true } : item
          ),
        })),
      dismissAll: () => set({ history: [] }),
      markRead: (id) =>
        set((state) => ({
          history: state.history.map((item) =>
            item.id === id && item.readAt === 0 ? { ...item, readAt: Date.now() } : item
          ),
        })),
      markAllRead: () =>
        set((state) => ({
          history: state.history.map((item) =>
            !item.dismissed && item.readAt === 0 ? { ...item, readAt: Date.now() } : item
          ),
          sessionUnread: {},
        })),

      prefs: { enabledCategories: { ...DEFAULT_ENABLED } },
      setCategoryEnabled: (category, enabled) =>
        set((state) => ({
          prefs: {
            ...state.prefs,
            enabledCategories: {
              ...state.prefs.enabledCategories,
              [category]: enabled,
            },
          },
        })),
      setAllCategories: (enabledCategories) =>
        set((state) => ({
          prefs: {
            ...state.prefs,
            enabledCategories: { ...enabledCategories },
          },
        })),
      isCategoryEnabled: (category) =>
        get().prefs.enabledCategories[category] ?? DEFAULT_ENABLED[category],

      sessionUnread: {},
      incSessionUnread: (sessionId) =>
        set((state) => ({
          sessionUnread: {
            ...state.sessionUnread,
            [sessionId]: (state.sessionUnread[sessionId] || 0) + 1,
          },
        })),
      clearSessionUnread: (sessionId) =>
        set((state) => {
          const next = { ...state.sessionUnread }
          delete next[sessionId]
          return { sessionUnread: next }
        }),
    }),
    {
      name: 'synth-ui-notifications',
      partialize: (state) => ({
        prefs: state.prefs,
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        return {
          ...current,
          prefs: (p?.prefs as NotificationPrefs) ?? current.prefs,
        }
      },
    }
  )
)
