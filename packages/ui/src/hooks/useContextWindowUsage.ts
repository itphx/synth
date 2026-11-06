// Заполнение контекстного окна сессии — единый источник для шапки и статистики.
//
// Почему хук, а не расчёт в компоненте: шапка и «Последний ответ» правой панели
// показывали разные числа (шапка брала usage **последнего** assistant-сообщения
// и при пустом `usage` падала в 0%). Здесь одни и те же правила для обоих мест,
// плюс live-значение стримящегося сообщения, чтобы во время хода числа совпадали.
//
// ADR-102/ADR-118, паритет с opencode (`contextUsage`): заполнение контекста —
// **total последнего ответа провайдера** (одного вызова), а не сумма шагов хода
// и не накопительный расход сессии. `usage.input_tokens` в Synth уже включает
// cache read/write, reasoning входит в output — отдельно их не прибавляем.
//
// Реактивность: селекторы сторов возвращают **примитивы** (число токенов,
// размер окна, флаг оценки). Мемоизация по объекту `messagesBySession`
// приводила к залипанию: объект менялся по ссылке только вместе с сессией,
// а сообщение без `usage` оставляло прежний процент.

import { useEffect } from 'react'
import { DEFAULT_CONTEXT_WINDOW } from '@itphx/synth-shared/types'

import { useNotification } from '@/hooks/useNotification'
import { useI18n } from '@/lib/i18n'
import { useContextWindowPolicy } from '@/lib/api/contextWindowSettings'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useEnsureModelsLoaded } from '@/hooks/useEnsureModelsLoaded'

/**
 * Фолбэк окна модели, если у модели не задан `context_window` (оценка).
 *
 * Единый источник — `@itphx/synth-shared` (subpath `/types`: браузерный бандл
 * не должен тянуть `config/loader` с `node:fs`). То же значение использует
 * оптимизатор контекста в ядре, поэтому индикатор и авто-сжатие совпадают.
 */
export { DEFAULT_CONTEXT_WINDOW }

/** Порог тоста «контекст заполняется», %. */
export const CONTEXT_WARN_PERCENT = 80

/** Порог блокирующего предупреждения над композером, %. */
export const CONTEXT_BLOCK_PERCENT = 90

/**
 * Уровень заполнения: цвет индикатора и допустимые предупреждения.
 * `ok` < 50 ≤ `notice` < 75 ≤ `warning` < 90 ≤ `critical`.
 */
export type ContextLevel = 'ok' | 'notice' | 'warning' | 'critical'

export function contextLevel(percent: number): ContextLevel {
  if (percent >= CONTEXT_BLOCK_PERCENT) return 'critical'
  if (percent >= 75) return 'warning'
  if (percent >= 50) return 'notice'
  return 'ok'
}

/**
 * CSS-классы уровня (только токены темы, без литералов): полоса-индикатор и
 * текст процента. Один реестр для шапки и правой панели.
 */
export const CONTEXT_LEVEL_CLASSES: Record<ContextLevel, { bar: string; text: string }> = {
  ok: { bar: 'bg-status-success', text: 'text-status-success' },
  notice: { bar: 'bg-status-notice', text: 'text-status-notice' },
  warning: { bar: 'bg-status-caution', text: 'text-status-caution' },
  critical: { bar: 'bg-destructive', text: 'text-destructive' },
}

export interface ContextWindowUsage {
  /**
   * Заполнение контекста: **total** последнего ответа провайдера
   * (`usage.total_tokens`, иначе `input + output`) — как в opencode
   * (`contextUsage`). `input_tokens` в Synth уже включает cache read/write,
   * а reasoning входит в output, поэтому отдельно их НЕ прибавляем.
   */
  inputTokens: number
  /** Окно модели сессии (или фолбэк-оценка). */
  windowTokens: number
  /** Заполнение, % (0..100). */
  percent: number
  /** Окно — фолбэк-оценка: у модели не задан `context_window`. */
  isEstimated: boolean
  level: ContextLevel
}

