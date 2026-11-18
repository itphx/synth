import { describe, it, expect } from 'vitest'
import {
  MAX_CODE_VIEW_CHARS,
  MAX_CODE_VIEW_LINES,
  isCodeViewSupported,
} from './codeEditor'

describe('isCodeViewSupported — предел CodeMirror', () => {
  it('обычный текст поддерживается', () => {
    expect(isCodeViewSupported('const a = 1\nconst b = 2\n')).toBe(true)
    expect(isCodeViewSupported('')).toBe(true)
  })

  it('ровно на лимите символов — поддерживается, на символ больше — нет', () => {
    expect(isCodeViewSupported('a'.repeat(MAX_CODE_VIEW_CHARS))).toBe(true)
    expect(isCodeViewSupported('a'.repeat(MAX_CODE_VIEW_CHARS + 1))).toBe(false)
  })

  it('ровно на лимите строк — поддерживается, на строку больше — нет', () => {
    // N строк = N-1 переводов строки.
    const atLimit = `${'a\n'.repeat(MAX_CODE_VIEW_LINES - 1)}a`
    expect(atLimit.split('\n')).toHaveLength(MAX_CODE_VIEW_LINES)
    expect(isCodeViewSupported(atLimit)).toBe(true)

    const overLimit = `a\n${atLimit}`
    expect(overLimit.split('\n')).toHaveLength(MAX_CODE_VIEW_LINES + 1)
    expect(isCodeViewSupported(overLimit)).toBe(false)
  })

  it('много коротких строк отсекается по числу строк, а не по символам', () => {
    const text = '\n'.repeat(MAX_CODE_VIEW_LINES)
    expect(text.length).toBeLessThan(MAX_CODE_VIEW_CHARS)
    expect(isCodeViewSupported(text)).toBe(false)
  })
})
