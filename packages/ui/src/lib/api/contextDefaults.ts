// context-defaults: значения по умолчанию для новых сессий.
//
// Настройка уровня инстанса (`GET/PUT/DELETE /api/v2/settings/context-defaults`):
// стратегия оптимизации контекста и параметры автосуммаризации / скользящего
// окна, которые получают новые сессии. Существующие сессии настройку не
// подхватывают — у них свои значения в настройках сессии.
//
// UI-правило: чтение — строгое (`fetchContextDefaults` бросает ошибку), админ-
// панель показывает причину сбоя и кнопку повтора, а не молча деградирует.

import { BASE_URL, fetchJSON } from './base'

// `sticky_notes` — legacy-значение сессий: в дефолтах инстанса и UI не
// предлагается, заметки работают независимо от стратегии.
export type ContextOptimizationStrategy = 'none' | 'sliding_window' | 'summarization'

export type SummarizationTriggerMode = 'messages' | 'tokens'
export type SlidingWindowMode = 'messages' | 'tokens'

export interface ContextDefaultsValues {
  contextOptimization: ContextOptimizationStrategy
  summarizationEnabled: boolean
  summarizationTriggerMode: SummarizationTriggerMode
  summarizeAfterN: number
  /** Порог токенов в процентах (1..100). */
  summarizeTokenThreshold: number
  summarizationHeadMessages: number
  summarizationTailMessages: number
  slidingWindowMode: SlidingWindowMode
  slidingWindowMessageLimit: number
  /** Порог токенов в процентах (1..100). */
  slidingWindowTokenThreshold: number
}

/** Источник эффективных значений. */
export type ContextDefaultsSource = 'runtime' | 'config' | 'default'

export interface ContextDefaultsResponse {
  /** Эффективные значения (runtime > config > default). */
  defaults: ContextDefaultsValues
  /** Сохранённый runtime-override (пустой объект — runtime не задан). */
  saved: Partial<ContextDefaultsValues>
  source: ContextDefaultsSource
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: boolean
}

/** Порядок стратегий в контроле. */
export const CONTEXT_OPTIMIZATION_STRATEGIES: readonly ContextOptimizationStrategy[] = [
  'none',
  'sliding_window',
  'summarization',
]

export const SUMMARIZATION_TRIGGER_MODES: readonly SummarizationTriggerMode[] = [
  'messages',
  'tokens',
]

export const SLIDING_WINDOW_MODES: readonly SlidingWindowMode[] = ['messages', 'tokens']

/** Дефолты, когда ответ сервера неполный (старая сборка ядра). */
export const DEFAULT_CONTEXT_DEFAULTS: ContextDefaultsValues = {
  contextOptimization: 'none',
  summarizationEnabled: false,
  summarizationTriggerMode: 'messages',
  summarizeAfterN: 10,
  summarizeTokenThreshold: 50,
  summarizationHeadMessages: 2,
  summarizationTailMessages: 3,
  slidingWindowMode: 'messages',
  slidingWindowMessageLimit: 10,
  slidingWindowTokenThreshold: 80,
}

const SOURCES: readonly ContextDefaultsSource[] = ['runtime', 'config', 'default']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStrategy(value: unknown): value is ContextOptimizationStrategy {
  return (
    typeof value === 'string' &&
    (CONTEXT_OPTIMIZATION_STRATEGIES as readonly string[]).includes(value)
  )
}

function isTriggerMode(value: unknown): value is SummarizationTriggerMode {
  return typeof value === 'string' && (SUMMARIZATION_TRIGGER_MODES as readonly string[]).includes(value)
}

function isSlidingMode(value: unknown): value is SlidingWindowMode {
  return typeof value === 'string' && (SLIDING_WINDOW_MODES as readonly string[]).includes(value)
}

function isSource(value: unknown): value is ContextDefaultsSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback
}

