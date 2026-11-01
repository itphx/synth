// Заполнение контекстного окна сессии — единый источник для шапки и статистики.
//
// Почему хук, а не расчёт в компоненте: шапка и «Последний ответ» правой панели
// показывали разные числа (шапка брала usage **последнего** assistant-сообщения
// и при пустом `usage` падала в 0%). Здесь одни и те же правила для обоих мест,
// плюс live-значение стримящегося сообщения, чтобы во время хода числа совпадали.
//
// Реактивность: селекторы сторов возвращают **примитивы** (число токенов,
// размер окна, флаг оценки). Мемоизация по объекту `messagesBySession`
// приводила к залипанию: объект менялся по ссылке только вместе с сессией,
// а сообщение без `usage` оставляло прежний процент.

import { useEffect } from 'react'

import { useNotification } from '@/hooks/useNotification'
import { useI18n } from '@/lib/i18n'
import { useContextWindowPolicy } from '@/lib/api/contextWindowSettings'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'

/** Фолбэк окна модели, если у модели не задан `context_window` (оценка). */
export const DEFAULT_CONTEXT_WINDOW = 200_000

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
  /** Входные токены последнего хода (последний usage или live-значение). */
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
 * `usage.input_tokens` последнего assistant-сообщения **с usage**.
 * Сообщения без `usage` (фоллбек ошибки, служебные) и отключённые/скрытые
 * пропускаются — иначе индикатор обнулялся в конце такого хода.
 */
export function lastAssistantInputTokens(messages: MessageData[] | undefined): number {
  if (!messages) return 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'assistant' || message.disabled || message.hidden) continue
    const tokens = message.usage?.input_tokens
    if (typeof tokens === 'number' && tokens > 0) return tokens
  }
  return 0
}

/** usage стримящегося сообщения (live-значение текущего хода). */
export function streamingInputTokens(messages: MessageData[] | undefined): number {
  if (!messages) return 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.status !== 'streaming') continue
    const tokens = message.usage?.input_tokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : 0
  }
  return 0
}

export function useContextWindowUsage(sessionId?: string): ContextWindowUsage {
  const sessions = useSessionsStore((s) => s.sessions)
  const selectedModelName = useProvidersStore((s) => s.selectedModelName)
  const modelId = findModelId(sessions, sessionId, selectedModelName)

  const windowTokens = useProvidersStore((s) => {
    const model = s.models.find((m) => m.id === modelId || m.name === modelId)
    const window = model?.context_window
    return typeof window === 'number' && window > 0 ? window : DEFAULT_CONTEXT_WINDOW
  })
  const isEstimated = useProvidersStore((s) => {
    const model = s.models.find((m) => m.id === modelId || m.name === modelId)
    const window = model?.context_window
    return !(typeof window === 'number' && window > 0)
  })

  // Два примитивных селектора: изменение числа перерисовывает компонент,
  // изменение не относящихся к делу сообщений — нет.
  const lastTokens = useChatStore((s) =>
    lastAssistantInputTokens(sessionId ? s.messagesBySession[sessionId] : undefined),
  )
  const liveTokens = useChatStore((s) =>
    streamingInputTokens(sessionId ? s.messagesBySession[sessionId] : undefined),
  )

  const inputTokens = Math.max(lastTokens, liveTokens)
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