/** Модель сессии: явная настройка сессии, иначе выбранная модель инстанса. */
function findModelId(
  sessions: ReadonlyArray<{ id: string; settings?: unknown }>,
  sessionId: string | undefined,
  selectedModelName: string | null,
): string | undefined {
  if (!sessionId) return selectedModelName ?? undefined
  const session = sessions.find((s) => s.id === sessionId)
  const model = (session?.settings as Record<string, unknown> | undefined)?.model
  if (typeof model === 'string' && model !== '') return model
  return selectedModelName ?? undefined
}

/**
 * Total токенов usage сообщения: `total_tokens`, иначе `input + output`.
 *
 * ADR-102/ADR-118 + opencode `contextUsage`: контекст показывает **total
 * последнего ответа провайдера** (одного вызова), а не сумму хода. В Synth
 * `input_tokens` уже нормализован и включает cache read/write
 * (`providers/anthropic.ts`/`providers/openai.ts`), reasoning входит в
 * output — поэтому cache/reasoning отдельно НЕ прибавляются (двойной счёт).
 */
function usageTotalTokens(usage: MessageData['usage']): number {
  if (!usage) return 0
  const total = usage.total_tokens
  if (typeof total === 'number' && total > 0) return total
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
}

/**
 * ADR-119: сообщение резюме/сжатия — **не** источник контекстного usage.
 *
 * Признаки: роль `summary`, агентская роль `summary` (шаг сжатия) или
 * `metadata.type === 'auto_summary'` (сохранённое резюме). Их `usage` —
 * расход **вызова сжатия** (весь транскрипт на входе), а не занятость
 * окна: такой шаг не должен раздувать индикатор.
 */
function isSummaryMessage(message: MessageData): boolean {
  if (message.role === 'summary') return true
  if (message.agent_role === 'summary') return true
  return message.metadata?.type === 'auto_summary'
}

/**
 * Индекс последнего резюме в ленте (паритет с core, ADR-119 M2).
 *
 * Замеры assistant-сообщений **до** последнего резюме неактуальны (они
 * покрыты резюме) — поэтому в оценке контекста их usage не используется.
 */
function lastSummaryIndex(messages: MessageData[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSummaryMessage(messages[i]!)) return i
  }
  return -1
}

/**
 * Total токенов последнего assistant-сообщения **с usage**.
 * Сообщения без `usage` (фоллбек ошибки, служебные) и отключённые/скрытые
 * пропускаются — иначе индикатор обнулялся в конце такого хода.
 *
 * Считается **по последнему ответу**, а не по сумме загруженных сообщений:
 * при постраничной истории (пагинация `GET /sessions/:id/messages`) лента может
 * быть неполной, а контекстное окно определяется последним вызовом провайдера —
 * число остаётся верным независимо от того, сколько страниц загружено.
 */
export function lastAssistantContextTokens(messages: MessageData[] | undefined): number {
  if (!messages) return 0
  const summaryIdx = lastSummaryIndex(messages)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant' || message.disabled || message.hidden) continue
    // Шаг сжатия: его usage — расход вызова сжатия, не занятость окна.
    if (isSummaryMessage(message)) continue
    // M2: измерение до последнего резюме неактуально (сообщение покрыто
    // резюме) — оценку даёт сервер, а не этот замер.
    if (summaryIdx >= 0 && i <= summaryIdx) continue
    const tokens = usageTotalTokens(message.usage)
    if (tokens > 0) return tokens
  }
  return 0
}

/** Total токенов usage стримящегося сообщения (live-значение текущего хода). */
export function streamingContextTokens(messages: MessageData[] | undefined): number {
  if (!messages) return 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.status !== 'streaming') continue
    // Служебный шаг сжатия — не источник контекстного usage.
    if (isSummaryMessage(message)) continue
    const tokens = usageTotalTokens(message.usage)
    return tokens > 0 ? tokens : 0
  }
  return 0
}

