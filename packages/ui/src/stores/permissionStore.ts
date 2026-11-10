import { create } from 'zustand'
import type { PermissionPreview, PermissionPreviewFile } from '@itphx/synth-shared/types'

export const PERMISSION_ASK_TIMEOUT_MS = 30_000

/**
 * Структурная причина ask'а — «виновник» в машиночитаемом виде.
 *
 * Приходит из ядра аддитивно (ADR-029): id security-сообщения, параметры
 * подстановки, ключ сработавшего правила и вид ask'а. UI по нему строит
 * ЧЕЛОВЕЧЕСКОЕ объяснение («Защищённый путь: …») вместо LLM-текста причины
 * и подсвечивает токен-виновник в аргументах вызова.
 *
 * ⚠️ Это НЕ аргументы тула: аргументы лежат в `PermissionRequest.params`,
 * параметры виновника — здесь (`trigger.params`).
 */
export interface PermissionTrigger {
  /** id security-сообщения (например `ask-protected-path`). */
  messageId?: string
  /** Параметры подстановки (`{ path }` / `{ command }` / `{ code }`). */
  params?: Record<string, string>
  /** Ключ правила, которое сработало (например `shell-policy.approve`). */
  matchedRule?: string
  /** Вид ask'а от shell-guard: dynamic/protected/mutation/cwd. */
  askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd'
}

export interface PermissionRequest {
  approvalId: string
  toolName: string
  params: Record<string, unknown>
  reason: string
  askedAt: string
  timeoutMs: number
  /** true — пользователь нажал «Остановить таймер»: UI-таймер снят, запрос живёт до ответа. */
  held?: boolean
  /**
   * Превью изменений (аддитивно): unified diff по файлам, которые тул
   * собирается изменить — пользователь подтверждает запись, видя, ЧТО
   * изменится. Поля нет, если превью не посчиталось или сервер его не прислал.
   */
  preview?: PermissionPreview
  /** Паттерны shell-гранта, которые будут разрешены в сессии (аддитивно). */
  save?: string[]
  /**
   * Структурная причина ask'а (аддитивно): «виновник» — путь/код/команда,
   * ради которых спросили. Поля нет у старого сервера — тогда UI показывает
   * прежний текст причины.
   */
  trigger?: PermissionTrigger
}

/** Виды ask'а, которые различает ядро. */
const PERMISSION_ASK_KINDS = new Set(['dynamic', 'protected', 'mutation', 'cwd'])

/**
 * Разбор `trigger` из payload'а события / DTO восстановления.
 *
 * Данные приходят по проводу — разбираем их строго: неправильная форма →
 * `trigger` просто не появляется (поведение прежнее: показываем reason).
 */
export function parsePermissionTrigger(value: unknown): PermissionTrigger | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const trigger: PermissionTrigger = {}

  if (typeof raw.messageId === 'string' && raw.messageId) trigger.messageId = raw.messageId
  if (typeof raw.matchedRule === 'string' && raw.matchedRule) trigger.matchedRule = raw.matchedRule
  if (typeof raw.askKind === 'string' && PERMISSION_ASK_KINDS.has(raw.askKind)) {
    trigger.askKind = raw.askKind as PermissionTrigger['askKind']
  }
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    const params: Record<string, string> = {}
    for (const [key, item] of Object.entries(raw.params as Record<string, unknown>)) {
      if (typeof item === 'string') params[key] = item
      else if (typeof item === 'number' || typeof item === 'boolean') params[key] = String(item)
    }
    if (Object.keys(params).length > 0) trigger.params = params
  }

  return Object.keys(trigger).length > 0 ? trigger : undefined
}

/**
 * Разбор превью из payload'а события `permission.asked`.
 *
 * Данные приходят по проводу — разбираем их строго: неправильная форма →
 * превью просто не показывается (поведение прежнее).
 */
