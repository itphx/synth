import { describe, it, expect } from 'vitest'

import { formatMessage, type I18nDictionary } from './store'
import { pluralCategory } from './plural'
import { dict as enDict } from './messages/en'
import { dict as ruDict } from './messages/ru'

describe('pluralCategory', () => {
  it('ru: one / few / many по правилам CLDR', () => {
    const expected: Array<[number, string]> = [
      [1, 'one'],
      [2, 'few'],
      [5, 'many'],
      [11, 'many'],
      [12, 'many'],
      [21, 'one'],
      [22, 'few'],
      [25, 'many'],
      [101, 'one'],
      [111, 'many'],
    ]
    for (const [count, category] of expected) {
      expect(pluralCategory('ru', count), `ru ${count}`).toBe(category)
    }
  })

  it('ru: не-целые и отрицательные — other / по модулю', () => {
    expect(pluralCategory('ru', 1.5)).toBe('other')
    expect(pluralCategory('ru', -1)).toBe('one')
    expect(pluralCategory('ru', -2)).toBe('few')
    expect(pluralCategory('ru', -5)).toBe('many')
  })

  it('en: 1 → one, остальное → other', () => {
    expect(pluralCategory('en', 0)).toBe('other')
    expect(pluralCategory('en', 1)).toBe('one')
    expect(pluralCategory('en', 2)).toBe('other')
    expect(pluralCategory('en', -1)).toBe('one')
    expect(pluralCategory('en', 1.5)).toBe('other')
  })
})

describe('formatMessage: plural-формы', () => {
  it('en: одна и много', () => {
    expect(formatMessage(enDict, 'mcp.count', { count: 1 }, 'en')).toBe('1 server')
    expect(formatMessage(enDict, 'mcp.count', { count: 5 }, 'en')).toBe('5 servers')
  })

  it('ru: one / few / many', () => {
    expect(formatMessage(ruDict, 'mcp.count', { count: 1 }, 'ru')).toBe('1 сервер')
    expect(formatMessage(ruDict, 'mcp.count', { count: 2 }, 'ru')).toBe('2 сервера')
    expect(formatMessage(ruDict, 'mcp.count', { count: 5 }, 'ru')).toBe('5 серверов')
    expect(formatMessage(ruDict, 'mcp.count', { count: 21 }, 'ru')).toBe('21 сервер')
    expect(formatMessage(ruDict, 'mcp.count', { count: 11 }, 'ru')).toBe('11 серверов')
  })

  it('locale по умолчанию — en, если не передан', () => {
    expect(formatMessage(enDict, 'mcp.count', { count: 1 })).toBe('1 server')
  })

  it('# → число, внутри формы работает интерполяция {param}', () => {
    const dict: I18nDictionary = {
      hello: '{count, plural, one {# друг, {name}} few {# друга, {name}} many {# друзей, {name}}}',
    }
    expect(formatMessage(dict, 'hello', { count: 5, name: 'Ира' }, 'ru')).toBe('5 друзей, Ира')
    expect(formatMessage(dict, 'hello', { count: 1, name: 'Ира' }, 'ru')).toBe('1 друг, Ира')
  })

  it('вложенный plural внутри формы', () => {
    const dict: I18nDictionary = {
      nested:
        '{count, plural, one {{sub, plural, one {# яблоко} other {# яблока}}} other {# яблок}}',
    }
    expect(formatMessage(dict, 'nested', { count: 1, sub: 2 }, 'ru')).toBe('2 яблока')
    expect(formatMessage(dict, 'nested', { count: 5, sub: 1 }, 'ru')).toBe('5 яблок')
  })

  it('несколько независимых plural-блоков в одной строке', () => {
    expect(
      formatMessage(enDict, 'admin.models.count', { visible: 3, total: 1, providers: 2 }, 'en'),
    ).toBe('3 / 1 model in 2 providers')
    expect(
      formatMessage(ruDict, 'admin.models.count', { visible: 3, total: 1, providers: 2 }, 'ru'),
    ).toBe('3 / 1 модель в 2 провайдерах')
  })

  it('fallback формы: other → many → one → few → zero → two', () => {
    expect(formatMessage({ k: '{n, plural, other {# всего}}' }, 'k', { n: 1 }, 'ru')).toBe('1 всего')
    expect(formatMessage({ k: '{n, plural, one {# one}}' }, 'k', { n: 5 }, 'ru')).toBe('5 one')
    expect(formatMessage({ k: '{n, plural, few {# few}}' }, 'k', { n: 5 }, 'ru')).toBe('5 few')
  })

  it('обычная интерполяция не изменилась', () => {
    expect(formatMessage({ k: 'a {b} c' }, 'k', { b: 7 })).toBe('a 7 c')
    // отсутствующий параметр остаётся как есть
    expect(formatMessage({ k: 'a {b} c' }, 'k', {})).toBe('a {b} c')
    // без params шаблон возвращается как есть
    expect(formatMessage({ k: 'a {b} c' }, 'k')).toBe('a {b} c')
    // plural-блок с отсутствующим параметром остаётся как есть
    const pluralDict = { k: '{n, plural, one {# x} other {# xs}}' }
    expect(formatMessage(pluralDict, 'k', { other: 3 }, 'en')).toBe(
      '{n, plural, one {# x} other {# xs}}',
    )
  })

  it('неизвестный ключ → сам ключ', () => {
    expect(formatMessage(enDict, 'no.such.key')).toBe('no.such.key')
    expect(formatMessage({}, 'no.such.key', { count: 1 }, 'ru')).toBe('no.such.key')
  })
})

describe('словари: плюрализация счётчиков (поведенческая проверка)', () => {
  const cases: Array<[string, Record<string, number | string>, 'en' | 'ru', string]> = [
    ['mcp.count', { count: 1 }, 'en', '1 server'],
    ['mcp.count', { count: 5 }, 'ru', '5 серверов'],
    ['admin.sessions.count', { count: 2 }, 'ru', '2 сессии'],
    ['admin.projects.count', { count: 1 }, 'ru', '1 проект'],
    ['admin.users.count', { count: 3 }, 'ru', '3 пользователя'],
    ['admin.context.count', { count: 2, status: '' }, 'ru', '2 файла'],
  ]

  it('выдаёт корректные формы', () => {
    for (const [key, params, locale, expected] of cases) {
      const dict = locale === 'en' ? enDict : ruDict
      expect(formatMessage(dict, key, params, locale), `${locale} ${key}`).toBe(expected)
    }
  })

  it('в выводе нет сырых plural/#/{', () => {
    for (const [key, params, locale] of cases) {
      const dict = locale === 'en' ? enDict : ruDict
      const out = formatMessage(dict, key, params, locale)
      expect(out, `${locale} ${key}`).not.toMatch(/plural|#|\{|\}/)
    }
  })
})
