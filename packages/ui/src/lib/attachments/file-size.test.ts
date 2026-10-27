import { describe, it, expect } from 'vitest'
import { formatFileSize } from './file-size'

describe('formatFileSize', () => {
  it('байты — целым числом', () => {
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('килобайты — с одним знаком после запятой', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1024.0 KB')
  })

  it('мегабайты — с одним знаком после запятой', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('нулевое и нечисловое значение — пустая строка', () => {
    expect(formatFileSize(0)).toBe('')
    expect(formatFileSize(-10)).toBe('')
    expect(formatFileSize(Number.NaN)).toBe('')
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('')
  })
})
