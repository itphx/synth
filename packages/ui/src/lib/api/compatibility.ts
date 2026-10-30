/**
 * Слой совместимости провайдеров и моделей — UI-сторона.
 *
 * Контракт API: `compatibility?: ModelCompatibility` (аддитивно, `null` — сброс).
 * Не заданное поле = «авто» (эвристика/дефолт на сервере). Формы панелей работают
 * с «черновиком» (`CompatibilityDraft`), где каждое поле хранится строкой:
 * пустая строка — авто, `'true'`/`'false'` — явное значение. Так tri-state
 * («авто / да / нет») не схлопывается в двузначный boolean.
 *
 * Тип `ModelCompatibility` — контракт shared (`@itphx/synth-shared/types`);
 * здесь реэкспорт для UI-импортов (`import type` не попадает в бандл, инвариант
 * импортов shared: только subpath).
 */

import type { ModelCompatibility } from '@itphx/synth-shared/types'

export type { ModelCompatibility }

/** Значение tri-state контрола: `''` — авто, `'true'`/`'false'` — явное. */
export type CompatibilityTristate = '' | 'true' | 'false'

/** Пункт «Своё значение» в селекте поля рассуждений. */
export const COMPATIBILITY_CUSTOM = '__custom__'

/** Известные имена поля рассуждений — предлагаются в селекте (остальное — своё значение). */
export const REASONING_FIELD_OPTIONS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const

export const MAX_TOKENS_FIELD_OPTIONS = ['max_tokens', 'max_completion_tokens'] as const

/** Черновик формы: всё строковое, чтобы «авто» отличалось от явного значения. */
export interface CompatibilityDraft {
  /** `''` — авто, известное имя, либо `COMPATIBILITY_CUSTOM`. */
  reasoningField: string
  /** Текст своего значения (используется при `reasoningField === COMPATIBILITY_CUSTOM`). */
  reasoningFieldCustom: string
  requireReasoning: CompatibilityTristate
  /** `''` — авто. */
  maxTokensField: '' | 'max_tokens' | 'max_completion_tokens'
  requireAssistantAfterTool: CompatibilityTristate
  streamUsage: CompatibilityTristate
  supportsToolChoice: CompatibilityTristate
}

export function emptyCompatibilityDraft(): CompatibilityDraft {
  return {
    reasoningField: '',
    reasoningFieldCustom: '',
    requireReasoning: '',
    maxTokensField: '',
    requireAssistantAfterTool: '',
    streamUsage: '',
    supportsToolChoice: '',
  }
}

function tristateToDraft(value: boolean | undefined): CompatibilityTristate {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return ''
}

function tristateToBool(value: CompatibilityTristate): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** Развернуть сохранённый объект в контролы (неизвестное поле → «своё значение»). */
export function draftFromCompatibility(value?: ModelCompatibility | null): CompatibilityDraft {
  const draft = emptyCompatibilityDraft()
  if (!value) return draft
  if (typeof value.reasoningField === 'string' && value.reasoningField.trim()) {
    const field = value.reasoningField.trim()
    if ((REASONING_FIELD_OPTIONS as readonly string[]).includes(field)) {
      draft.reasoningField = field
    } else {
      draft.reasoningField = COMPATIBILITY_CUSTOM
      draft.reasoningFieldCustom = field
    }
  }
  draft.requireReasoning = tristateToDraft(value.requireReasoning)
  draft.maxTokensField = value.maxTokensField === 'max_completion_tokens'
    ? 'max_completion_tokens'
    : value.maxTokensField === 'max_tokens'
      ? 'max_tokens'
      : ''
  draft.requireAssistantAfterTool = tristateToDraft(value.requireAssistantAfterTool)
  draft.streamUsage = tristateToDraft(value.streamUsage)
  draft.supportsToolChoice = tristateToDraft(value.supportsToolChoice)
  return draft
}

/** Есть ли в черновике хоть одно не-«авто» значение (для бейджа «изменено»). */
export function hasCompatibilityDraftChanges(draft: CompatibilityDraft): boolean {
  return compatibilityFromDraft(draft) !== null
}

/** Собрать объект из черновика: `null` — все поля «авто». */
export function compatibilityFromDraft(draft: CompatibilityDraft): ModelCompatibility | null {
  const out: ModelCompatibility = {}
  const field = draft.reasoningField === COMPATIBILITY_CUSTOM
    ? draft.reasoningFieldCustom.trim()
    : draft.reasoningField.trim()
  if (field) out.reasoningField = field
  const requireReasoning = tristateToBool(draft.requireReasoning)
  if (requireReasoning !== undefined) out.requireReasoning = requireReasoning
  if (draft.maxTokensField) out.maxTokensField = draft.maxTokensField
  const requireAssistantAfterTool = tristateToBool(draft.requireAssistantAfterTool)
  if (requireAssistantAfterTool !== undefined) out.requireAssistantAfterTool = requireAssistantAfterTool
  const streamUsage = tristateToBool(draft.streamUsage)
  if (streamUsage !== undefined) out.streamUsage = streamUsage
  const supportsToolChoice = tristateToBool(draft.supportsToolChoice)
  if (supportsToolChoice !== undefined) out.supportsToolChoice = supportsToolChoice
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Тело запроса: что класть в `compatibility`.
 *
 * - есть значения → объект;
 * - всё «авто», у сущности ничего не было сохранено → `undefined` (поле не отправляем);
 * - всё «авто», но раньше было сохранено → `null` (явный сброс на сервере).
 */
export function buildCompatibilityPayload(
  draft: CompatibilityDraft,
  hadSaved: boolean,
): ModelCompatibility | null | undefined {
  const next = compatibilityFromDraft(draft)
  if (next) return next
  return hadSaved ? null : undefined
}

/** Сохранённая совместимость «непуста» — блок раскрыт по умолчанию, в списке виден бейдж. */
export function isCompatibilitySaved(value?: ModelCompatibility | null): boolean {
  return compatibilityFromDraft(draftFromCompatibility(value)) !== null
}
