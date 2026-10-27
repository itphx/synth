import { describe, it, expect } from 'vitest'
import {
  LARGE_TEXT_PASTE_CHAR_THRESHOLD,
  LARGE_TEXT_PASTE_LINE_THRESHOLD,
  buildPastedTextFile,
  shouldOfferLargeTextPaste,
} from './large-text-paste'

describe('shouldOfferLargeTextPaste', () => {
  it('короткий текст — не предлагаем', () => {
    expect(shouldOfferLargeTextPaste('привет')).toBe(false)
    expect(shouldOfferLargeTextPaste('одна строка')).toBe(false)
  })

  it('пустой и пробельный текст — никогда', () => {
    expect(shouldOfferLargeTextPaste('')).toBe(false)
    expect(shouldOfferLargeTextPaste('   \n  \n')).toBe(false)
  })

  it('длинный текст — предлагаем (порог по символам)', () => {
    const long = 'a'.repeat(LARGE_TEXT_PASTE_CHAR_THRESHOLD)
    expect(shouldOfferLargeTextPaste(long)).toBe(true)
    expect(shouldOfferLargeTextPaste('a'.repeat(LARGE_TEXT_PASTE_CHAR_THRESHOLD - 1))).toBe(false)
  })

  it('многострочный текст — предлагаем (порог по строкам)', () => {
    const lines = Array.from({ length: LARGE_TEXT_PASTE_LINE_THRESHOLD }, (_, index) => `line-${index}`)
    expect(shouldOfferLargeTextPaste(lines.join('\n'))).toBe(true)
    const fewer = lines.slice(0, LARGE_TEXT_PASTE_LINE_THRESHOLD - 1)
    expect(shouldOfferLargeTextPaste(fewer.join('\n'))).toBe(false)
  })
})

describe('buildPastedTextFile', () => {
  it('имя — pasted-text-<ISO>.txt, тип — text/plain', () => {
    const now = new Date('2024-05-05T12:00:00.123Z')
    const file = buildPastedTextFile('текст', now)

    expect(file.name).toBe('pasted-text-2024-05-05T12:00:00.123Z.txt')
    expect(file.type).toBe('text/plain')
    expect(file.size).toBe(new TextEncoder().encode('текст').length)
    expect(file.lastModified).toBe(now.getTime())
  })

  it('без явной даты — имя с текущим временем', () => {
    const file = buildPastedTextFile('текст')
    expect(file.name).toMatch(/^pasted-text-.+\.txt$/)
  })

  it('содержимое файла совпадает с исходным текстом', async () => {
    const file = buildPastedTextFile('строка 1\nстрока 2')
    await expect(file.text()).resolves.toBe('строка 1\nстрока 2')
  })
})