function percentage(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100
    ? Math.trunc(value)
    : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Нормализует эффективные значения: неизвестные/битые поля не ломают чтение и
 * деградируют к дефолтам, остальные поля сохраняются.
 */
function normalizeValues(raw: unknown): ContextDefaultsValues {
  const body = isRecord(raw) ? raw : {}
  return {
    contextOptimization: isStrategy(body.contextOptimization)
      ? body.contextOptimization
      : DEFAULT_CONTEXT_DEFAULTS.contextOptimization,
    summarizationEnabled: boolean(
      body.summarizationEnabled,
      DEFAULT_CONTEXT_DEFAULTS.summarizationEnabled,
    ),
    summarizationTriggerMode: isTriggerMode(body.summarizationTriggerMode)
      ? body.summarizationTriggerMode
      : DEFAULT_CONTEXT_DEFAULTS.summarizationTriggerMode,
    summarizeAfterN: positiveInteger(
      body.summarizeAfterN,
      DEFAULT_CONTEXT_DEFAULTS.summarizeAfterN,
    ),
    summarizeTokenThreshold: percentage(
      body.summarizeTokenThreshold,
      DEFAULT_CONTEXT_DEFAULTS.summarizeTokenThreshold,
    ),
    summarizationHeadMessages: positiveInteger(
      body.summarizationHeadMessages,
      DEFAULT_CONTEXT_DEFAULTS.summarizationHeadMessages,
    ),
    summarizationTailMessages: positiveInteger(
      body.summarizationTailMessages,
      DEFAULT_CONTEXT_DEFAULTS.summarizationTailMessages,
    ),
    slidingWindowMode: isSlidingMode(body.slidingWindowMode)
      ? body.slidingWindowMode
      : DEFAULT_CONTEXT_DEFAULTS.slidingWindowMode,
    slidingWindowMessageLimit: positiveInteger(
      body.slidingWindowMessageLimit,
      DEFAULT_CONTEXT_DEFAULTS.slidingWindowMessageLimit,
    ),
    slidingWindowTokenThreshold: percentage(
      body.slidingWindowTokenThreshold,
      DEFAULT_CONTEXT_DEFAULTS.slidingWindowTokenThreshold,
    ),
  }
}

/** Разбирает `saved`: только известные и валидные поля. */
function normalizeSaved(raw: unknown): Partial<ContextDefaultsValues> {
  if (!isRecord(raw)) return {}
  const source = normalizeValues(raw)
  const saved: Partial<ContextDefaultsValues> = {}
  for (const key of Object.keys(DEFAULT_CONTEXT_DEFAULTS) as Array<
    keyof ContextDefaultsValues
  >) {
    if (key in raw) {
      // `normalizeValues` уже отвалидировал каждое поле.
      Object.assign(saved, { [key]: source[key] })
    }
  }
  return saved
}

function normalizeResponse(raw: unknown): ContextDefaultsResponse {
  const body = isRecord(raw) ? raw : {}
  return {
    defaults: normalizeValues(body.defaults),
    saved: normalizeSaved(body.saved),
    source: isSource(body.source) ? body.source : 'default',
    restartRequired: body.restartRequired === true,
  }
}

const ENDPOINT = `${BASE_URL}/settings/context-defaults`

/**
 * `GET /settings/context-defaults` со строгой ошибкой — для админ-раздела:
 * он показывает причину сбоя и кнопку повтора.
 */
export async function fetchContextDefaults(): Promise<ContextDefaultsResponse> {
  const raw = await fetchJSON<Record<string, unknown>>(ENDPOINT)
  return normalizeResponse(raw)
}

/**
 * `PUT /settings/context-defaults` `{defaults: patch}` — частичное обновление
 * runtime-значений. Сервер отвечает тем же контрактом, что и `GET`.
 */
export async function putContextDefaults(
  patch: Partial<ContextDefaultsValues>,
): Promise<ContextDefaultsResponse> {
  const raw = await fetchJSON<Record<string, unknown>>(ENDPOINT, {
    method: 'PUT',
    body: JSON.stringify({ defaults: patch }),
  })
  return normalizeResponse(raw)
}

/**
 * `DELETE /settings/context-defaults` — сброс runtime-значений к config/default.
 */
export async function deleteContextDefaults(): Promise<ContextDefaultsResponse> {
  const raw = await fetchJSON<Record<string, unknown>>(ENDPOINT, { method: 'DELETE' })
  return normalizeResponse(raw)
}