export function useContextWindowUsage(sessionId?: string): ContextWindowUsage {
  const sessions = useSessionsStore((s) => s.sessions)
  const selectedModelName = useProvidersStore((s) => s.selectedModelName)
  const modelId = findModelId(sessions, sessionId, selectedModelName)

  // Каталог моделей постраничный: модель сессии может быть не на загруженной
  // странице — догружаем её, иначе окно контекста неизвестно (оценка).
  useEnsureModelsLoaded([modelId])

  const modelWindowTokens = useProvidersStore((s) => {
    const model = s.models.find((m) => m.id === modelId || m.name === modelId)
    const window = model?.context_window
    return typeof window === 'number' && window > 0 ? window : DEFAULT_CONTEXT_WINDOW
  })
  const isModelWindowEstimated = useProvidersStore((s) => {
    const model = s.models.find((m) => m.id === modelId || m.name === modelId)
    const window = model?.context_window
    return !(typeof window === 'number' && window > 0)
  })

  // Два примитивных селектора: изменение числа перерисовывает компонент,
  // изменение не относящихся к делу сообщений — нет.
  const lastTokens = useChatStore((s) =>
    lastAssistantContextTokens(sessionId ? s.messagesBySession[sessionId] : undefined),
  )
  const liveTokens = useChatStore((s) =>
    streamingContextTokens(sessionId ? s.messagesBySession[sessionId] : undefined),
  )
  /**
   * ADR-119: **серверная** оценка занятости контекста (деталь-DTO сессии
   * `context_usage` + событие `context.summarization_applied`) — источник
   * истины, когда свежего клиентского замера нет.
   */
  const serverUsage = useChatStore((s) =>
    sessionId ? s.contextUsageBySession[sessionId] : undefined,
  )

  const serverTokens = serverUsage?.tokens ?? 0
  /**
   * Выбор источника занятости:
   * - `lastTokens > 0` — свежий клиентский замер (последний assistant **после**
   *   последнего резюме): он растёт по ходам, поэтому важнее серверного;
   * - `lastTokens === 0` — свежего замера на сжатом промпте нет (сразу после
   *   сжатия, при открытии сессии, когда последний замер был до резюме) →
   *   берём серверную оценку (она уже посчитана с учётом компактизации).
   */
  const useServerUsage = !!serverUsage && lastTokens === 0

  const inputTokens = useServerUsage
    ? Math.max(serverTokens, liveTokens)
    : Math.max(lastTokens, liveTokens)
  // Окно модели — из серверной оценки, если она есть (окно одно и то же).
  const windowTokens = serverUsage?.limit ?? modelWindowTokens
  const isEstimated = serverUsage ? serverUsage.estimated : isModelWindowEstimated
  const percent = windowTokens > 0
    ? Math.min(100, Math.max(0, Math.round((inputTokens / windowTokens) * 100)))
    : 0

  return {
    inputTokens,
    windowTokens,
    percent,
    isEstimated,
    level: contextLevel(percent),
  }
}

/** Ключи, по которым тост уже показан (страховка, если sessionStorage недоступен). */
const warnedKeys = new Set<string>()

/** Ключ дедупликации переживает перезагрузку вкладки (sessionStorage). */
function warningKey(sessionId: string, percent: number): string {
  return `ctx-warn:${sessionId}:${percent}`
}

function readWarningFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function writeWarningFlag(key: string): void {
  try {
    window.sessionStorage.setItem(key, '1')
  } catch {
    // storage недоступен (приватный режим/политика) — держит `warnedKeys`.
  }
}

/**
 * Тост «контекст заполняется» при переходе через порог 80%.
 *
 * Один раз на сессию и порог: ключ в `sessionStorage` + модульный набор.
 * Политика `off` выключает предупреждение целиком; порог `enforce` не меняет
 * текста (сервер ужесточает ход сам).
 */
export function useContextWindowWarning(sessionId: string | undefined, percent: number): void {
  const { notify } = useNotification()
  const { t } = useI18n()
  const policy = useContextWindowPolicy()

  useEffect(() => {
    if (!sessionId || policy === 'off' || percent < CONTEXT_WARN_PERCENT) return
    const key = warningKey(sessionId, CONTEXT_WARN_PERCENT)
    if (warnedKeys.has(key) || readWarningFlag(key)) return
    warnedKeys.add(key)
    writeWarningFlag(key)
    notify({ text: t('chat.context.warning80', { percent }), type: 'warning', category: 'queue' })
  }, [sessionId, percent, policy, notify, t])
}

/** Сброс дедупликации тостов — только для тестов. */
export function resetContextWindowWarningState(): void {
  warnedKeys.clear()
}
