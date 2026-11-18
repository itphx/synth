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
//
// Накопленные логи ключуются по `runId:stream` (`processLogKey`): у прогона
// три потока вывода (`combined`/`stdout`/`stderr`), их тексты не смешиваются.

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type {
  BackgroundRunKind,
  BackgroundRunRecord,
  BackgroundRunStatus,
  BlockingRun,
  ProcessLogStream,
  ProcessesListOptions,
} from '@/lib/api/synthApi'

export type { ProcessLogStream }

/**
 * Параметры загрузки реестра (`load`).
 *
 * `scopeSessionIds` — сессии скоупа показа (только для клиентской чистки):
 * запись, чья сессия-владелец входит в скоуп, убирается, даже если её
 * `projectId` не совпал с запрошенным. Live-события проекта не несут, поэтому
 * у записи из дочерней сессии `projectId` может быть не заполнен — сервер
 * такую запись в проектную выборку не отдаёт, и без набора id она висела бы в
 * панели до перезагрузки страницы. На провод набор не уходит.
 */
export interface ProcessesLoadOptions extends ProcessesListOptions {
  scopeSessionIds?: string[]
}

/**
 * Предел выборки активных прогонов (`loadActive`).
 *
 * Сервер отдаёт не больше 200 записей за раз — этого хватает, чтобы значки
 * в дереве не «мигали» на больших инстансах.
 */
const ACTIVE_LIST_LIMIT = 200

/**
 * Ключ накопленного лога: прогон + поток вывода.
 *
 * У прогона три потока (`combined`/`stdout`/`stderr`), и их накопленные тексты
 * не должны смешиваться — поэтому ключ включает поток.
 */
export function processLogKey(runId: string, stream: ProcessLogStream): string {
  return `${runId}:${stream}`
}

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
  /**
   * Блокирующие прогоны (ADR-111 §detach) — порядок как пришёл от сервера.
   *
   * Это записи, которые идут **внутри хода**: в реестре фоновых прогонов их
   * ещё нет. Обновляются списком (`load`/`refreshBlocking`) и событиями
   * `background.auto_detached`/`process.detached` (запись переехала в фон).
   */
  blocking: BlockingRun[]
  /** Был ли хотя бы один успешный список с блокирующими (для событийного рефреша). */
  blockingLoaded: boolean
  /** Скоуп последнего списка, принёсшего блокирующие (для рефреша по событию). */
  blockingScope: ProcessesListOptions | null
  /** Ключ скоупа, по которому известен набор id (чистка только своего скоупа). */
  blockingScopeKey: string | null
  /** id блокирующих из последнего ответа своего скоупа (для чистки). */
  blockingKnownIds: string[]
  /** Накопленные логи по ключу `runId:stream` (см. `processLogKey`). */
  logs: Record<string, ProcessLogState>
  /** id прогонов, пришедших из live-событий и ещё не подтверждённых списком сервера. */
  pendingIds: string[]
  /** Скоуп последнего успешного списка (для событийного перечитывания). */
  listScope: ProcessesLoadOptions | null
  /** Был ли хоть один успешный список (панель уже открывалась). */
  listLoaded: boolean
  /** Ошибка загрузки списка (текст). */
  error: string | null

  /**
   * Загрузить реестр и слить его с текущим состоянием.
   *
   * Чистка — **по скоупу запроса**: при `sessionId`/`projectId` убираются
   * только записи этого скоупа, которых больше нет в ответе; без фильтров —
   * весь реестр (прежнее поведение). В проектном скоупе дополнительно
   * передаётся набор сессий (`scopeSessionIds`, см. `ProcessesLoadOptions`):
   * запись из дочерней сессии без `projectId` тоже убирается.
   *
   * Список запрашивается с `include=blocking`: блокирующие прогоны приходят
   * тем же ответом, что и фоновые.
   */
  load: (options?: ProcessesLoadOptions) => Promise<void>
  /**
   * Перечитать список в последнем запрошенном скоупе.
   *
   * Нужен терминальным событиям фоновой работы (`process.exited`/`child.*`):
   * карточка обновляется сразу, а не ждёт пятисекундного поллинга. Список ещё
   * не запрашивали (панель не открывалась) — ничего не делаем: при открытии
   * панель загрузит его сама.
   */
  refreshList: () => Promise<void>
  /**
   * Перечитать **блокирующие** прогоны (список — `include=blocking`).
   *
   * Нужен событиям (`background.auto_detached`, `process.detached`): запись
   * могла переехать из блокирующих в фоновые. Скоуп по умолчанию — последний
   * запрошенный. Ошибка глотается: это фоновое обновление, а не действие
   * пользователя (список всё равно перечитается периодически).
   */
  refreshBlocking: (options?: ProcessesListOptions) => Promise<void>
  /**
   * Загрузить **только активные** прогоны инстанса (`status=running`).
   *
   * Нужен дереву сессий: значки фоновой активности должны быть видны до
   * открытия панели «Процессы». Ответ сервера — выборка `running`, поэтому
   * терминальные записи (`completed`/`failed`/…) из неё выпасть не могут и
   * остаются в реестре как есть; из `running`-записей убираются только те,
   * которых сервер больше не отдаёт (кроме `pendingIds` — их принесли
   * live-события, и серверный список мог их ещё не увидеть).
   */
  loadActive: () => Promise<void>
  /** Применить live-событие (`process.*`/`child.*`). */
  applyEvent: (type: string, payload: Record<string, unknown>) => void
  /** Добавить или заменить запись реестра. */
  upsert: (run: BackgroundRunRecord) => void
  /** Убрать блокирующий прогон из снимка (после остановки/перевода в фон). */
  removeBlocking: (id: string) => void
  /** Убрать запись реестра (и её логи — все потоки). */
  remove: (id: string) => void
  /** Очистить реестр целиком. */
  clear: () => void
  /** Слить отрезок лога в накопленный текст (прогон + поток). */
  mergeLog: (runId: string, stream: ProcessLogStream, chunk: ProcessLogChunk) => void
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

