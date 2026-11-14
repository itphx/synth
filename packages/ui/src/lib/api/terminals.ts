// terminals: домен API v2 — интерактивные терминалы (PROP-132, Ф3б).
//
// Серверный контракт (ядро: `server/routes/terminals.ts`,
// `engine/terminal/types.ts` → `toTerminalDto`):
//
//   GET    /api/v2/terminals?project_id&session_id&limit&offset
//          → { terminals: TerminalDto[], total, offset, limit, next_offset }
//   GET    /api/v2/terminals/:id                  → { terminal: TerminalDto }
//   POST   /api/v2/terminals                      → { terminal: TerminalDto } (201)
//   PATCH  /api/v2/terminals/:id                  → { terminal: TerminalDto }
//   DELETE /api/v2/terminals/:id                  → 204
//   GET    /api/v2/terminals/:id/output?since=N   → { data, seq, next_seq,
//                                                      truncated, total_bytes,
//                                                      dropped_bytes, chunks }
//   GET    /api/v2/terminals/:id/stream?since=N   → NDJSON-поток:
//                                                      {"seq":n,"data":"…"},
//                                                      кадр выхода — с exit_code/signal
//   POST   /api/v2/terminals/:id/input            → 204
//   POST   /api/v2/terminals/:id/resize           → 204
//
// **Фильтры списка — snake_case** (`project_id`/`session_id`): сервер читает
// именно их (`c.req.query('project_id')`), camelCase отфильтровывается.
//
// **DTO.** Запись реестра сервер отдаёт в camelCase (`projectId`, `sessionId`,
// `createdAt`, `lastActivityAt`, `exitCode`, …), а добавленные сервером поля
// прав и подписчиков — в snake_case (`can_write`, `attached_clients`).
// Маппер принимает оба набора имён (сервер однажды может перейти на
// snake_case целиком) и приводит к каноническому виду.
//
// **Поток вывода.** Наружу вывод идёт **только** HTTP-потоком NDJSON: по шине
// сервер `terminal.data` не публикует (волатильный класс — `docs/API_V2.md`
// §5.43). События по шине несут только метаданные терминала.
//
// Ошибки — как во всех доменах UI: `fetchJSON` бросает `Error`, у которого
// проставлены `status`, `code` (машинный код сервера) и `details`
// (`lib/api/base.ts`). Хелперы `terminalApiErrorStatus`/`terminalApiErrorCode`
// читают их без приведения типов.

import { BASE_URL, fetchJSON } from './base'

/** Статус терминала (сервер: `starting`/`running`/`exited`). */
export type TerminalStatus = 'starting' | 'running' | 'exited'

/** Снимок терминала (DTO сервера). */
export interface TerminalDto {
  id: string
  /** Проект-владелец терминала. */
  projectId: string
  /** Привязанная сессия (необязательно). */
  sessionId: string | null
  /** Создатель терминала. */
  ownerId: string | null
  /** Рабочий каталог. */
  cwd: string
  /** Оболочка. */
  shell: string
  status: TerminalStatus
  cols: number
  rows: number
  title: string | null
  /** Право ввода: `canEditProjectContent` на сервере. */
  can_write: boolean
  /** Сколько клиентов сейчас подписано на вывод. */
  attached_clients: number
  /** Момент создания (мс epoch). */
  createdAt: number
  /** Момент последней активности (мс epoch). */
  lastActivityAt: number
  /** Код завершения (после выхода). */
  exitCode: number | null
  /** Сигнал завершения (после выхода). */
  signal: string | null
  /** Точка исполнения (`inline`/`executor`). */
  target: string | null
}

/** Фильтр выборки терминалов (все условия — по «И»). */
export interface TerminalListOptions {
  /** Проект-владелец терминала. */
  projectId?: string
  /** Сессия, к которой терминал привязан (опционально). */
  sessionId?: string
  /** Размер страницы (сервер: по умолчанию 50, максимум 200). */
  limit?: number
  /** Смещение страницы. */
  offset?: number
}

/** Страница списка терминалов (ADR-118). */
export interface TerminalListPage {
  terminals: TerminalDto[]
  total: number
  offset: number
  limit: number
  nextOffset: number | null
}

/** Параметры создания терминала. */
export interface CreateTerminalInput {
  projectId: string
  sessionId?: string | null
  /**
   * Рабочий каталог — сервер его **игнорирует** (каталог вычисляет сервер:
   * `session.worktree.directory` → `project.workspace`), поэтому в тело
   * запроса не отправляется.
   */
  cwd?: string
  /** Оболочка; по умолчанию — серверная (`terminal.shell`). */
  shell?: string
  cols?: number
  rows?: number
  title?: string
}

