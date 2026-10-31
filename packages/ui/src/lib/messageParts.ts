// ADR-118: рендер сообщения по частям.
//
// Части приходят двумя путями:
// - `Part[]` в DTO сообщения (`GET /sessions/:id/messages`) — `{id, type, data}`;
// - живое состояние (`part.delta`/`part.updated`) — накопленный текст части.
//
// Идентификаторы частей детерминированные (ADR-118 §1): текст —
// `msg:text:<ordinal>`, вызов инструмента — `callId`. Порядок частей внутри
// сообщения — по порядковому номеру текстовой части, остальные — по id.

import type { Part, PartType } from '@itphx/synth-shared/types'
import type {
  IntermediateTextBlockData,
  LivePart,
  LiveToolCall,
  MessageData,
  ReasoningBlockData,
} from '@/stores/chatStore'

/** Идентификатор текстовой части (`msg:text:<ordinal>`). */
export const TEXT_PART_PREFIX = 'msg:text:'

/** Порядковый номер текстовой части по её id; `null` — не текстовая. */
export function textPartOrdinal(partId: string): number | null {
  if (!partId.startsWith(TEXT_PART_PREFIX)) return null
  const n = Number.parseInt(partId.slice(TEXT_PART_PREFIX.length), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Текст части: строковые данные (`makeTextPart`) или объект `{text}` —
 * обе формы встречаются в DTO.
 */
export function partText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const text = (data as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

/**
 * Есть ли у сообщения контент (ADR-118 §5).
 *
 * Пустое живое сообщение шага (`content: ''`, `parts: []`) контентом **не**
 * считается: по нему индикатор «идёт» должен жить у реплики пользователя, а
 * не в пустом сегменте ответа.
 */
export function messageHasContent(message: MessageData): boolean {
  if (typeof message.content === 'string' && message.content.trim() !== '') return true
  for (const part of message.parts ?? []) {
    if (!part) continue
    if (partText(part.data).trim() !== '') return true
    // Нетекстовая часть (вызов тула, медиа) — тоже контент.
    if (part.type !== 'text' && part.type !== 'reasoning') return true
  }
  return false
}

/**
 * Признаки хода, нужные предикату «контент хода уже был» (ADR-118 §5).
 *
 * Структурный тип (не `ActiveTurn`): хелпер не должен тянуть стор в
 * `lib/` — наоборот, `lib/messageParts` уже знает только типы сообщений.
 */
export interface TurnContentProbe {
  /** Id хода (`turn_id` сообщений хода). */
  turnId?: string | null
  /** Id сообщения текущего шага (живое сообщение хода). */
  messageId?: string | null
  /** Флаг «контент хода начался» (живой ход, ADR-118 §5). */
  contentStarted?: boolean
}

/**
 * Контент хода уже был? (ADR-118 §5) — **единый предикат**.
 *
 * До первой части ответа индикатор «идёт» живёт у реплики пользователя,
 * после — в живом сегменте ответа (или в строке активности хода). Признак:
 *
 * - ход помечен флагом `contentStarted` (живой ход: пришла первая часть);
 * - либо у хода есть assistant-сообщение с непустыми частями/текстом/вызовом
 *   инструмента — после перезагрузки флага в сторе нет, контент считается по
 *   истории (сообщения хода адресуются по `turn_id`, живое сообщение шага —
 *   по `messageId`).
 *
 * `fallback` — сообщение шага, если оно не адресуется по `turn_id` (например,
 * при восстановлении хода по `current_stream`).
 */
export function turnHasContent(
  messages: MessageData[],
  turn: TurnContentProbe | null | undefined,
  fallback?: MessageData | null,
): boolean {
  if (!turn) return false
  if (turn.contentStarted === true) return true
  const turnId = turn.turnId
  const messageId = turn.messageId
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const belongsToTurn =
      (!!turnId && message.turn_id === turnId) || (!!messageId && message.id === messageId)
    if (!belongsToTurn) continue
    if (messageHasContent(message)) return true
  }
  if (fallback && messageHasContent(fallback)) return true
  return false
}

/** Часть → «живая» форма (накопленный текст + структурные данные). */
export function toLivePart(part: Part): LivePart {
  return {
    id: part.id,
    type: part.type,
    text: partText(part.data),
    data: part.data,
    ...(part.metadata ? { metadata: part.metadata } : {}),
  }
}

/**
 * Порядок частей внутри сообщения: текстовые — по порядковому номеру
 * (`msg:text:<ordinal>`), остальные — после текстовых, по id (стабильно).
 */
export function sortLiveParts(parts: LivePart[]): LivePart[] {
  return [...parts].sort((a, b) => {
    const ao = textPartOrdinal(a.id)
    const bo = textPartOrdinal(b.id)
    if (ao !== null && bo !== null) return ao - bo
    if (ao !== null) return -1
    if (bo !== null) return 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Сырой вызов провайдера (`{type:'function', function:{name, arguments}}`) →
 * форма частей UI (`{name, args}`).
 *
 * Иначе live-карточка тула остаётся без имени («unknown»): имя тула лежит в
 * `function.name`, а аргументы — в `function.arguments` (JSON-строка).
 *
 * Нормализация выполняется **внутри** `buildPartsView` — любой вызов сборки
 * даёт карточку с именем тула (вызывать её вручную не нужно).
 */
export function normalizeLiveToolPart(part: LivePart): LivePart {
  if (part.type !== 'tool_use') return part
  const d = (part.data ?? {}) as Record<string, unknown>
  const fn = d.function as { name?: unknown; arguments?: unknown } | undefined
  if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return part
  let args = (d.args as Record<string, unknown>) ?? {}
  if (typeof fn.arguments === 'string' && fn.arguments.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(fn.arguments)
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
    } catch {
      // Аргументы не JSON — оставляем как есть.
    }
  }
  return { ...part, data: { ...d, name: fn.name, args } }
}

/** Часть `tool_use` → инструментальный вызов (для рендера `ToolCallPart`). */
export function partToToolCall(part: LivePart): LiveToolCall | null {
  if (part.type !== 'tool_use') return null
  const d = (part.data ?? {}) as Record<string, unknown>
  const name = typeof d.name === 'string' ? d.name : 'unknown'
  const args = (d.args as Record<string, unknown>) || {}
  const rawResult = d.result as
    | { content: string; isError?: boolean; metadata?: Record<string, unknown> }
    | undefined
  const status = d.status === 'done' || rawResult ? 'done' : 'running'
  return {
    callId: part.id,
    name,
    args,
    status,
    result: rawResult,
    startedAt: typeof d.startedAt === 'string' ? d.startedAt : '',
    completedAt: typeof d.completedAt === 'string' ? d.completedAt : undefined,
    iteration: typeof d.iteration === 'number' ? d.iteration : 0,
    parentCallId: typeof d.parentCallId === 'string' ? d.parentCallId : undefined,
    // Живой прогресс саб-агента (ADR-111/ADR-070): размышления и промежуточный
    // текст приходят дельтами в данные части `task` и должны попасть в
    // карточку. Без этого синхронный саб-агент в основной сессии показывал
    // только PROMPT: `getSubagentData` читал результат, а результата ещё нет.
    subagentReasoningBlocks: d.subagentReasoningBlocks as ReasoningBlockData[] | undefined,
    subagentIntermediateTextBlocks: d.subagentIntermediateTextBlocks as IntermediateTextBlockData[] | undefined,
  }
}

/** Часть `tool_result` → результат вызова инструмента. */
export function partToToolResult(
  part: LivePart,
): { callId: string; content: string; isError?: boolean; metadata?: Record<string, unknown> } | null {
  if (part.type !== 'tool_result') return null
  const d = (part.data ?? {}) as Record<string, unknown>
  const callId =
    (typeof d.tool_use_id === 'string' && d.tool_use_id) ||
    (typeof d.toolCallId === 'string' && d.toolCallId) ||
    part.id
  return {
    callId,
    content: typeof d.content === 'string' ? d.content : '',
    ...(typeof d.isError === 'boolean' ? { isError: d.isError } : {}),
    ...(d.metadata && typeof d.metadata === 'object'
      ? { metadata: d.metadata as Record<string, unknown> }
      : {}),
  }
}

/**
 * Live-части для рендера сообщения.
 *
 * - **во время шага** (`status: 'streaming'`) — источник истины;
 * - у **финального** сообщения:
 *   - пока части из истории не пришли (окно между `step.finished` и ответом
 *     `GET /messages`) — live-части остаются фоллбеком, иначе текст, который
 *     пользователь уже видел, исчезал бы на миг (ADR-118 §5);
 *   - когда части из истории пришли — текст и рассуждения берутся **только**
 *     из dto: id частей `msg:text:<ordinal>` совпадают у разных шагов, и
 *     «застрявшие» live-части давали бы в блоке хода текст чужого шага;
 *     а **tool-части** (id = `callId`, коллизий с `msg:text:*`/`msg:reasoning:*`
 *     нет) мержутся с dto-частими по `id` — карточки инструментов шага не
 *     должны пропадать между `step.finished` и приходом истории (ядро
 *     публикует `step.finished` до запуска тулов, результат приходит позже
 *     через `tool_call.result`).
 */
export function resolveLiveParts(
  liveParts: LivePart[] | undefined,
  opts: { isLive: boolean; dtoParts?: Part[] | null },
): LivePart[] | undefined {
  if (!liveParts || liveParts.length === 0) return undefined
  if (opts.isLive) return liveParts
  const dtoParts = opts.dtoParts ?? []
  if (dtoParts.length === 0) return liveParts
  // Финальное сообщение: текст/reasoning — только из dto, tool-части — мерж.
  // Live-часть вызова **важнее** dto-снимка того же вызова: dto сохраняется
  // на финале шага (до запуска тула), а результат приходит позже
  // (`tool_call.result`) и живёт только в live-части.
  const toolParts = liveParts.filter(
    (part) => part.type === 'tool_use' || part.type === 'tool_result',
  )
  return toolParts.length > 0 ? toolParts : undefined
}

/** Представление сообщения по частям (ADR-118 §1). */
export interface PartsView {
  /** Итоговый текст сообщения (текстовые части по порядку). */
  text: string
  /** Блоки рассуждений (части `reasoning`). */
  reasoning: ReasoningBlockData[]
  /** Инструментальные вызовы (части `tool_use` + результаты `tool_result`). */
  toolCalls: LiveToolCall[]
  /** Медиа-части (вложения) — по id сообщения не меняются. */
  media: Part[]
}

/**
 * Запасные источники содержимого — для сообщений, у которых части ещё не
 * пришли (история до ADR-118): текст в `content`, рассуждения в
 * `reasoning_blocks`, вызовы инструментов в `tool_calls`.
 */
export interface PartsFallback {
  content?: string | null
  reasoningBlocks?: ReasoningBlockData[] | null
  toolCalls?: LiveToolCall[] | null
}

/**
 * Собрать представление сообщения по частям.
 *
 * `live` — накопленное живое состояние (ADR-118 §4), `dto` — части из DTO.
 * Живые части имеют приоритет: они — источник истины для ст��мящего хода.
 * Если частей нет — берётся запасной источник (история до ADR-118).
 */
export function buildPartsView(
  dto: Part[] | null | undefined,
  live?: LivePart[],
  fallback?: PartsFallback,
): PartsView {
  const merged = new Map<string, LivePart>()
  for (const part of dto ?? []) merged.set(part.id, toLivePart(part))
  for (const part of live ?? []) merged.set(part.id, { ...merged.get(part.id), ...part })

  // Нормализация вызова провайдера → `{name, args}` — **внутри** сборки:
  // карточка инструмента всегда с именем, независимо от источника части
  // (dto или live).
  const ordered = sortLiveParts([...merged.values()].map(normalizeLiveToolPart))

  const textParts: LivePart[] = []
  const reasoning: ReasoningBlockData[] = []
  const toolParts: LivePart[] = []
  const resultParts: LivePart[] = []
  const media: Part[] = []

  for (const part of ordered) {
    switch (part.type as PartType) {
      case 'text':
        textParts.push(part)
        break
      case 'reasoning':
        reasoning.push({ text: part.text, iteration: reasoning.length })
        break
      case 'tool_use':
        toolParts.push(part)
        break
      case 'tool_result':
        resultParts.push(part)
        break
      case 'image':
      case 'audio':
      case 'video':
      case 'file':
        media.push({ id: part.id, type: part.type, data: part.data })
        break
      default:
        break
    }
  }

  // Текстовые части склеиваются в порядке ordinal (ADR-118 §1).
  const text = textParts.length > 0
    ? textParts.map((p) => p.text).join('\n\n')
    : (fallback?.content ?? '')

  const reasoningBlocks = reasoning.length > 0
    ? reasoning
    : (fallback?.reasoningBlocks ?? [])

  const calls = toolParts.map((part) => partToToolCall(part)).filter((c): c is LiveToolCall => c !== null)
  for (const result of resultParts) {
    const parsed = partToToolResult(result)
    if (!parsed) continue
    const target = calls.find((c) => c.callId === parsed.callId)
    if (target) {
      target.result = { content: parsed.content, isError: parsed.isError, metadata: parsed.metadata }
      target.status = 'done'
      target.completedAt = target.completedAt ?? new Date().toISOString()
    }
  }
  if (calls.length === 0 && fallback?.toolCalls) {
    calls.push(...fallback.toolCalls)
  }

  return { text, reasoning: reasoningBlocks, toolCalls: calls, media }
}
