import { describe, it, expect } from 'vitest'
import {
  resolveIconName,
  resolveIconColor,
  resolveSessionIconColor,
  DEFAULT_SESSION_ICON_COLOR,
} from './entityIcon'

describe('resolveIconName — единый резолвер иконок (ADR-075)', () => {
  it('канонические ключи реестра → имя иконки', () => {
    expect(resolveIconName('code')).toBe('code-box')
    expect(resolveIconName('rocket')).toBe('rocket')
    expect(resolveIconName('phone')).toBe('smartphone')
    expect(resolveIconName('database')).toBe('database-2')
  })

  it('произвольная строка/эмодзи → undefined (а не «дырка»/null-рендер)', () => {
    expect(resolveIconName('🚀')).toBeUndefined()
    expect(resolveIconName('folder-3')).toBeUndefined()
    expect(resolveIconName('no-such-key')).toBeUndefined()
  })

  it('null/undefined/пустая строка → undefined', () => {
    expect(resolveIconName(null)).toBeUndefined()
    expect(resolveIconName(undefined)).toBeUndefined()
    expect(resolveIconName('')).toBeUndefined()
  })
})

describe('resolveIconColor — единый резолвер цветов (ADR-075)', () => {
  it('канонические ключи → CSS-переменные палитры', () => {
    expect(resolveIconColor('a11')).toBe('var(--palette-11)')
    expect(resolveIconColor('a1')).toBe('var(--palette-1)')
    expect(resolveIconColor('a7')).toBe('var(--palette-7)')
  })

  it('legacy-алиасы больше не нормализуются → undefined', () => {
    expect(resolveIconColor('blue')).toBeUndefined()
    expect(resolveIconColor('red')).toBeUndefined()
    expect(resolveIconColor('--syntax-keyword')).toBeUndefined()
  })

  it('неизвестное значение → undefined', () => {
    expect(resolveIconColor('chartreuse')).toBeUndefined()
    expect(resolveIconColor(null)).toBeUndefined()
    expect(resolveIconColor(undefined)).toBeUndefined()
  })
})

describe('resolveSessionIconColor — дефолт иконки сессии (акцент открытой сессии)', () => {
  it('заданный канонический ключ → CSS-переменная (как у обычного резолвера)', () => {
    expect(resolveSessionIconColor('a7')).toBe('var(--palette-7)')
    expect(resolveSessionIconColor('a11')).toBe('var(--palette-11)')
  })

  it('пустой/неизвестный цвет → дефолтный акцент --primary', () => {
    expect(DEFAULT_SESSION_ICON_COLOR).toBe('var(--primary)')
    expect(resolveSessionIconColor(undefined)).toBe('var(--primary)')
    expect(resolveSessionIconColor(null)).toBe('var(--primary)')
    expect(resolveSessionIconColor('')).toBe('var(--primary)')
    expect(resolveSessionIconColor('chartreuse')).toBe('var(--primary)')
  })
})