/** Точечная правка терминала (переименование / привязка к сессии). */
export interface TerminalPatch {
  title?: string | null
  session_id?: string | null
}

/** Снимок вывода из кольцевого буфера (догон по курсору). */
export interface TerminalOutputSnapshot {
  /** Данные вывода (склеенные фрагменты). */
  data: string
  /** Курсор первого фрагмента ответа. */
  seq: number
  /** Курсор после последнего фрагмента ответа. */
  nextSeq: number
  /** Часть вывода вытеснена из буфера — клиент увидел не всё. */
  truncated: boolean
  /** Объём вывода, удерживаемого буфером (байт). */
  totalBytes: number
  /** Сколько байт вывода потеряно (вытеснено из буфера). */
  droppedBytes: number
}

/** Кадр потока вывода (NDJSON). */
export interface TerminalStreamFrame {
  /** Номер фрагмента в кольцевом буфере. */
  seq: number
  /** Текст фрагмента. */
  data: string
  /** Код завершения (кадр выхода). */
  exitCode?: number
  /** Сигнал завершения (кадр выхода). */
  signal?: string
}

/** Фрагмент вывода, пришедший в поток. */
export interface TerminalStreamChunk {
  seq: number
  data: string
}

/** Опции потока вывода. */
export interface TerminalStreamOptions {
  /** Курсор догоня: сервер присылает кадры с `seq > since`. */
  since?: number
  /** Отмена потока (размонтирование вкладки, смена терминала). */
  signal?: AbortSignal
  /** Фрагмент вывода. */
  onChunk: (chunk: TerminalStreamChunk) => void
  /** Терминал завершился (кадр с `exit_code`/`signal`). */
  onExit?: (info: { exitCode?: number; signal?: string }) => void
}

interface TerminalListResponse {
  terminals?: unknown[]
  total?: number
  offset?: number
  limit?: number
  next_offset?: number | null
}

interface TerminalResponse {
  terminal?: unknown
}

interface TerminalOutputResponse {
  data?: string
  seq?: number
  next_seq?: number
  truncated?: boolean
  total_bytes?: number
  dropped_bytes?: number
}

/** Статус ошибки домена (0 — «ответа не было», сети/таймаута). */
export function terminalApiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** Машинный код ошибки домена (`TERMINALS_DISABLED`, `TERMINAL_NOT_FOUND`, …). */
export function terminalApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

type RawRecord = Record<string, unknown>

function asRecord(raw: unknown): RawRecord {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawRecord) : {}
}