/**
 * Ключ скоупа запроса блокирующих прогонов.
 *
 * Чистка идёт только внутри **того же** скоупа: записи другого скоупа не
 * удаляются (как и у фонового реестра — от них зависят значки активности).
 */
function blockingScopeKey(options?: ProcessesListOptions): string {
  if (options?.sessionId) return `session:${options.sessionId}`
  if (options?.projectId) return `project:${options.projectId}`
  return 'all'
}

/**
 * Слияние снимка блокирующих прогонов с уже известными записями.
 *
 * Ответ сервера — истина для своего скоупа: записи, которые в этом скоупе
 * были известны, но пропали из ответа, убираются (прогон завершился/переведён
 * в фон). Записи других скоупов сохраняются. Порядок — как пришёл от сервера,
 * остальные записи — в конце.
 */
function mergeBlocking(
  state: {
    blocking: BlockingRun[]
    blockingScopeKey: string | null
    blockingKnownIds: string[]
  },
  options: ProcessesListOptions | undefined,
  incoming: BlockingRun[],
): Pick<ProcessesState, 'blocking' | 'blockingScopeKey' | 'blockingKnownIds'> {
  const key = blockingScopeKey(options)
  const previousKnown = state.blockingScopeKey === key ? new Set(state.blockingKnownIds) : new Set<string>()
  const incomingIds = new Set(incoming.map((run) => run.id))
  const next: BlockingRun[] = incoming.map((run) => ({ ...run }))
  for (const run of state.blocking) {
    if (incomingIds.has(run.id)) continue
    // В этом же скоупе сервер запись больше не отдаёт — она завершилась.
    if (previousKnown.has(run.id)) continue
    next.push(run)
  }
  return {
    blocking: next,
    blockingScopeKey: key,
    blockingKnownIds: [...incomingIds],
  }
}


