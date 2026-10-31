// subagentRunsStore: ленивая догрузка шагов фонового саб-агента (ADR-111).
//
// У фонового прогона (`task` с `background: true`) тул возвращает управление
// сразу: в `result.metadata` есть только `child_session_id`/`status`/
// `background_run_id` — шагов (`tool_calls`/`steps`) в нём нет, и в
// родительский стрим они не публикуются (ADR-111: «публикация в родительский
// стрим отключается»).
//
// Источник шагов — **история дочерней сессии**: её финальное assistant-сообщение
// несёт `metadata.tool_results` (вызовы ребёнка по итерациям) и
// `metadata.intermediate_text_blocks`. Ядро не меняется — UI читает то, что
// уже есть в DTO (`GET /api/v2/sessions/:id/messages`).
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
 *   - нормализованная (`metadata.tool_results` финального сообщения ребёнка):
 *     `{name, args, iteration, result}` — с результатом вызова;
 *   - сырая провайдера (`{type:'function', function:{name, arguments}}`) —
 *     промежуточные шаги ребёнка в истории.
 */
function normalizeToolCalls(raw: unknown): SubagentRunToolCall[] {
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
      iteration: typeof rec.iteration === 'number' && Number.isFinite(rec.iteration) ? rec.iteration : 0,
    })
  }
  return out
}

/**
 * Размышления ребёнка: текст финального сообщения → блоки.
 *
 * Разделитель и нумерация — как у сообщений в ленте (`getReasoningBlocks` в
 * `ChatMessage.tsx`): отдельная итерация блока размышлений в DTO не
 * сохраняется, поэтому номер — порядковый.
 */
function splitReasoning(reasoning: string | null | undefined): SubagentRunReasoningBlock[] {
  if (!reasoning) return []
  return reasoning.split(REASONING_SEPARATOR).map((text, i) => ({ text, iteration: i }))
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
 * Финальное assistant-сообщение ребёнка.
 *
 * Отчёт прогона несёт `metadata.status` (его ставит жизненный цикл дочерней
 * сессии); промежуточные шаги — нет. Если отчёта ещё нет (прогон идёт),
 * берётся последнее assistant-сообщение (частичные шаги).
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

/** Шаги ребёнка из DTO его истории. */
export function buildSubagentRunData(messages: MessageData[]): SubagentRunData {
  const final = pickFinalAssistantMessage(messages)
  // DTO отдаёт вызовы ребёнка полем `tool_calls` (ядро берёт их из
  // `metadata.tool_results` финального сообщения) — форма совпадает с
  // `SubagentPartData['tool_calls']`.
  const toolCalls = normalizeToolCalls(final?.tool_calls)
  // Промежуточные тексты ядро пишет в `metadata.intermediate_text_blocks`
  // (отдельного поля DTO нет) — так же их читает лента (`ChatMessage.tsx`).
  const intermediateTextBlocks = normalizeTextBlocks(final?.metadata?.intermediate_text_blocks)
  // Размышления приходят склеенной строкой (`\n\n---\n\n` между блоками) —
  // отдельного `reasoning_blocks` в DTO нет.
  const reasoningBlocks = splitReasoning(final?.reasoning)
  const steps =
    toolCalls.length > 0
      ? Math.max(...toolCalls.map((call) => call.iteration || 0)) + 1
      : undefined
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
