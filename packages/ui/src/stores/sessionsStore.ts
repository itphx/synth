import { create } from 'zustand'
import type { SessionData, EntityOrigin } from '@/lib/api/synthApi'
import type { SessionMode } from '@itphx/synth-shared'
import { synthApi } from '@/lib/api/synthApi'
import { loadRoutingDefaults, routingDefaultsToSettings } from '@/lib/routingDefaults'
import { useUIStore } from './useUIStore'
import { useChatStore } from './chatStore'
import { isTransportConnected } from './transportStore'
import { useHybridStore } from './hybridStore'
import { i18nText } from '@/lib/i18n/text'
import { confirm } from '@/lib/confirm'

interface SessionsStore {
  sessions: SessionData[]
  loading: boolean
  error: string | null
  /**
   * Всего видимых сессий (после фильтра видимости и `project_id`) — из
   * `GET /sessions` (`total`). Больше, чем в загруженной странице.
   */
  total: number
  /**
   * Курсор следующей страницы списка (`offset`); `null` — страница последняя.
   *
   * Список сессий **всегда пагинирован** (полный список с историей давал пик
   * heap), поэтому дерево показывает первую страницу и кнопку «Показать ещё».
   */
  nextOffset: number | null
  /** Идёт ли догрузка следующей страницы (`loadMoreSessions`). */
  loadingMore: boolean
  /** Фильтр проекта, под которым загружен список (`null` — без проекта). */
  listProjectId: string | null
  /**
   * Список показан по данным до потери связи (offline-деградация гибрида):
   * сервер ответил локальным миром (`remote_offline`), удалённая часть
   * недоступна — ранее загруженные удалённые сессии сохранены.
   */
  stale: boolean

  loadSessions: (projectId?: string | null) => Promise<void>
  /** Догрузить следующую страницу списка сессий (кнопка «Показать ещё»). */
  loadMoreSessions: () => Promise<void>
  createSession: (data: {
    name?: string
    project_id?: string | null
    settings?: Record<string, unknown>
    origin?: EntityOrigin
  }) => Promise<SessionData | null>
  forkSession: (sessionId: string, options?: { message_id?: string; message_index?: number; title?: string }) => Promise<SessionData | null>
  moveSession: (sessionId: string, projectId: string | null) => Promise<SessionData | null>
  renameSession: (sessionId: string, newName: string) => Promise<SessionData | null>
  /**
   * Перегенерировать авто-название сессии: PATCH /sessions/:id { title: '' } —
   * сервер синхронно генерирует новый заголовок по диалогу и возвращает DTO
   * сессии. Обновляет запись сессии в сторе и заголовок открытого таба.
   */
  regenerateSessionTitle: (sessionId: string) => Promise<SessionData | null>
  /** Обновить иконку/цвет сессии (PATCH /sessions/:id); `null` — сброс. */
  updateSessionMeta: (
    sessionId: string,
    meta: { icon?: string | null; color?: string | null },
  ) => Promise<SessionData | null>
  deleteSession: (sessionId: string) => Promise<boolean>
  setSessionMode: (sessionId: string, mode: SessionMode) => Promise<SessionData>
  upsertSession: (session: SessionData) => void
  getSessionsByProject: (projectId: string | null) => SessionData[]
}

/** Тело PATCH /sessions/:id, которое использует этот стор. */
type SessionPatch = { name?: string; title?: string }

/**
 * Размер страницы списка сессий.
 *
 * Совпадает с серверным дефолтом (`DEFAULT_SESSIONS_LIMIT` в core), но задаётся
 * явно: клиент не должен зависеть от серверного дефолта при смене версии.
 */
export const SESSIONS_PAGE_LIMIT = 100

/**
 * PATCH сессии + единая обработка ошибки (общая часть для renameSession и
 * regenerateSessionTitle): при ошибке — `error` в сторе и `null`.
 */
async function patchSession(sessionId: string, patch: SessionPatch): Promise<SessionData | null> {
  try {
    return await synthApi.updateSession(sessionId, patch)
  } catch (e) {
    useSessionsStore.setState({ error: (e as Error).message })
    return null
  }
}

