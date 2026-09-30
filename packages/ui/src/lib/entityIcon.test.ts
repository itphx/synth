import { describe, it, expect } from 'vitest'
import { resolveIconName, resolveIconColor } from './entityIcon'

describe('resolveIconName — единый резолвер иконок (AD-075)', () => {
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

describe('resolveIconColor — единый резолвер цветов (AD-075)', () => {
  it('канонические ключи → CSS-переменные палитры', () => {
    expect(resolveIconColor('primary')).toBe('var(--primary)')
    expect(resolveIconColor('error')).toBe('var(--status-error)')
    expect(resolveIconColor('success')).toBe('var(--status-success)')
  })

  it('legacy-алиасы нормализуются при чтении', () => {
    expect(resolveIconColor('blue')).toBe('var(--primary)')
    expect(resolveIconColor('red')).toBe('var(--status-error)')
    expect(resolveIconColor('--syntax-keyword')).toBe('var(--syntax-keyword)')
  })

  it('неизвестное значение → undefined', () => {
    expect(resolveIconColor('chartreuse')).toBeUndefined()
    expect(resolveIconColor(null)).toBeUndefined()
    expect(resolveIconColor(undefined)).toBeUndefined()
  })
})
