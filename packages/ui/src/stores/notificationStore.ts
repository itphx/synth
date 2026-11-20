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

/**
 * Предел числа сессий в карте «просмотрено» (`ackedTurnBySession`).
 *
 * Карта персистится, поэтому не должна расти бесконечно: за месяцы работы в
 * браузере накопились бы тысячи ключей. При переполнении выкидываются самые
 * старые записи по порядку последней записи (активная сессия при каждой
 * отметке переставляется в конец). Вытеснение безвредно: потерянная метка
 * всего лишь вернёт цвет названия — данные не теряются.
 */
export const MAX_ACKED_SESSIONS = 200

/**
 * Обрезать карту «просмотрено» до `MAX_ACKED_SESSIONS` последних записей.
 *
 * Порядок ключей строкового `Record` — порядок вставки (спецификация JS),
 * поэтому «последние» — это хвост `Object.keys`. Порядок не меняем — это
 * делает вызывающая сторона (`markSessionAcked` переставляет ключ в конец).
 */
function trimAcked(map: Record<string, string>): Record<string, string> {
  const keys = Object.keys(map)
  if (keys.length <= MAX_ACKED_SESSIONS) return map
  const next: Record<string, string> = {}
  for (const key of keys.slice(keys.length - MAX_ACKED_SESSIONS)) next[key] = map[key]
  return next
}

/**
 * Оставить в восстановленной карте только непустые строковые значения.
 *
 * `localStorage` — внешние данные (старый формат, ручная правка, другая версия
 * приложения): нестроковое значение сломало бы сравнение ключей, поэтому молча
 * отбрасываем его.
 */
function sanitizeAcked(raw: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== '') next[key] = value
  }
  return next
}

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
   * Локальная метка «просмотрено» по сессиям: ключ **увиденного** исхода
   * последнего хода (`turnKey(session.status.last_turn)` из
   * `lib/sessionBadgeState.ts`, формат `"<outcome>|<at>"`).
   *
   * Вход модели `sessionBadgeState`: ключ совпал с ключом текущего
   * `status.last_turn` — человек этот исход уже видел, красить название сессии
   * (ошибка/завершение) незачем. Новый ход даёт новый `at` → другой ключ → цвет
   * возвращается сам.
   *
   * Почему ключ исхода, а не отметка времени (как было раньше): `Date.now()`
   * клиента расходится с серверным `last_turn.at` (часы, часовые пояса), и
   * сравнение `ackedAt < at` давало ложные «просмотрено»/«не просмотрено».
   * Ключ строится **из серверных данных** и сравнивается на равенство —
   * расхождение часов на него не влияет.
   *
   * Почему теперь можно персистить (`partialize` ниже): метка привязана к
   * конкретному исходу, а не к «времени, до которого всё прочитано», поэтому
   * «залипнуть» навсегда она не может — следующий ход перезапишет `last_turn`,
   * и ключ перестанет совпадать. Именно поэтому карта теперь сохраняется и
   * переживает перезагрузку страницы (баг: просмотренная сессия снова зеленела
   * после reload).
   *
   * Метка остаётся локальной и per-browser: сервер о ней не знает и не должен —
   * «прочитанность» это свойство текущего просмотра, а не данные сессии
   * (ADR-118 §1: цвет названия — клиентское состояние).
   */
  ackedTurnBySession: Record<string, string>
  /**
   * Отметить сессию просмотренной: `turnKey` — ключ увиденного исхода
   * (`turnKey(session.status.last_turn)`). Пустая строка/пустой id — no-op.
   *
   * Идемпотентно: повторная запись того же ключа состояние не меняет
   * (`return state` — без лишнего рендера подписчиков). Монотонности нет и не
   * нужно: хранится ровно последний увиденный исход.
   */
  markSessionAcked: (sessionId: string, turnKey: string) => void
  /** Ключ просмотренного исхода сессии (`undefined` — не просмотрена). */
  getAckedTurnKey: (sessionId: string) => string | undefined
  /** Забыть метку сессии (сессия удалена — ключ больше не нужен). */
  clearSessionAcked: (sessionId: string) => void
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

      ackedTurnBySession: {},
      markSessionAcked: (sessionId, turnKey) =>
        set((state) => {
          if (!sessionId || !turnKey) return state
          const acked = state.ackedTurnBySession
          // Идемпотентность: этот исход уже отмечен — состояние не меняем (и не
          // дёргаем подписчиков лишним рендером).
          if (acked[sessionId] === turnKey) return state
          // Порядок ключей = порядок последней записи: активная сессия
          // переставляется в конец и не вытесняется первой при обрезке карты.
          const next = { ...acked }
          delete next[sessionId]
          next[sessionId] = turnKey
          return { ackedTurnBySession: trimAcked(next) }
        }),
      getAckedTurnKey: (sessionId) => get().ackedTurnBySession[sessionId],
      clearSessionAcked: (sessionId) =>
        set((state) => {
          if (state.ackedTurnBySession[sessionId] === undefined) return state
          const next = { ...state.ackedTurnBySession }
          delete next[sessionId]
          return { ackedTurnBySession: next }
        }),
    }),
    {
      name: 'synth-ui-notifications',
      // Персистим предпочтения категорий и метки «просмотрено». Метки теперь
      // безопасны в localStorage: они привязаны к идентичности исхода
      // (`<outcome>|<at>`), а не к клиентскому времени, поэтому «залипнуть»
      // навсегда не могут — новый ход меняет ключ (см. комментарий к полю).
      partialize: (state) => ({
        prefs: state.prefs,
        ackedTurnBySession: state.ackedTurnBySession,
      }),
      merge: (persisted, current) => {
        const p = persisted as Record<string, unknown> | undefined
        const persistedAcked = p?.ackedTurnBySession
        return {
          ...current,
          prefs: (p?.prefs as NotificationPrefs) ?? current.prefs,
          // `localStorage` — внешние данные: чистим и обрезаем и при
          // восстановлении (правка руками, старый/чужой формат, разросшаяся
          // карта).
          ackedTurnBySession:
            persistedAcked && typeof persistedAcked === 'object' && !Array.isArray(persistedAcked)
              ? trimAcked(sanitizeAcked(persistedAcked as Record<string, unknown>))
              : current.ackedTurnBySession,
        }
      },
    }
  )
)
