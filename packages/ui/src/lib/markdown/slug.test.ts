import { describe, it, expect } from 'vitest'

import { createSlugger, FALLBACK_HEADING_SLUG, slugifyHeading } from './slug'

describe('slugifyHeading: алгоритм GitHub', () => {
  it('кириллица сохраняется, регистр понижается', () => {
    expect(slugifyHeading('Раздел')).toBe('раздел')
    expect(slugifyHeading('БОЛЬШИЕ БУКВЫ')).toBe('большие-буквы')
  })

  it('латиница и цифры', () => {
    expect(slugifyHeading('Getting Started')).toBe('getting-started')
    expect(slugifyHeading('API v2')).toBe('api-v2')
  })

  it('пунктуация и эмодзи удаляются', () => {
    expect(slugifyHeading('Что нового? 🎉')).toBe('что-нового')
    expect(slugifyHeading('a.b, c:d; e!')).toBe('ab-cd-e')
    expect(slugifyHeading('(скобки) [квадратные] {фигурные}')).toBe('скобки-квадратные-фигурные')
  })

  it('markdown-разметка в тексте не попадает в slug', () => {
    expect(slugifyHeading('**Жирный** пункт')).toBe('жирный-пункт')
    expect(slugifyHeading('`code` в заголовке')).toBe('code-в-заголовке')
    expect(slugifyHeading('[ссылка](https://example.com)')).toBe('ссылкаhttpsexamplecom')
  })

  it('HTML-теги вырезаются', () => {
    expect(slugifyHeading('Раздел <span class="x">важный</span>')).toBe('раздел-важный')
  })

  it('пробелы, табы и переводы строк → один дефис', () => {
    expect(slugifyHeading('  много   пробелов  ')).toBe('много-пробелов')
    expect(slugifyHeading('строка\tвторая\nтретья')).toBe('строка-вторая-третья')
  })

  it('повторные и крайние дефисы схлопываются/срезаются', () => {
    expect(slugifyHeading('---раздел---')).toBe('раздел')
    expect(slugifyHeading('a - - b')).toBe('a-b')
    expect(slugifyHeading('a--b')).toBe('a-b')
  })

  it('подчёркивания сохраняются', () => {
    expect(slugifyHeading('snake_case имя')).toBe('snake_case-имя')
  })

  it('пустой результат — детерминированный фоллбек', () => {
    expect(slugifyHeading('!!!')).toBe(FALLBACK_HEADING_SLUG)
    expect(slugifyHeading('🎉🎉')).toBe(FALLBACK_HEADING_SLUG)
    expect(slugifyHeading('---')).toBe(FALLBACK_HEADING_SLUG)
    expect(slugifyHeading('')).toBe(FALLBACK_HEADING_SLUG)
    expect(FALLBACK_HEADING_SLUG).toBe('section')
  })
})

describe('createSlugger: уникализация в документе', () => {
  it('дубликаты получают -1, -2, …', () => {
    const slug = createSlugger()
    expect(slug('a')).toBe('a')
    expect(slug('a')).toBe('a-1')
    expect(slug('a')).toBe('a-2')
  })

  it('уникализация не зависит от регистра и разметки', () => {
    const slug = createSlugger()
    expect(slug('Раздел')).toBe('раздел')
    expect(slug('РАЗДЕЛ')).toBe('раздел-1')
    expect(slug('**Раздел**')).toBe('раздел-2')
  })

  it('литеральный суффикс не сталкивается с уже выданным', () => {
    const slug = createSlugger()
    expect(slug('a')).toBe('a')
    expect(slug('a-1')).toBe('a-1')
    expect(slug('a')).toBe('a-2')
  })

  it('пустые slug’и уникализируются от фоллбека', () => {
    const slug = createSlugger()
    expect(slug('!!!')).toBe('section')
    expect(slug('???')).toBe('section-1')
  })

  it('новый slugger начинает счёт заново (документ — новый счётчик)', () => {
    const first = createSlugger()
    expect(first('a')).toBe('a')
    expect(first('a')).toBe('a-1')

    const second = createSlugger()
    expect(second('a')).toBe('a')
  })
})
