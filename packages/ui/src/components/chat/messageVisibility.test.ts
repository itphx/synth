import { describe, it, expect } from 'vitest'
import { isVisibleMessage, isStateMessage, STATE_MESSAGE_TYPES } from './messageVisibility'

describe('messageVisibility', () => {
  it('скрывает служебный tool-chain (metadata.tool_chain === true)', () => {
    expect(isVisibleMessage({ metadata: { tool_chain: true } })).toBe(false)
    expect(isStateMessage({ metadata: { tool_chain: true } })).toBe(false)
  })

  it('скрывает state-сообщения по metadata.state === true', () => {
    expect(isVisibleMessage({ metadata: { state: true } })).toBe(false)
  })

  it('скрывает state-сообщения по metadata.type из STATE_MESSAGE_TYPES', () => {
    for (const type of STATE_MESSAGE_TYPES) {
      expect(isVisibleMessage({ metadata: { type } })).toBe(false)
      expect(isStateMessage({ metadata: { type } })).toBe(true)
    }
  })

  it('пропускает обычные сообщения', () => {
    expect(isVisibleMessage({ metadata: undefined })).toBe(true)
    expect(isVisibleMessage({ metadata: null })).toBe(true)
    expect(isVisibleMessage({ metadata: {} })).toBe(true)
    expect(isVisibleMessage({ metadata: { tool_chain: false } })).toBe(true)
    expect(isVisibleMessage({ metadata: { type: 'unknown_type' } })).toBe(true)
  })
})
