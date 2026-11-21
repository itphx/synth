/**
 * Тексты подсказок кнопок тулбара композера.
 *
 * Вынесено из компонентов, чтобы «что показывать» было покрыто тестами без
 * Radix-тултипа: в jsdom наведение не воспроизводится, а правила отбора строк
 * (например, «окно контекста только если оно задано») важны и проверяемы.
 */

/** Строка подсказки; `muted` — второстепенная (провайдер, окно, описание). */
export interface ComposerTooltipLine {
  text: string
  muted?: boolean
}

/** Части подсказки выбора модели: провайдер, модель, окно контекста. */
export interface ModelTooltipParts {
  provider?: string
  model?: string
  context?: string
}

export interface ModelTooltipInput {
  providerName?: string | null
  modelName?: string | null
  /** Размер контекстного окна модели; `0`/`null`/`undefined` — не задан. */
  contextWindow?: number | null
  /** Подпись строки окна (i18n, напр. «Контекстное окно»). */
  contextLabel: string
}

/**
 * Подсказка модели: провайдер, название, размер контекстного окна — последнее
 * только если оно реально задано (каталог часто отдаёт `contextWindow: 0` для
 * неизвестных моделей, и строка «Контекстное окно: 0» была бы враньём).
 */
export function modelTooltipParts(input: ModelTooltipInput): ModelTooltipParts {
  const parts: ModelTooltipParts = {}
  const provider = (input.providerName ?? '').trim()
  if (provider) parts.provider = provider
  const model = (input.modelName ?? '').trim()
  if (model) parts.model = model
  const window = input.contextWindow
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
    parts.context = `${input.contextLabel}: ${window.toLocaleString()}`
  }
  return parts
}

/**
 * Готовая подсказка для `title` кнопки (многострочная): единый механизм UI — глобальный
 * `TitleTooltipBridge`, который показывает `title` кастомным тултипом в стиле кита
 * (нативные браузерные подсказки и отдельный Radix-тултип не используем — иначе
 * вид отличается от соседних кнопок тулбара). Пустые строки не попадают.
 */
export function modelTooltipText(input: ModelTooltipInput): string {
  const parts = modelTooltipParts(input)
  return [parts.provider, parts.model, parts.context].filter(Boolean).join('\n')
}

/** Части подсказки выбора агента: имя и описание роли. */
export interface AgentTooltipParts {
  name?: string
  description?: string
}

export interface AgentTooltipInput {
  displayName?: string | null
  /** Описание роли агента; пустое — подсказка без второй строки. */
  description?: string | null
  /** Запасное имя (id активного агента), если `displayName` пуст. */
  fallbackName?: string | null
}

/**
 * Подсказка агента: имя (или id) и описание. Описание обрезается по краям и не
 * показывается, если пустое — иначе остаётся «висящая» пустая строка.
 */
export function agentTooltipParts(input: AgentTooltipInput): AgentTooltipParts {
  const parts: AgentTooltipParts = {}
  const name = (input.displayName ?? '').trim() || (input.fallbackName ?? '').trim()
  if (name) parts.name = name
  const description = (input.description ?? '').trim()
  if (description) parts.description = description
  return parts
}

/** Готовая подсказка агента для `title` (см. `modelTooltipText`). */
export function agentTooltipText(input: AgentTooltipInput): string {
  const parts = agentTooltipParts(input)
  return [parts.name, parts.description].filter(Boolean).join('\n')
}

/**
 * Строки подсказки модели с акцентами: модель — обычная, провайдер и размер окна
 * — приглушённые. Ими `TitleTooltipBridge` рисует тултип с иерархией.
 */
export function modelTooltipLines(input: ModelTooltipInput): ComposerTooltipLine[] {
  const parts = modelTooltipParts(input)
  const lines: ComposerTooltipLine[] = []
  if (parts.provider) lines.push({ text: parts.provider, muted: true })
  if (parts.model) lines.push({ text: parts.model })
  if (parts.context) lines.push({ text: parts.context, muted: true })
  return lines
}

/** Строки подсказки агента: имя — обычное, описание — приглушённое. */
export function agentTooltipLines(input: AgentTooltipInput): ComposerTooltipLine[] {
  const parts = agentTooltipParts(input)
  const lines: ComposerTooltipLine[] = []
  if (parts.name) lines.push({ text: parts.name })
  if (parts.description) lines.push({ text: parts.description, muted: true })
  return lines
}
