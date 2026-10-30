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
import type { LivePart, LiveToolCall, ReasoningBlockData } from '@/stores/chatStore'

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
 * - у **финального** сообщения — фоллбек, пока части из истории не пришли
 *   (окно между `step.finished` и ответом `GET /messages`): части DTO ещё
 *   пусты, и без фоллбэка текст, который пользователь уже видел, исчезал бы
 *   на миг (ADR-118 §5).
 *
 * Как только у сообщения есть части из истории, live-части не используются:
 * id частей `msg:text:<ordinal>` совпадают у разных шагов, и «застрявшие»
 * live-части давали бы в блоке хода текст чужого шага.
 */
export function resolveLiveParts(
  liveParts: LivePart[] | undefined,
  opts: { isLive: boolean; dtoParts?: Part[] | null },
): LivePart[] | undefined {
  if (!liveParts || liveParts.length === 0) return undefined
  if (opts.isLive) return liveParts
  return (opts.dtoParts?.length ?? 0) > 0 ? undefined : liveParts
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

  const ordered = sortLiveParts([...merged.values()])

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