/**
 * Правило счётчика висящих подтверждений (`pending_approvals`).
 *
 * **Отсутствие поля в DTO ≠ «ожиданий нет»**: старый сервер (или точечный
 * ответ `GET /sessions/:id` без счётчика) поле не отдаёт — прежнее значение
 * сохраняем, иначе метка «ждёт подтверждения прав» пропала бы вслед за
 * любым точечным обновлением сессии. Поле есть — доверяем ему (даже `0`).
 */
function withPendingApprovals(prev: SessionData | undefined, next: SessionData): SessionData {
  if (!prev || next.pending_approvals !== undefined) return next
  if (prev.pending_approvals === undefined) return next
  return { ...next, pending_approvals: prev.pending_approvals }
}

/** Обновить запись сессии в сторе по ответу сервера. */
function applySession(sessionId: string, updated: SessionData): void {
  useSessionsStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? withPendingApprovals(sess, updated) : sess,
    ),
  }))
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  total: 0,
  nextOffset: null,
  loadingMore: false,
  listProjectId: null,
  stale: false,

  loadSessions: async (projectId?) => {
    set({ loading: true, error: null })
    try {
      // Список сессий пагинирован (ADR-089): грузим **первую** страницу.
      const page = await synthApi.getSessionsPage({
        project_id: projectId ?? undefined,
        limit: SESSIONS_PAGE_LIMIT,
      })
      const remoteOffline = page.remote_offline === true
      useHybridStore.getState().markRemoteDegraded(remoteOffline)
      set((s) => {
        // Список DTO без `pending_approvals` (старый сервер) — прежние
        // счётчики ожиданий сохраняем: отсутствие поля не значит «ожиданий нет».
        const prevById = new Map(s.sessions.map((sess) => [sess.id, sess]))
        const incoming = (page.sessions ?? []).map((sess) =>
          withPendingApprovals(prevById.get(sess.id), sess),
        )
        if (!remoteOffline) {
          return {
            sessions: incoming,
            total: typeof page.total === 'number' ? page.total : incoming.length,
            nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
            listProjectId: projectId ?? null,
            loading: false,
            stale: false,
          }
        }
        // Offline-деградация: сервер отдал только локальный мир. Ранее
        // загруженный удалённый список не затираем — иначе «все сессии пропали».
        const hadRemote = s.sessions.some((sess) => sess.origin === 'remote')
        const hasRemote = incoming.some((sess) => sess.origin === 'remote')
        if (hadRemote && !hasRemote) {
          return { listProjectId: projectId ?? null, loading: false, stale: true }
        }
        return {
          sessions: incoming,
          total: typeof page.total === 'number' ? page.total : incoming.length,
          nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
          listProjectId: projectId ?? null,
          loading: false,
          stale: true,
        }
      })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    }
  },

  /**
   * Догрузка следующей страницы списка (кнопка «Показать ещё»).
   *
   * Страница **дописывается** к уже загруженной: разборы проектов, раскрытые
   * группы и выбранная сессия не сбрасываются (список в сторе — единственный
   * источник для дерева).
   */
  loadMoreSessions: async () => {
    const { nextOffset, loadingMore, listProjectId } = get()
    if (loadingMore || nextOffset === null) return
    set({ loadingMore: true })
    try {
      const page = await synthApi.getSessionsPage({
        project_id: listProjectId ?? undefined,
        limit: SESSIONS_PAGE_LIMIT,
        offset: nextOffset,
      })
      const incoming = page.sessions ?? []
      set((s) => {
        const seen = new Set(s.sessions.map((sess) => sess.id))
        const merged = [...s.sessions]
        for (const sess of incoming) {
          if (seen.has(sess.id)) continue
          seen.add(sess.id)
          merged.push(sess)
        }
        return {
          sessions: merged,
          total: typeof page.total === 'number' ? page.total : s.total,
          nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
          loadingMore: false,
        }
      })
    } catch (e) {
      set({ error: (e as Error).message, loadingMore: false })
    }
  },

  createSession: async (data) => {
    try {
      // Переносим глобальные дефолты маршрутизации (ADR-034) в новую сессию,
      // если вызывающий код явно не передал settings.
      const session = await synthApi.createSession({
        ...data,
        settings: data.settings ?? routingDefaultsToSettings(loadRoutingDefaults()),
      })
      // Гибрид: не теряем origin свежесозданной сессии (бейдж/фильтры в дереве).
      // Ответ API почти всегда несёт origin, но страхуемся на случай отсутствия.
      const normalized = { ...session, origin: session.origin ?? data.origin ?? ('local' as const) }
      if (!isTransportConnected()) {
        // Новая сессия — **в начало** списка; страницы не сбрасываем
        // (догруженные страницы остаются в сторе).
        set((s) => ({ sessions: [normalized, ...s.sessions], total: s.total + 1 }))
      }
      return normalized
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  forkSession: async (sessionId, options) => {
    try {
      const fork = await synthApi.forkSession(sessionId, options)
      if (!isTransportConnected()) {
        set((s) => {
          if (s.sessions.some((ses) => ses.id === fork.id)) return s
          return { sessions: [fork, ...s.sessions] }
        })
      }
      return fork
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  moveSession: async (sessionId, projectId) => {
    try {
      const updated = await synthApi.updateSession(sessionId, { project_id: projectId })
      if (!isTransportConnected()) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? withPendingApprovals(sess, updated) : sess,
          ),
        }))
      }
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  renameSession: async (sessionId, newName) => {
    const updated = await patchSession(sessionId, { name: newName })
    if (!updated) return null
    if (!isTransportConnected()) {
      applySession(sessionId, updated)
    }
    return updated
  },

  // Перегенерация авто-названия: PATCH { title: '' } — сервер сам генерирует
  // заголовок по диалогу. Ответ — источник истины: обновляем запись сессии в
  // сторе и заголовок открытого таба (событие session.updated придёт позже).
  regenerateSessionTitle: async (sessionId) => {
    const updated = await patchSession(sessionId, { title: '' })
    if (!updated) return null
    applySession(sessionId, updated)
    const newTitle = updated.name
    if (newTitle) {
      useUIStore.getState().updateTabTitle(`chat-${sessionId}`, newTitle)
    }
    return updated
  },

  // Иконка/цвет сессии (PATCH): локально применяем сразу — дерево/табы
  // обновляются мгновенно, не дожидаясь события session.updated.
  updateSessionMeta: async (sessionId, meta) => {
    try {
      const updated = await synthApi.updateSession(sessionId, meta)
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? withPendingApprovals(sess, { ...sess, ...updated }) : sess,
        ),
      }))
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      return null
    }
  },

  async deleteSession(sessionId: string) {
    // Гибрид: удаление удалённой сессии выполняется на сервере — подтверждение.
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session?.origin === 'remote') {
      const ok = await confirm({ title: i18nText('hybrid.confirmDeleteRemoteSession'), variant: 'danger' })
      if (!ok) return false
    }
    try {
      await synthApi.deleteSession(sessionId)
      if (!isTransportConnected()) {
        set((s) => ({
          sessions: s.sessions.filter((sess) => sess.id !== sessionId),
          total: Math.max(0, s.total - 1),
        }))
      }

      const tabId = `chat-${sessionId}`
      const uiState = useUIStore.getState()
      const tab = uiState.centerTabs.find((t) => t.id === tabId)
      if (tab) {
        uiState.closeTab(tabId)
      }

      useChatStore.getState().clearSession(sessionId)

      return true
    } catch (e) {
      set({ error: (e as Error).message })
      return false
    }
  },

  // Plan/Act режим сессии (ADR-025): PATCH /sessions/:id { mode }
  // Бросает ошибку при неудаче — вызывающий код решает, что показать.
  setSessionMode: async (sessionId, mode) => {
    try {
      const updated = await synthApi.patchSessionMode(sessionId, mode)
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? withPendingApprovals(sess, updated) : sess,
        ),
      }))
      return updated
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    }
  },

  // Кладёт актуальные данные сессии в стор (например, после GET /sessions/:id).
  // Повторяет паттерн setSessionMode (map), но добавляет сессию, если её ещё нет
  // в сторе (например, до loadSessions или для сессии из другого проекта).
  //
  // DTO без `pending_approvals` (старый сервер, событие без счётчика) —
  // отсутствие поля НЕ значит «ожиданий нет»: прежнее значение сохраняем.
  upsertSession: (session) =>
    set((s) => {
      const exists = s.sessions.some((ses) => ses.id === session.id)
      if (!exists) return { sessions: [session, ...s.sessions] }
      return {
        sessions: s.sessions.map((ses) =>
          ses.id === session.id ? withPendingApprovals(ses, session) : ses,
        ),
      }
    }),

  getSessionsByProject: (projectId) => {
    return get().sessions.filter((s) => s.project_id === projectId)
  },
}))