/**
 * Попадает ли запись в скоуп запроса списка прогонов.
 *
 * Ответ сервера отфильтрован (`sessionId`/`projectId`), поэтому записи
 * **вне** скоупа в нём просто не приходят — но и удалять их нельзя: реестр
 * общий, и от чужих записей зависят значки фоновой активности в дереве
 * сессий. Без фильтра запроса скоуп — весь реестр (прежнее поведение).
 */
function inRequestedScope(
  run: BackgroundRunRecord,
  options?: ProcessesLoadOptions,
): boolean {
  if (options?.sessionId) return run.sessionId === options.sessionId
  if (options?.projectId) {
    if (run.projectId === options.projectId) return true
    // Запись без проекта (live-событие) или с чужим `projectId`, но её сессия
    // входит в скоуп панели — значит, панель её показывает и должна убирать.
    return (
      !!run.sessionId && (options.scopeSessionIds?.includes(run.sessionId) ?? false)
    )
  }
  return true
}

/** Параметры запроса к API: набор id сессий — клиентский, на провод не идёт. */
function listRequestOptions(options?: ProcessesLoadOptions): ProcessesListOptions | undefined {
  if (!options) return undefined
  const { scopeSessionIds: _scopeSessionIds, ...rest } = options
  return rest
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

/**
 * События фоновых прогонов-саб-агентов (`child.*`).
 *
 * В канал родителя публикуются и другие `child.*`-события
 * (`child.message.added`/`child.session.updated` — обычный, не фоновый
 * саб-агент); в реестр фоновой работы они не относятся.
 */
const CHILD_RUN_EVENTS = new Set([
  'child.started',
  'child.completed',
  'child.failed',
  'child.cancelled',
])

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
  blocking: [],
  blockingLoaded: false,
  blockingScope: null,
  blockingScopeKey: null,
  blockingKnownIds: [],
  logs: {},
  pendingIds: [],
  listScope: null,
  listLoaded: false,
  error: null,

  load: async (options) => {
    try {
      const response = await synthApi.listProcessesWithBlocking(listRequestOptions(options))
      const runs = response.runs
      set((s) => {
        const byId: Record<string, BackgroundRunRecord> = { ...s.byId }
        const fetched = new Set(runs.map((run) => run.id))
        for (const run of runs) {
          byId[run.id] = { ...byId[run.id], ...run }
        }
        // Записи, которых больше нет в ответе сервера, убираем — но только
        // **в том скоупе, который запросили**: ответ отфильтрован сервером,
        // и записи других сессий/проектов в нём не приходят вовсе. Иначе
        // открытая панель «Процессы» вычищала бы из общего реестра чужие
        // записи (от них зависят значки активности в дереве сессий).
        // Кроме тех, что пришли из live-событий и ещё не видны в списке
        // (событие могло прийти раньше ответа сервера).
        for (const [id, run] of Object.entries(byId)) {
          if (fetched.has(id)) continue
          if (s.pendingIds.includes(id)) continue
          if (!inRequestedScope(run, options)) continue
          delete byId[id]
        }
        return {
          byId,
          order: sortOrder(byId),
          ...mergeBlocking(s, options, response.blocking),
          blockingLoaded: true,
          blockingScope: options ?? null,
          listScope: options ?? null,
          listLoaded: true,
          pendingIds: s.pendingIds.filter((id) => !fetched.has(id)),
          error: null,
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  refreshList: async () => {
    const state = useProcessesStore.getState()
    if (!state.listLoaded) return
    await state.load(state.listScope ?? undefined)
  },

  refreshBlocking: async (options) => {
    const state = useProcessesStore.getState()
    const scope = options ?? state.blockingScope ?? undefined
    try {
      const response = await synthApi.listProcessesWithBlocking(scope)
      set((s) => ({
        ...mergeBlocking(s, scope, response.blocking),
        blockingLoaded: true,
        blockingScope: scope ?? null,
      }))
    } catch {
      // Фоновое обновление: ошибка не должна затирать ни реестр, ни его
      // ошибку загрузки — список перечитается периодически.
    }
  },

  loadActive: async () => {
    try {
      const runs = await synthApi.listProcesses({ status: 'running', limit: ACTIVE_LIST_LIMIT })
      set((s) => {
        const byId: Record<string, BackgroundRunRecord> = { ...s.byId }
        const fetched = new Set(runs.map((run) => run.id))
        for (const run of runs) {
          byId[run.id] = { ...byId[run.id], ...run }
        }
        // Ответ — выборка `running`, поэтому терминальные записи в нём
        // отсутствуют и остаются в реестре как есть. Убираем только
        // `running`-записи, которых сервер больше не отдаёт.
        for (const [id, run] of Object.entries(byId)) {
          if (run.status !== 'running') continue
          if (fetched.has(id)) continue
          if (s.pendingIds.includes(id)) continue
          delete byId[id]
        }
        return {
          byId,
          order: sortOrder(byId),
          error: null,
        }
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  applyEvent: (type, payload) => {
    const backgroundRunId = str(payload, 'background_run_id')
    const isChild = CHILD_RUN_EVENTS.has(type)
    const isProcess = type.startsWith('process.')
    if (!isChild && !isProcess) return

    const sessionId =
      str(payload, 'session_id') ?? str(payload, 'parent_session_id') ?? ''
    // `process.detached` переводит в фон **уже идущий** прогон: у него в
    // payload есть `kind` (`subagent` — блокирующий `task`, `process` — shell),
    // и запись должна попасть в реестр правильным видом.
    const payloadKind = str(payload, 'kind')
    const kind: BackgroundRunKind =
      payloadKind === 'subagent' || payloadKind === 'process'
        ? payloadKind
        : isChild
          ? 'subagent'
          : 'process'
    const childSessionId =
      isChild || type === 'process.detached' ? str(payload, 'child_session_id') : undefined
    const id = backgroundRunId ?? childSessionId ?? str(payload, 'process_id')
    if (!id) return

    // `child.started` — прогон только начался (не терминальное событие).
    const terminal =
      type === 'process.exited' || type === 'process.stopped' || (isChild && type !== 'child.started')
    const status = isChild
      ? type === 'child.started' ? 'running' : statusFromChildEvent(type)
      : terminal
        ? statusFromState(payload.state)
        : 'running'

    set((s) => {
      const prev = s.byId[id]
      const now = new Date().toISOString()
      const patch: Partial<BackgroundRunRecord> = {
        kind,
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
        ...(isChild && str(payload, 'agent_role')
          ? { agentRole: str(payload, 'agent_role') }
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
      const prefix = `${id}:`
      const logKeys = Object.keys(s.logs).filter((key) => key.startsWith(prefix))
      if (!s.byId[id] && logKeys.length === 0) return {}
      const byId = { ...s.byId }
      delete byId[id]
      // Логи прогона удаляются **всех потоков** (ключ — `runId:stream`).
      const logs = { ...s.logs }
      for (const key of logKeys) delete logs[key]
      return {
        byId,
        logs,
        order: sortOrder(byId),
        pendingIds: s.pendingIds.filter((pending) => pending !== id),
      }
    })
  },

  clear: () => {
    set({
      byId: {},
      order: [],
      blocking: [],
      blockingLoaded: false,
      blockingScope: null,
      blockingScopeKey: null,
      blockingKnownIds: [],
      logs: {},
      pendingIds: [],
      listScope: null,
      listLoaded: false,
      error: null,
    })
  },

  removeBlocking: (id) => {
    set((s) => {
      if (!s.blocking.some((run) => run.id === id)) return {}
      return {
        blocking: s.blocking.filter((run) => run.id !== id),
        blockingKnownIds: s.blockingKnownIds.filter((known) => known !== id),
      }
    })
  },

  mergeLog: (runId, stream, chunk) => {
    set((s) => {
      const key = processLogKey(runId, stream)
      const prev = s.logs[key]
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
          [key]: {
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

/** Блокирующие прогоны сессии-владельца (порядок — как пришёл от сервера). */
export function blockingBySession(
  state: { blocking: BlockingRun[] },
  sessionId: string,
): BlockingRun[] {
  return state.blocking.filter((run) => run.sessionId === sessionId)
}
