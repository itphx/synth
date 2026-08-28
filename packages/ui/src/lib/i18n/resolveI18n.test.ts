import { describe, it, expect } from 'vitest'

import { resolveI18n, isValidI18nMeta } from './resolveI18n'
import { dict as ruDict } from './messages/ru'
import { dict as enDict } from './messages/en'

describe('isValidI18nMeta', () => {
  it('валидная структура { key } → true', () => {
    expect(isValidI18nMeta({ key: 'micro.greeting' })).toBe(true)
    expect(isValidI18nMeta({ key: 'fs.file_written', params: { path: '/a' } })).toBe(true)
  })

  it('мусор из metadata (unknown) → false', () => {
    expect(isValidI18nMeta(undefined)).toBe(false)
    expect(isValidI18nMeta(null)).toBe(false)
    expect(isValidI18nMeta('micro.greeting')).toBe(false)
    expect(isValidI18nMeta(42)).toBe(false)
    expect(isValidI18nMeta({})).toBe(false)
    expect(isValidI18nMeta({ key: '' })).toBe(false)
    expect(isValidI18nMeta({ key: 123 })).toBe(false)
  })
})

describe('resolveI18n (ru-словарь)', () => {
  it('ключ есть в словаре → перевод', () => {
    expect(resolveI18n({ key: 'micro.greeting' }, 'Hi! How can I help you?', ruDict)).toBe(
      'Привет! Чем могу помочь?',
    )
    expect(resolveI18n({ key: 'session.default_title' }, 'New session', ruDict)).toBe('Новая сессия')
  })

  it('params-интерполяция {param}', () => {
    expect(
      resolveI18n(
        { key: 'fs.file_written', params: { path: '/tmp/a.ts', lines: '10', bytes: '512' } },
        'File written: /tmp/a.ts (10 lines, 512 bytes)',
        ruDict,
      ),
    ).toBe('Файл записан: /tmp/a.ts (10 строк, 512 байт)')
  })

  it('ключа нет в словаре → fallback на content (en), а не на сам ключ', () => {
    expect(resolveI18n({ key: 'no.such.key' }, 'English content', ruDict)).toBe('English content')
  })

  it('неизвестный ключ при пустом content → пустая строка (не ключ)', () => {
    expect(resolveI18n({ key: 'no.such.key' }, '', ruDict)).toBe('')
  })

  it('metadata.i18n отсутствует / мусор → content как есть', () => {
    const content = 'English content'
    expect(resolveI18n(undefined, content, ruDict)).toBe(content)
    expect(resolveI18n(null, content, ruDict)).toBe(content)
    expect(resolveI18n('micro.greeting', content, ruDict)).toBe(content)
    expect(resolveI18n({}, content, ruDict)).toBe(content)
  })

  it('prototype-ключи (toString) не считаются найденными в словаре', () => {
    expect(resolveI18n({ key: 'toString' }, 'English content', ruDict)).toBe('English content')
    expect(resolveI18n({ key: 'constructor' }, 'English content', ruDict)).toBe('English content')
  })

  it('существующие UI-ключи продолжают работать (не затронуты)', () => {
    expect(resolveI18n({ key: 'common.empty' }, 'Empty', ruDict)).toBe('Пусто')
  })
})

describe('resolveI18n (en-словарь, core-ключи не дублируются)', () => {
  it('core-ключа нет в enDict → fallback на content (en)', () => {
    expect(resolveI18n({ key: 'micro.greeting' }, 'Hi! How can I help you?', enDict)).toBe(
      'Hi! How can I help you?',
    )
  })

  it('UI-ключи в enDict работают как раньше', () => {
    expect(resolveI18n({ key: 'common.empty' }, 'Empty', enDict)).toBe('Empty')
  })
})
