/**
 * Слой совместимости провайдеров и моделей — UI-сторона.
 *
 * Контракт API: `compatibility?: ModelCompatibility` (аддитивно, `null` — сброс).
 * Не заданное поле = «авто» (эвристика/дефолт на сервере). Формы панелей работают
 * с «черновиком» (`CompatibilityDraft`), где каждое поле хранится строкой:
 * пустая строка — авто, `'true'`/`'false'` — явное значение. Так tri-state
 * («авто / да / нет») не схлопывается в двузначный boolean.
 *
 * Типы и константы (`ModelCompatibility`, `NativeAudioFormat`,
 * `NATIVE_AUDIO_FORMATS`) — контракт shared (`@itphx/synth-shared/types`):
 * только subpath-импорт (корневой `@itphx/synth-shared` тянет `config/loader` →
 * `node:fs` и в браузерный бандл не годится). Типы реэкспортируются для
 * UI-импортов (`import type` не попадает в бандл).
 *
 * ADR-117: поля нативных медиа (`supportsNativeVideo`, `nativeAudioFormats`) —
 * часть общего контракта. Явные значения (`false`, пустой список) — не «авто»
 * и уходят в payload как есть.
 */

import {
  NATIVE_AUDIO_FORMATS,
  type ModelCompatibility,
  type NativeAudioFormat,
} from '@itphx/synth-shared/types'

export type { ModelCompatibility, NativeAudioFormat }

/** Значение tri-state контрола: `''` — авто, `'true'`/`'false'` — явное. */
export type CompatibilityTristate = '' | 'true' | 'false'

/** Пункт «Своё значение» в селекте поля рассуждений. */
export const COMPATIBILITY_CUSTOM = '__custom__'

/**
 * Режим поля «Аудио нативно»:
 * `''` — авто (эвристика сервера), `COMPATIBILITY_CUSTOM` — явный список
 * форматов, `'none'` — явный пустой список (нативно не принимается).
 */
export type CompatibilityAudioFormatsMode = '' | typeof COMPATIBILITY_CUSTOM | 'none'

/** Известные имена поля рассуждений — предлагаются в селекте (остальное — своё значение). */
export const REASONING_FIELD_OPTIONS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const

export const MAX_TOKENS_FIELD_OPTIONS = ['max_tokens', 'max_completion_tokens'] as const

/** Формат inline-маркеров prompt-cache; `''` — авто (`prompt_cache_key`). */
export type CompatibilityCacheFormat = '' | 'anthropic' | 'alibaba'

/** Известные форматы inline-маркеров — предлагаются в селекте. */
export const CACHE_FORMAT_OPTIONS = ['anthropic', 'alibaba'] as const

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
  /** `''` — авто (только `prompt_cache_key`), иначе inline-маркеры `cache_control`. */
  cacheFormat: CompatibilityCacheFormat
  /** `''` — авто (сервер: да). */
  requireFinishReason: CompatibilityTristate
  /** ADR-117: `''` — авто (сервер: нет, только явное включение effort-режима). */
  supportsEffortUpdates: CompatibilityTristate
  /** ADR-117: `''` — авто (эвристика по провайдеру), иначе — явное «да/нет». */
  supportsNativeVideo: CompatibilityTristate
  /** ADR-117: `''` — авто, `COMPATIBILITY_CUSTOM` — явный список, `'none'` — пустой список. */
  nativeAudioFormatsMode: CompatibilityAudioFormatsMode
  /** ADR-117: выбранные нативные форматы аудио (режим `COMPATIBILITY_CUSTOM`). */
  nativeAudioFormats: NativeAudioFormat[]
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
    cacheFormat: '',
    requireFinishReason: '',
    supportsEffortUpdates: '',
    supportsNativeVideo: '',
    nativeAudioFormatsMode: '',
    nativeAudioFormats: [],
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

/** Известен ли формат как нативный контейнер аудио (канон — shared). */
function isNativeAudioFormat(value: string): value is NativeAudioFormat {
  return (NATIVE_AUDIO_FORMATS as readonly string[]).includes(value)
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
  draft.cacheFormat =
    value.cacheFormat === 'anthropic' || value.cacheFormat === 'alibaba' ? value.cacheFormat : ''
  draft.requireFinishReason = tristateToDraft(value.requireFinishReason)
  draft.supportsEffortUpdates = tristateToDraft(value.supportsEffortUpdates)
  draft.supportsNativeVideo = tristateToDraft(value.supportsNativeVideo)
  const formats = value.nativeAudioFormats
  if (Array.isArray(formats)) {
    if (formats.length === 0) {
      // Явный пустой список — «нативно не принимается», а не «авто».
      draft.nativeAudioFormatsMode = 'none'
      draft.nativeAudioFormats = []
    } else {
      draft.nativeAudioFormatsMode = COMPATIBILITY_CUSTOM
      draft.nativeAudioFormats = formats.filter(isNativeAudioFormat)
    }
  }
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
  if (draft.cacheFormat) out.cacheFormat = draft.cacheFormat
  const requireFinishReason = tristateToBool(draft.requireFinishReason)
  if (requireFinishReason !== undefined) out.requireFinishReason = requireFinishReason
  const supportsEffortUpdates = tristateToBool(draft.supportsEffortUpdates)
  if (supportsEffortUpdates !== undefined) out.supportsEffortUpdates = supportsEffortUpdates
  // ADR-117: явные значения — не «авто», поэтому уходят в payload как есть.
  const supportsNativeVideo = tristateToBool(draft.supportsNativeVideo)
  if (supportsNativeVideo !== undefined) out.supportsNativeVideo = supportsNativeVideo
  if (draft.nativeAudioFormatsMode === COMPATIBILITY_CUSTOM) {
    out.nativeAudioFormats = [...draft.nativeAudioFormats]
  } else if (draft.nativeAudioFormatsMode === 'none') {
    out.nativeAudioFormats = []
  }
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
