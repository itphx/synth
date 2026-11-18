// subagentRunsStore: ленивая догрузка шагов фонового саб-агента (ADR-111).
//
// У фонового прогона (`task` с `background: true`) тул возвращает управление
// сразу: в `result.metadata` есть только `child_session_id`/`status`/
// `background_run_id` — шагов (`tool_calls`/`steps`) в нём нет, и в
// родительский стрим они не публикуются (ADR-111: «публикация в родительский
// стрим отключается»).
//
// Источник шагов — **история дочерней сессии**, собранная по всем сообщениям:
// каждый assistant-шаг несёт вызовы **своей** итерации в `metadata.tool_results`
// (DTO — `tool_calls`), свой `reasoning` и свой текст в `content`; сообщение
// отчёта (`metadata.status`) — только финальный текст (агрегата в нём больше
// нет). Старые записи (до этого контракта) держали агрегат в финальном
// сообщении — для них сохранён фоллбэк «как раньше».
//
// Инварианты:
//   - шаги не дублируются в историю родителя (ADR-118: один источник
//     сообщений) — карточка в ленте родителя ссылается на историю ребёнка;
//   - загрузка ленивая: по раскрытию карточки и по терминальному статусу
//     прогона (`processesStore`), а не «всегда на каждое сообщение»;
//   - конкурентные вызовы `ensure` не шлют второй запрос;
//   - ошибка загрузки (403/404/сеть) — состояние `error` с текстом, без
//     бесконечных ретраев.

import { create } from 'zustand'

import { synthApi } from '@/lib/api/synthApi'
import type { MessageData } from '@/stores/chatStore'

/** Вызов инструмента внутри саб-агента (форма карточки `SubagentPart`). */
export interface SubagentRunToolCall {
  name: string
  args: Record<string, unknown>
  id?: string
  result?: { content: string; isError?: boolean }
  started_at?: string
  completed_at?: string
  iteration: number
}

/** Блок размышлений ребёнка (итерация — по порядку блоков). */
export interface SubagentRunReasoningBlock {
  text: string
  iteration: number
}

/** Промежуточный текст ребёнка (итерация — из `metadata`). */
export interface SubagentRunTextBlock {
  text: string
  iteration: number
}

/** Шаги фонового саб-агента, собранные из истории дочерней сессии. */
export interface SubagentRunData {
  /** Вызовы инструментов ребёнка (по итерациям). */
  toolCalls: SubagentRunToolCall[]
  /** Размышления ребёнка (тексты блоков). */
  reasoningBlocks: SubagentRunReasoningBlock[]
  /** Промежуточные тексты ребёнка. */
  intermediateTextBlocks: SubagentRunTextBlock[]
  /**
   * Финальный ответ ребёнка.
   *
   * В карточке фонового прогона он **не рисуется**: родитель и так получает
   * итог прогона отдельным уведомлением (`metadata.type='background_run_result'`)
   * — тот же текст в ленте дважды был бы дублем.
   */
  finalContent: string
  /** Число шагов (`max(iteration)+1` по вызовам) — для бейджа карточки. */
  steps?: number
}

/** Состояние загрузки шагов по дочерней сессии. */
export type SubagentRunStatus = 'loading' | 'ready' | 'error'

/** Запись стора по дочерней сессии. */
export interface SubagentRunEntry {
  status: SubagentRunStatus
  data?: SubagentRunData
  error?: string
}

interface SubagentRunsState {
  /** Записи по id дочерней сессии. */
  byChild: Record<string, SubagentRunEntry>
  /** Загрузить шаги (если записи нет или она в `error`). */
  ensure: (childSessionId: string) => Promise<void>
  /** Сбросить кэш записи (следующий `ensure` перезагрузит). */
  invalidate: (childSessionId: string) => void
  /** Очистить стор целиком (тесты). */
  clear: () => void
}

/** Разделитель блоков размышлений (совпадает с разделителем в ядре). */
const REASONING_SEPARATOR = '\n\n---\n\n'

/**
 * Вызов инструмента → форма карточки.
 *
 * Поддерживаются две формы:
 *   - нормализованная (`metadata.tool_results` шага/отчёта ребёнка):
 *     `{name, args, iteration, result}` — с результатом вызова;
 *   - сырая провайдера (`{type:'function', function:{name, arguments}}`) —
 *     промежуточные шаги ребёнка в истории.
 *
 * `fallbackIteration` — номер шага сообщения (`step_index`): у вызовов нового
 * вида `iteration` есть всегда, у старых записей — не обязательно.
 */
