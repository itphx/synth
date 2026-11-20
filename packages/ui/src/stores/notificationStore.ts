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
  /**
   * Требует действия человека (аддитивно, для фильтров истории).
   *
   * Тем же флагом управляется непрочитанное: `unread ⇒ требует действия`
   * (`hooks/useNotification.tsx`), поэтому «просто тост» (фоновый прогон
   * завершён, успешная операция) сессию в дереве больше не красит.
   */
  requiresAction?: boolean
  timestamp: number
  dismissed: boolean
  readAt: number
}

export interface NotifyOptions {
  text: string
  type: StatusType
  category: NotifyCategory
  sessionId?: string
  /**
   * Уведомление требует действия человека (ответ на вопрос агента, подтверждение
   * прав, продолжение остановленной очереди).
   *
   * Только при `true` инкрементится непрочитанное сессии (оранжевый цвет
   * названия в дереве = «требуется действие пользователя»). По умолчанию
   * `false`: тост и запись истории остаются, счётчик и цвет не трогаются.
   */
  requiresAction?: boolean
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

/**
 * Окно дедупликации тостов «требуется действие» на одну сессию.
 *
 * Ядро публикует пачку `permission.asked` (параллельные тулы одного шага) и
 * пачку повторов — без окна экран заливало бы десятком одинаковых тостов.
 */
export const ACTION_TOAST_DEDUP_MS = 10_000

/**
 * Время последнего тоста «требуется действие» по сессии (модульное состояние).
 *
 * Держим **вне** стора: значение не влияет на рендер и не должно попадать в
 * persist. Сброс не нужен — метка живёт только до истечения окна.
 */
const lastActionToastAt = new Map<string, number>()

/**
 * Забрать право на тост «требуется действие» для сессии.
 *
 * `true` — тост показывать (первый раз или окно истекло), `false` — подавить.
 */
export function claimActionToast(sessionId: string, now: number = Date.now()): boolean {
  const last = lastActionToastAt.get(sessionId)
  if (last !== undefined && now - last < ACTION_TOAST_DEDUP_MS) return false
  lastActionToastAt.set(sessionId, now)
  return true
}

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
  /**
   * Подавление непрочитанного счётчика сессии.
   *
   * Сессия в «подавленном» состоянии не накапливает непрочитанные: пока док
   * «Спросить агента» открыт, ответ агента не должен подсвечивать сессию
   * оранжевым в дереве (человек и так видит док). Набор — runtime (не
   * персистится).
   */
  suppressedUnread: Record<string, boolean>
  suppressUnread: (sessionId: string, suppressed: boolean) => void
  isUnreadSuppressed: (sessionId: string) => boolean

  /**
   * Сессии, о висящем ожидании которых человек уже уведомлён сводным тостом
   * (второй путь доставки: страница была закрыта, событие `permission.asked`
   * клиент не увидел). Метка снимается, когда ожидание исчезло
   * (`pending_approvals` → 0, `queue_stopped` → false), иначе следующее
   * ожидание не дало бы тоста. Runtime (не персистится).
   */
  actionNotified: Record<string, boolean>
  markActionNotified: (sessionId: string) => void
  clearActionNotified: (sessionId: string) => void
  isActionNotified: (sessionId: string) => boolean

  /**
   * Локальная метка «просмотрено» по сессиям (ms, `Date.now()`).
   *
   * Вход модели `sessionBadgeState` (`lib/sessionBadgeState.ts`): исход
   * последнего хода **старше** метки — человек его уже видел, красить название
   * сессии (ошибка/завершение) незачем.
   *
   * Метка локальная и per-browser: сервер о ней не знает и не должен —
   * «прочитанность» это свойство текущего просмотра, а не данные сессии
   * (ADR-118 §1: цвет названия — клиентское состояние).
   *
   * **Не персистится** (`partialize` ниже сохраняет только `prefs`): после
   * перезагрузки страницы метка пропадает, и непросмотренный исход может
   * подсветиться повторно. Это осознанный компромисс — `Date.now()` клиента
   * расходится с серверным `last_turn.at` (часы, часовые пояса), и «залипшая»
   * метка из localStorage навсегда скрыла бы новую ошибку.
   */
  ackedAtBySession: Record<string, number>
  /**
   * Отметить сессию просмотренной (`at` — для тестов; по умолчанию `Date.now()`).
   *
   * Метка только растёт: повторный вызов с меньшим/равным временем состояние не
   * меняет (`return state` — без лишнего рендера подписчиков).
   */
  markSessionAcked: (sessionId: string, at?: number) => void
  /** Метка «просмотрено» сессии (`undefined` — не просмотрена). */
  getAckedAt: (sessionId: string) => number | undefined
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
            requiresAction: opts.requiresAction === true,
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
        set((state) => {
          // Подавленная сессия не накапливает непрочитанные (док «Спросить
          // агента»): гейт стоит здесь, в единственной точке инкремента, —
          // иначе счётчик подрос бы из другого места.
          if (state.suppressedUnread[sessionId]) return state
          return {
            sessionUnread: {
              ...state.sessionUnread,
              [sessionId]: (state.sessionUnread[sessionId] || 0) + 1,
            },
          }
        }),
      clearSessionUnread: (sessionId) =>
        set((state) => {
          const next = { ...state.sessionUnread }
          delete next[sessionId]
          return { sessionUnread: next }
        }),

      suppressedUnread: {},
      suppressUnread: (sessionId, suppressed) =>
        set((state) => {
          const next = { ...state.suppressedUnread }
          if (suppressed) next[sessionId] = true
          else delete next[sessionId]
          return { suppressedUnread: next }
        }),
      isUnreadSuppressed: (sessionId) => get().suppressedUnread[sessionId] === true,

      actionNotified: {},
      markActionNotified: (sessionId) =>
        set((state) => ({
          actionNotified: { ...state.actionNotified, [sessionId]: true },
        })),
      clearActionNotified: (sessionId) =>
        set((state) => {
          if (!state.actionNotified[sessionId]) return state
          const next = { ...state.actionNotified }
          delete next[sessionId]
          return { actionNotified: next }
        }),
      isActionNotified: (sessionId) => get().actionNotified[sessionId] === true,

      ackedAtBySession: {},
      markSessionAcked: (sessionId, at = Date.now()) =>
        set((state) => {
          const current = state.ackedAtBySession[sessionId]
          // Метка только растёт: «просмотрено раньше» не откатывает «просмотрено
          // позже» (иначе повторное открытие старой вкладки «раскрашивало» бы
          // уже прочитанный исход).
          if (current !== undefined && current >= at) return state
          return { ackedAtBySession: { ...state.ackedAtBySession, [sessionId]: at } }
        }),
      getAckedAt: (sessionId) => get().ackedAtBySession[sessionId],
    }),
    {
      name: 'synth-ui-notifications',
      // Персистим только пользовательские предпочтения категорий. Метки
      // «просмотрено» (`ackedAtBySession`) намеренно остаются runtime — см.
      // комментарий к полю: клиентские часы расходятся с серверным
      // `last_turn.at`, и сохранённая метка скрыла бы новую ошибку навсегда.
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