export function parsePermissionPreview(value: unknown): PermissionPreview | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rawFiles = (value as { files?: unknown }).files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) return undefined

  const files: PermissionPreviewFile[] = []
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object') return undefined
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const diff = typeof record.diff === 'string' ? record.diff : ''
    if (!path || !diff) return undefined
    const additions = typeof record.additions === 'number' && Number.isFinite(record.additions)
      ? record.additions
      : 0
    const deletions = typeof record.deletions === 'number' && Number.isFinite(record.deletions)
      ? record.deletions
      : 0
    files.push({ path, diff, additions, deletions })
  }
  return { files }
}

interface PermissionStore {
  /** Очередь запросов подтверждения по сессиям. Первый элемент — текущий запрос. */
  requestsBySession: Record<string, PermissionRequest[]>

  addRequest: (sessionId: string, req: PermissionRequest) => void
  removeRequest: (sessionId: string, approvalId: string) => void
  clearSession: (sessionId: string) => void
  /** «Остановить таймер»: снять UI-таймер для approvalId и пометить запрос как held. */
  holdRequest: (sessionId: string, approvalId: string) => void
  /**
   * Восстановление очереди по снимку с сервера (`GET /sessions/:id/permissions`).
   *
   * Слияние: записи снимка + локальные, которых в снимке нет (запрос пришёл
   * событием `permission.asked`, но до сервера ещё не дошёл). Таймер для
   * восстановленных записей ставится на **остаток** срока (`askedAt` +
   * `timeoutMs` − сейчас), а не на полный `timeoutMs`: сервер при таймауте
   * `permission.replied` не публикует, карточку снимает только локальный
   * таймер — без остатка она «залипла» бы навсегда. `held`-запрос таймера не
   * получает (живёт до ответа), истёкший (остаток ≤ 0) не добавляется.
   */
  setAll: (sessionId: string, requests: PermissionRequest[]) => void
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

/**
 * Остаток до истечения запроса (мс).
 *
 * `null` — таймер не нужен: запрос `held` (пользователь остановил таймер) или
 * `timeoutMs <= 0` (сервер не отклоняет запрос по времени — живёт до ответа).
 * Иначе — остаток от момента публикации запроса (`askedAt`).
 */
function remainingMs(req: PermissionRequest, now: number): number | null {
  if (req.held) return null
  if (req.timeoutMs <= 0) return null
  const asked = Date.parse(req.askedAt)
  // Момент публикации неизвестен/не разобран — считаем от «сейчас»
  // (запрос живёт полный срок, как будто пришёл событием).
  const base = Number.isFinite(asked) ? asked : now
  return base + req.timeoutMs - now
}

/**
 * Поставить таймер истечения на остаток времени запроса.
 *
 * `false` — запрос уже истёк (остаток ≤ 0): в очередь его добавлять нельзя.
 */
function scheduleExpiry(sessionId: string, req: PermissionRequest, now: number): boolean {
  const remaining = remainingMs(req, now)
  clearExpiryTimer(req.approvalId)
  if (remaining === null) return true
  if (remaining <= 0) return false
  expiryTimers.set(req.approvalId, setTimeout(() => {
    usePermissionStore.getState().removeRequest(sessionId, req.approvalId)
  }, remaining))
  return true
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

  setAll: (sessionId, requests) => {
    const current = get().requestsBySession[sessionId] ?? []
    const snapshotIds = new Set(requests.map((r) => r.approvalId))
    const now = Date.now()

    // Снимок сервера — источник истины по составу очереди и по времени:
    // таймер каждой записи ставится на остаток её срока.
    const next: PermissionRequest[] = []
    for (const req of requests) {
      // Истёкший запрос не восстанавливаем — сервер его уже отклонил.
      if (!scheduleExpiry(sessionId, req, now)) continue
      next.push(req)
    }
    // Локальные записи, которых в снимке нет: запрос пришёл событием
    // `permission.asked`, но в снимок ещё не попал. Сохраняем — карточка
    // не должна «прыгать» из-под пользователя.
    for (const req of current) {
      if (snapshotIds.has(req.approvalId)) continue
      next.push(req)
    }

    if (next.length === 0) {
      set((s) => {
        const requestsBySession = { ...s.requestsBySession }
        delete requestsBySession[sessionId]
        return { requestsBySession }
      })
      return
    }
    set((s) => ({
      requestsBySession: { ...s.requestsBySession, [sessionId]: next },
    }))
  },
}))