function normalizeToolCalls(raw: unknown, fallbackIteration?: number): SubagentRunToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: SubagentRunToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    let name = typeof rec.name === 'string' && rec.name !== '' ? rec.name : undefined
    let args: Record<string, unknown> =
      rec.args && typeof rec.args === 'object' ? (rec.args as Record<string, unknown>) : {}
    if (!name) {
      const fn = rec.function as { name?: unknown; arguments?: unknown } | undefined
      if (fn && typeof fn.name === 'string' && fn.name !== '') {
        name = fn.name
        if (typeof fn.arguments === 'string' && fn.arguments.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(fn.arguments)
            if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
          } catch {
            // не JSON — оставляем пустые аргументы
          }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = fn.arguments as Record<string, unknown>
        }
      }
    }
    if (!name) continue
    const result = rec.result as { content?: unknown; isError?: unknown } | undefined
    out.push({
      name,
      args,
      ...(typeof rec.id === 'string' ? { id: rec.id } : {}),
      ...(result && typeof result.content === 'string'
        ? { result: { content: result.content, isError: result.isError === true } }
        : {}),
      ...(typeof rec.started_at === 'string' ? { started_at: rec.started_at } : {}),
      ...(typeof rec.completed_at === 'string' ? { completed_at: rec.completed_at } : {}),
      iteration: typeof rec.iteration === 'number' && Number.isFinite(rec.iteration)
        ? rec.iteration
        : (fallbackIteration ?? 0),
    })
  }
  return out
}

/**
 * Размышления ребёнка: текст сообщения → блоки.
 *
 * Разделитель — как у сообщений в ленте (`getReasoningBlocks` в
 * `ChatMessage.tsx`); номер блока — `step_index` сообщения (итерация), иначе
 * порядковый номер.
 */
function splitReasoning(
  reasoning: string | null | undefined,
  iterationFor: (ordinal: number) => number = (i) => i,
): SubagentRunReasoningBlock[] {
  if (!reasoning) return []
  return reasoning.split(REASONING_SEPARATOR).map((text, i) => ({
    text,
    iteration: iterationFor(i),
  }))
}

/** Промежуточные тексты ребёнка из `metadata.intermediate_text_blocks`. */
function normalizeTextBlocks(raw: unknown): SubagentRunTextBlock[] {
  if (!Array.isArray(raw)) return []
  const out: SubagentRunTextBlock[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.text !== 'string') continue
    out.push({
      text: rec.text,
      iteration: typeof rec.iteration === 'number' && Number.isFinite(rec.iteration) ? rec.iteration : 0,
    })
  }
  return out
}

/**
 * Отчёт прогона (финальное assistant-сообщение ребёнка).
 *
 * Отчёт несёт `metadata.status` (его ставит жизненный цикл дочерней сессии);
 * шаги — нет. Если отчёта ещё нет (прогон идёт), берётся последнее
 * assistant-сообщение — но **отчётом** оно не считается (это шаг).
 */
function pickFinalAssistantMessage(messages: MessageData[]): MessageData | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    if (typeof message.metadata?.status === 'string') return message
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') return messages[i]
  }
  return undefined
}

/** Номер шага сообщения: `step_index`, иначе порядковый номер. */
function stepIteration(message: MessageData, ordinal: number): number {
  const index = message.step_index
  return typeof index === 'number' && Number.isFinite(index) ? index : ordinal
}

/** Вызовы **своего** шага (новый вид записи) — только `metadata.tool_results`. */
function stepToolCalls(message: MessageData, ordinal: number): SubagentRunToolCall[] {
  const raw = message.metadata?.tool_results
  if (!Array.isArray(raw) || raw.length === 0) return []
  return normalizeToolCalls(raw, stepIteration(message, ordinal))
}

/** Дедупликация вызовов по `id` (страховка от старых дублей/агрегата в финале). */
function dedupeToolCalls(calls: SubagentRunToolCall[]): SubagentRunToolCall[] {
  const seen = new Set<string>()
  const out: SubagentRunToolCall[] = []
  for (const call of calls) {
    if (call.id) {
      if (seen.has(call.id)) continue
      seen.add(call.id)
    }
    out.push(call)
  }
  return out
}

/** `metadata.steps`/`metadata.result.steps` отчёта — фоллбэк бейджа. */
function metadataSteps(message: MessageData | undefined): number | undefined {
  const meta = message?.metadata
  if (!meta) return undefined
  const direct = meta.steps
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const nested = meta.result
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>).steps
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Шаги ребёнка из DTO его истории.
 *
 * Новый вид записи: шаги несут собственные `metadata.tool_results`/`reasoning`/
 * `content`, отчёт — только финальный текст. Старый (legacy): агрегат лежит в
 * финальном сообщении (`tool_calls`, `reasoning`, `intermediate_text_blocks`) —
 * для каждого списка сохранён фоллбэк «как раньше», смешивание без дублей.
 */
