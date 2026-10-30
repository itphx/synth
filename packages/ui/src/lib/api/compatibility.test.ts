import { describe, expect, it } from 'vitest'

import {
  COMPATIBILITY_CUSTOM,
  buildCompatibilityPayload,
  compatibilityFromDraft,
  draftFromCompatibility,
  emptyCompatibilityDraft,
  hasCompatibilityDraftChanges,
  isCompatibilitySaved,
} from './compatibility'

describe('compatibility: черновик формы ↔ сохранённый объект', () => {
  it('пустой объект и null → пустой черновик («всё авто»)', () => {
    expect(draftFromCompatibility(undefined)).toEqual(emptyCompatibilityDraft())
    expect(draftFromCompatibility(null)).toEqual(emptyCompatibilityDraft())
    expect(draftFromCompatibility({})).toEqual(emptyCompatibilityDraft())
    expect(hasCompatibilityDraftChanges(emptyCompatibilityDraft())).toBe(false)
  })

  it('известное поле рассуждений разворачивается в селект как есть', () => {
    const draft = draftFromCompatibility({ reasoningField: 'reasoning', requireReasoning: false })
    expect(draft.reasoningField).toBe('reasoning')
    expect(draft.reasoningFieldCustom).toBe('')
    expect(draft.requireReasoning).toBe('false')
  })

  it('неизвестное поле рассуждений → «своё значение» с заполненным input (round-trip)', () => {
    const draft = draftFromCompatibility({ reasoningField: 'reasoning_details' })
    expect(draft.reasoningField).toBe(COMPATIBILITY_CUSTOM)
    expect(draft.reasoningFieldCustom).toBe('reasoning_details')
    // Обратная сборка не теряет произвольное имя.
    expect(compatibilityFromDraft(draft)).toEqual({ reasoningField: 'reasoning_details' })
  })

  it('tri-state: «авто» не попадает в объект, явные true/false — попадают', () => {
    const draft = {
      ...emptyCompatibilityDraft(),
      requireReasoning: 'false' as const,
      streamUsage: 'true' as const,
      supportsToolChoice: '' as const,
    }
    expect(compatibilityFromDraft(draft)).toEqual({ requireReasoning: false, streamUsage: true })
  })

  it('max_tokens и прочие поля сохраняются', () => {
    const draft = {
      ...emptyCompatibilityDraft(),
      maxTokensField: 'max_completion_tokens' as const,
      requireAssistantAfterTool: 'true' as const,
    }
    expect(compatibilityFromDraft(draft)).toEqual({
      maxTokensField: 'max_completion_tokens',
      requireAssistantAfterTool: true,
    })
  })

  it('cacheFormat и requireFinishReason: сохранённые значения переживают round-trip', () => {
    const saved = { cacheFormat: 'alibaba' as const, requireFinishReason: false }
    const draft = draftFromCompatibility(saved)
    expect(draft.cacheFormat).toBe('alibaba')
    expect(draft.requireFinishReason).toBe('false')
    expect(compatibilityFromDraft(draft)).toEqual(saved)
  })

  it('cacheFormat/requireFinishReason: «авто» не попадает в объект, явные значения — попадают', () => {
    const auto = draftFromCompatibility({})
    expect(auto.cacheFormat).toBe('')
    expect(auto.requireFinishReason).toBe('')

    const explicit = {
      ...emptyCompatibilityDraft(),
      cacheFormat: 'anthropic' as const,
      requireFinishReason: 'true' as const,
    }
    expect(compatibilityFromDraft(explicit)).toEqual({
      cacheFormat: 'anthropic',
      requireFinishReason: true,
    })
  })
})

describe('compatibility: payload запроса', () => {
  it('всё «авто» и сохранённого не было → поле не отправляется', () => {
    expect(buildCompatibilityPayload(emptyCompatibilityDraft(), false)).toBeUndefined()
  })

  it('всё «авто», но параметры были сохранены → явный сброс null', () => {
    expect(buildCompatibilityPayload(emptyCompatibilityDraft(), true)).toBeNull()
  })

  it('выбранные значения уходят объектом (только выбранное)', () => {
    const draft = { ...emptyCompatibilityDraft(), requireReasoning: 'false' as const }
    expect(buildCompatibilityPayload(draft, true)).toEqual({ requireReasoning: false })
    expect(buildCompatibilityPayload(draft, false)).toEqual({ requireReasoning: false })
  })

  it('«своё значение» с пустым input не создаёт поле (авто)', () => {
    const draft = {
      ...emptyCompatibilityDraft(),
      reasoningField: COMPATIBILITY_CUSTOM,
      reasoningFieldCustom: '   ',
    }
    expect(compatibilityFromDraft(draft)).toBeNull()
    expect(buildCompatibilityPayload(draft, true)).toBeNull()
  })

  it('isCompatibilitySaved отличает пустую запись от настроенной', () => {
    expect(isCompatibilitySaved(undefined)).toBe(false)
    expect(isCompatibilitySaved({})).toBe(false)
    expect(isCompatibilitySaved({ supportsToolChoice: false })).toBe(true)
  })

  it('cacheFormat/requireFinishReason уходят в payload (только заданное)', () => {
    const draft = {
      ...emptyCompatibilityDraft(),
      cacheFormat: 'alibaba' as const,
      requireFinishReason: 'false' as const,
    }
    expect(buildCompatibilityPayload(draft, false)).toEqual({
      cacheFormat: 'alibaba',
      requireFinishReason: false,
    })
  })

  it('«авто» у cacheFormat/requireFinishReason поля не добавляет', () => {
    const draft = { ...emptyCompatibilityDraft(), reasoningField: 'reasoning' as const }
    expect(buildCompatibilityPayload(draft, true)).toEqual({ reasoningField: 'reasoning' })
    expect(buildCompatibilityPayload(emptyCompatibilityDraft(), false)).toBeUndefined()
  })

  it('сброс cacheFormat/requireFinishReason у сохранённой сущности → compatibility: null', () => {
    const saved = draftFromCompatibility({ cacheFormat: 'anthropic', requireFinishReason: true })
    const cleared = {
      ...saved,
      cacheFormat: '' as const,
      requireFinishReason: '' as const,
    }
    expect(buildCompatibilityPayload(cleared, true)).toBeNull()
  })
})