/** Первое присутствующее значение из набора имён поля (camelCase/snake_case). */
function readValue(source: RawRecord, names: string[]): unknown {
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function readString(source: RawRecord, names: string[]): string | undefined {
  const value = readValue(source, names)
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: RawRecord, names: string[]): number | undefined {
  const value = readValue(source, names)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Момент времени: epoch-мс или ISO-строка → epoch-мс. */
function readTimestamp(source: RawRecord, names: string[]): number | undefined {
  const value = readValue(source, names)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const TERMINAL_STATUSES: TerminalStatus[] = ['starting', 'running', 'exited']

function readStatus(source: RawRecord): TerminalStatus | undefined {
  const value = source['status']
  return typeof value === 'string' && (TERMINAL_STATUSES as string[]).includes(value)
    ? (value as TerminalStatus)
    : undefined
}

/** Поля DTO без значения (сервер их может не присылать). */
const EMPTY_TERMINAL: TerminalDto = {
  id: '',
  projectId: '',
  sessionId: null,
  ownerId: null,
  cwd: '',
  shell: '',
  status: 'running',
  cols: 80,
  rows: 24,
  title: null,
  can_write: false,
  attached_clients: 0,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null,
  signal: null,
  target: null,
}

/**
 * Часть DTO из «сырого» объекта — **только присутствующие** поля.
 *
 * Нужна для событий шины: payload события плоский и несёт лишь несколько
 * полей (`terminal_id`, `project_id`, `status`, `cols`, `rows`, `title?`),
 * поэтому событие — это **патч**, а не замена записи.
 */
export function toTerminalPatch(raw: unknown): Partial<TerminalDto> {
  const source = asRecord(raw)
  const patch: Partial<TerminalDto> = {}

  const id = readString(source, ['id', 'terminal_id'])
  if (id !== undefined) patch.id = id
  const projectId = readString(source, ['projectId', 'project_id'])
  if (projectId !== undefined) patch.projectId = projectId
  const sessionId = readValue(source, ['sessionId', 'session_id'])
  if (sessionId !== undefined) patch.sessionId = typeof sessionId === 'string' ? sessionId : null
  const ownerId = readValue(source, ['ownerId', 'owner_id'])
  if (ownerId !== undefined) patch.ownerId = typeof ownerId === 'string' ? ownerId : null
  const cwd = readString(source, ['cwd'])
  if (cwd !== undefined) patch.cwd = cwd
  const shell = readString(source, ['shell'])
  if (shell !== undefined) patch.shell = shell
  const title = readValue(source, ['title'])
  if (title !== undefined) patch.title = typeof title === 'string' ? title : null
  const status = readStatus(source)
  if (status !== undefined) patch.status = status
  const cols = readNumber(source, ['cols'])
  if (cols !== undefined) patch.cols = cols
  const rows = readNumber(source, ['rows'])
  if (rows !== undefined) patch.rows = rows
  const canWrite = readValue(source, ['can_write'])
  if (canWrite !== undefined) patch.can_write = canWrite === true
  const attachedClients = readNumber(source, ['attached_clients'])
  if (attachedClients !== undefined) patch.attached_clients = attachedClients
  const createdAt = readTimestamp(source, ['createdAt', 'created_at'])
  if (createdAt !== undefined) patch.createdAt = createdAt
  const lastActivityAt = readTimestamp(source, ['lastActivityAt', 'last_activity_at'])
  if (lastActivityAt !== undefined) patch.lastActivityAt = lastActivityAt
  const exitCode = readValue(source, ['exitCode', 'exit_code'])
  if (exitCode !== undefined) patch.exitCode = typeof exitCode === 'number' ? exitCode : null
  const signal = readValue(source, ['signal'])
  if (signal !== undefined) patch.signal = typeof signal === 'string' ? signal : null
  const target = readValue(source, ['target'])
  if (target !== undefined) patch.target = typeof target === 'string' ? target : null
  return patch
}

/** DTO терминала из ответа сервера (camelCase и snake_case равнозначны). */
export function toTerminalDto(raw: unknown): TerminalDto {
  return { ...EMPTY_TERMINAL, ...toTerminalPatch(raw) }
}

/** Ответ сервера на одну сущность: обёртка `{ terminal }` либо сам DTO. */
function terminalFromResponse(response: unknown): TerminalDto {
  const source = asRecord(response)
  const wrapped = source['terminal']
  return toTerminalDto(wrapped ?? source)
}

/** Кадр NDJSON: `{seq, data, exit_code?, signal?}`. */
function parseTerminalFrame(line: string): TerminalStreamFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // Битый кадр — поток не должен из-за него падать.
    return null
  }
  const source = asRecord(parsed)
  const seq = typeof source['seq'] === 'number' ? source['seq'] : 0
  const data = typeof source['data'] === 'string' ? source['data'] : ''
  const exitCode = typeof source['exit_code'] === 'number' ? source['exit_code'] : undefined
  const signal = typeof source['signal'] === 'string' ? source['signal'] : undefined
  return {
    seq,
    data,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }
}

/** Разбор NDJSON-потока: буфер на неполные строки. */
export interface TerminalFrameParser {
  /** Добавить кусок потока (строка может быть разрезана). */
  push: (chunk: string) => void
  /** Обработать неполную последнюю строку (конец потока). */
  flush: () => void
}

export function createTerminalFrameParser(
  onFrame: (frame: TerminalStreamFrame) => void,
): TerminalFrameParser {
  let buffer = ''
  const handle = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const frame = parseTerminalFrame(trimmed)
    if (frame) onFrame(frame)
  }
  return {
    push: (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        handle(line)
        index = buffer.indexOf('\n')
      }
    },
    flush: () => {
      const rest = buffer
      buffer = ''
      handle(rest)
    },
  }
}

/** Ошибка потока — как у `fetchJSON`: `status` + машинный `code`. */
async function terminalStreamError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null)
  const error = asRecord(asRecord(body)['error'])
  const message =
    typeof error['message'] === 'string' ? error['message'] : `HTTP ${response.status}`
  const code = typeof error['code'] === 'string' ? error['code'] : undefined
  return Object.assign(new Error(message), { status: response.status, code })
}