export function buildSubagentRunData(messages: MessageData[]): SubagentRunData {
  const final = pickFinalAssistantMessage(messages)
  // Отчёт — только сообщение со `metadata.status`; если прогон ещё идёт,
  // «финальное» сообщение — обычный шаг (его вызовы тоже нужны).
  const report = typeof final?.metadata?.status === 'string' ? final : undefined

  // 1. Вызовы: из шагов в порядке истории, затем агрегат отчёта (legacy/микс).
  const stepCalls: SubagentRunToolCall[] = []
  let stepOrdinal = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (report && message === report) continue
    const calls = stepToolCalls(message, stepOrdinal)
    if (calls.length > 0) stepCalls.push(...calls)
    stepOrdinal += 1
  }
  // DTO отдаёт вызовы отчёта полем `tool_calls` (ядро берёт их из
  // `metadata.tool_results`) — форма совпадает с `SubagentPartData['tool_calls']`.
  const toolCalls = dedupeToolCalls([...stepCalls, ...normalizeToolCalls(report?.tool_calls)])

  // 2. Размышления: из шагов (итерация — `step_index`); у legacy-записей —
  // склейка в отчёте с порядковой нумерацией, как раньше.
  const reasoningBlocks: SubagentRunReasoningBlock[] = []
  const seenReasoning = new Set<string>()
  const pushReasoning = (blocks: SubagentRunReasoningBlock[]) => {
    for (const block of blocks) {
      const key = `${block.iteration}\u0000${block.text}`
      if (seenReasoning.has(key)) continue
      seenReasoning.add(key)
      reasoningBlocks.push(block)
    }
  }
  let reasoningOrdinal = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.reasoning) continue
    if (report && message === report) continue
    const iteration = stepIteration(message, reasoningOrdinal)
    reasoningOrdinal += 1
    pushReasoning(splitReasoning(message.reasoning, () => iteration))
  }
  if (reasoningBlocks.length === 0) {
    // Legacy: весь reasoning прогона склеен в отчёте.
    pushReasoning(splitReasoning(report?.reasoning))
  } else if (report?.reasoning) {
    // Новый вид: отчёт несёт reasoning последней итерации (без дублей).
    const iteration = stepIteration(report, reasoningOrdinal)
    pushReasoning(splitReasoning(report.reasoning, () => iteration))
  }

  // 3. Промежуточные тексты: все шаги, кроме отчёта; legacy-агрегат из
  // `metadata.intermediate_text_blocks` дополняет список без дублей.
  const intermediateTextBlocks: SubagentRunTextBlock[] = []
  const seenTexts = new Set<string>()
  const pushText = (block: SubagentRunTextBlock) => {
    if (seenTexts.has(block.text)) return
    seenTexts.add(block.text)
    intermediateTextBlocks.push(block)
  }
  let textOrdinal = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (report && message === report) continue
    const iteration = stepIteration(message, textOrdinal)
    textOrdinal += 1
    if (typeof message.content === 'string' && message.content.trim() !== '') {
      pushText({ text: message.content, iteration })
    }
  }
  for (const block of normalizeTextBlocks(report?.metadata?.intermediate_text_blocks)) {
    pushText(block)
  }

  // 4. Число шагов — `max(iteration)+1` по вызовам, иначе из метаданных отчёта.
  const steps =
    toolCalls.length > 0
      ? Math.max(...toolCalls.map((call) => call.iteration || 0)) + 1
      : metadataSteps(report)

  return {
    toolCalls,
    reasoningBlocks,
    intermediateTextBlocks,
    finalContent: final?.content ?? '',
    ...(steps !== undefined ? { steps } : {}),
  }
}

/** Загрузка шагов ребёнка (история его сессии). */
async function loadSubagentRun(childSessionId: string): Promise<SubagentRunData> {
  const response = await synthApi.getSessionMessages(childSessionId)
  return buildSubagentRunData(response.messages ?? [])
}

export const useSubagentRunsStore = create<SubagentRunsState>()((set, get) => {
  /**
   * Поколение загрузки по дочерней сессии: ответ устаревшей загрузки не
   * должен затирать результат более свежей (`invalidate` → `ensure`).
   */
  const generations = new Map<string, number>()

  return {
    byChild: {},

    ensure: async (childSessionId: string) => {
      if (!childSessionId) return
      const entry = get().byChild[childSessionId]
      // `ready` — кэш валиден, `loading` — запрос уже идёт (дедуп).
      if (entry && entry.status !== 'error') return
      const generation = (generations.get(childSessionId) ?? 0) + 1
      generations.set(childSessionId, generation)
      set((state) => ({
        byChild: { ...state.byChild, [childSessionId]: { status: 'loading' } },
      }))
      try {
        const data = await loadSubagentRun(childSessionId)
        if (generations.get(childSessionId) !== generation) return
        set((state) => ({
          byChild: { ...state.byChild, [childSessionId]: { status: 'ready', data } },
        }))
      } catch (err) {
        if (generations.get(childSessionId) !== generation) return
        set((state) => ({
          byChild: {
            ...state.byChild,
            [childSessionId]: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            },
          },
        }))
      }
    },

    invalidate: (childSessionId: string) => {
      if (!childSessionId) return
      // Ответ уже идущей загрузки больше не применим (он устарел).
      generations.set(childSessionId, (generations.get(childSessionId) ?? 0) + 1)
      set((state) => {
        const byChild = { ...state.byChild }
        delete byChild[childSessionId]
        return { byChild }
      })
    },

    clear: () => {
      generations.clear()
      set({ byChild: {} })
    },
  }
})
