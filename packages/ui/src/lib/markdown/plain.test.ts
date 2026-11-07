import { describe, it, expect } from 'vitest'
import { clipPlainText, markdownToPlain } from './plain'

/**
 * `markdownToPlain` — plain-превью для свёрнутых строк (PROP-054).
 *
 * Важно: разбор идёт через `marked.lexer`, HTML **не строится** и в DOM не
 * вставляется — поэтому XSS невозможен (в отличие от `dangerouslySetInnerHTML`).
 */
describe('markdownToPlain: markdown → текст без разметки', () => {
  it('снимает маркеры выделения и инлайн-кода', () => {
    expect(markdownToPlain('**жирный**')).toBe('жирный')
    expect(markdownToPlain('`код`')).toBe('код')
  })

  it('ссылка → подпись', () => {
    expect(markdownToPlain('[текст](https://example.com)')).toBe('текст')
  })

  it('список остаётся списком', () => {
    expect(markdownToPlain('- один\n- два')).toBe('- один\n- два')
  })

  it('сырой HTML вырезается, текст остаётся', () => {
    expect(markdownToPlain('текст <b>важный</b>')).toBe('текст важный')
  })

  it('пустая строка на входе — пустая на выходе', () => {
    expect(markdownToPlain('')).toBe('')
  })

  it('не строит HTML (нет тегов в результате)', () => {
    expect(markdownToPlain('<script>alert(1)</script>')).not.toContain('<script>')
  })
})

describe('clipPlainText: обрезка превью', () => {
  it('обрезает по длине и добавляет многоточие', () => {
    expect(clipPlainText('абвгд', 3)).toBe('абв…')
  })

  it('короткий текст не трогает', () => {
    expect(clipPlainText('абв', 10)).toBe('абв')
  })

  it('без лимита текст не трогают', () => {
    expect(clipPlainText('абвгд')).toBe('абвгд')
  })
})