export const terminalsApi = {
  /** GET /terminals — список терминалов (постраничный). */
  async list(options?: TerminalListOptions): Promise<TerminalListPage> {
    const params = new URLSearchParams()
    if (options?.projectId) params.set('project_id', options.projectId)
    if (options?.sessionId) params.set('session_id', options.sessionId)
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    const query = params.toString()
    const response = await fetchJSON<TerminalListResponse | unknown[]>(
      `${BASE_URL}/terminals${query ? `?${query}` : ''}`,
    )
    // Старый сервер мог отдавать «голый» массив — приводим к странице.
    if (Array.isArray(response)) {
      const terminals = response.map(toTerminalDto)
      return {
        terminals,
        total: terminals.length,
        offset: 0,
        limit: terminals.length,
        nextOffset: null,
      }
    }
    const items = Array.isArray(response?.terminals) ? response.terminals : []
    const terminals = items.map(toTerminalDto)
    const total = typeof response?.total === 'number' ? response.total : terminals.length
    const offset = typeof response?.offset === 'number' ? response.offset : 0
    const limit = typeof response?.limit === 'number' ? response.limit : terminals.length
    const next = response?.next_offset
    return {
      terminals,
      total,
      offset,
      limit,
      nextOffset: typeof next === 'number' ? next : null,
    }
  },

  /** GET /terminals/:id — снимок терминала. */
  async get(id: string): Promise<TerminalDto> {
    const response = await fetchJSON<TerminalResponse>(
      `${BASE_URL}/terminals/${encodeURIComponent(id)}`,
    )
    return terminalFromResponse(response)
  },

  /** POST /terminals — создать терминал (PTY поднимается на точке исполнения). */
  async create(input: CreateTerminalInput): Promise<TerminalDto> {
    const body: Record<string, unknown> = { project_id: input.projectId }
    if (input.sessionId !== undefined) body.session_id = input.sessionId
    if (input.shell !== undefined) body.shell = input.shell
    if (input.cols !== undefined) body.cols = input.cols
    if (input.rows !== undefined) body.rows = input.rows
    if (input.title !== undefined) body.title = input.title
    const response = await fetchJSON<TerminalResponse>(`${BASE_URL}/terminals`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return terminalFromResponse(response)
  },

  /** POST /terminals/:id/input — ввод пользователя (байты PTY). */
  async input(id: string, data: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/terminals/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    })
  },

  /** POST /terminals/:id/resize — новая геометрия (cols/rows). */
  async resize(id: string, cols: number, rows: number): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/terminals/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    })
  },

  /** PATCH /terminals/:id — переименование / привязка к сессии. */
  async update(id: string, patch: TerminalPatch): Promise<TerminalDto> {
    const response = await fetchJSON<TerminalResponse>(
      `${BASE_URL}/terminals/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
    return terminalFromResponse(response)
  },

  /** DELETE /terminals/:id — закрыть терминал. */
  async close(id: string): Promise<void> {
    await fetchJSON<void>(`${BASE_URL}/terminals/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** GET /terminals/:id/output?since= — догон вывода по курсору. */
  async outputSince(id: string, seq: number): Promise<TerminalOutputSnapshot> {
    const params = new URLSearchParams()
    params.set('since', String(seq))
    const response = await fetchJSON<TerminalOutputResponse>(
      `${BASE_URL}/terminals/${encodeURIComponent(id)}/output?${params.toString()}`,
    )
    const source = asRecord(response)
    const first = typeof source['seq'] === 'number' ? source['seq'] : seq
    const next = source['next_seq']
    return {
      data: typeof source['data'] === 'string' ? source['data'] : '',
      seq: first,
      nextSeq: typeof next === 'number' ? next : first,
      truncated: source['truncated'] === true,
      totalBytes: typeof source['total_bytes'] === 'number' ? source['total_bytes'] : 0,
      droppedBytes:
        typeof source['dropped_bytes'] === 'number' ? source['dropped_bytes'] : 0,
    }
  },

  /**
   * GET /terminals/:id/stream?since=N — поток вывода NDJSON.
   *
   * Сервер сначала отдаёт replay из кольцевого буфера (`seq > since`), затем
   * живой вывод; кадр выхода несёт `exit_code`/`signal`. Поток читается
   * построчно (`reader` + `TextDecoder`), отмена — через `AbortController`.
   */
  async streamTerminal(id: string, options: TerminalStreamOptions): Promise<void> {
    const params = new URLSearchParams()
    params.set('since', String(options.since ?? 0))
    const response = await fetch(`${BASE_URL}/terminals/${encodeURIComponent(id)}/stream?${params.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'application/x-ndjson' },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) throw await terminalStreamError(response)
    const body = response.body
    if (!body) return
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = createTerminalFrameParser((frame) => {
      if (frame.exitCode !== undefined || frame.signal !== undefined) {
        options.onExit?.({
          ...(frame.exitCode !== undefined ? { exitCode: frame.exitCode } : {}),
          ...(frame.signal !== undefined ? { signal: frame.signal } : {}),
        })
        return
      }
      options.onChunk({ seq: frame.seq, data: frame.data })
    })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      // Хвост декодера и неполная последняя строка.
      parser.push(decoder.decode())
      parser.flush()
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Поток уже закрыт.
      }
    }
  },
}
