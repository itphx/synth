import { describe, it, expect } from 'vitest'
import {
  RECOVERABLE_ERROR_TYPES,
  isRecoverableErrorType,
  resolveStreamErrorAction,
} from './streamErrors'

describe('isRecoverableErrorType (B6 resolve-логика: какие ошибки показывают кнопку «Повторить»)', () => {
  it('recoverable-типы → true', () => {
    for (const t of RECOVERABLE_ERROR_TYPES) {
      expect(isRecoverableErrorType(t)).toBe(true)
    }
  })

  it('network/timeout/rate_limit/server_error → true', () => {
    expect(isRecoverableErrorType('network')).toBe(true)
    expect(isRecoverableErrorType('timeout')).toBe(true)
    expect(isRecoverableErrorType('rate_limit')).toBe(true)
    expect(isRecoverableErrorType('server_error')).toBe(true)
  })

  it('context_length и auth → false (повтор бессмысленен)', () => {
    expect(isRecoverableErrorType('context_length')).toBe(false)
    expect(isRecoverableErrorType('auth')).toBe(false)
  })

  it('неизвестные/пустые типы → false', () => {
    expect(isRecoverableErrorType('unknown')).toBe(false)
    expect(isRecoverableErrorType('internal')).toBe(false)
    expect(isRecoverableErrorType('resume_failed')).toBe(false)
    expect(isRecoverableErrorType('')).toBe(false)
    expect(isRecoverableErrorType(null)).toBe(false)
    expect(isRecoverableErrorType(undefined)).toBe(false)
  })
})

describe('resolveStreamErrorAction (B6: действие по финальной ошибке стрима)', () => {
  it('recoverable → retry (кнопка «Повторить»)', () => {
    expect(resolveStreamErrorAction('network')).toBe('retry')
    expect(resolveStreamErrorAction('timeout')).toBe('retry')
    expect(resolveStreamErrorAction('rate_limit')).toBe('retry')
    expect(resolveStreamErrorAction('server_error')).toBe('retry')
  })

  it('context_length/auth → info (только текст)', () => {
    expect(resolveStreamErrorAction('context_length')).toBe('info')
    expect(resolveStreamErrorAction('auth')).toBe('info')
  })

  it('отсутствие типа → info', () => {
    expect(resolveStreamErrorAction(undefined)).toBe('info')
    expect(resolveStreamErrorAction(null)).toBe('info')
  })
})
