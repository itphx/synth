import { describe, it, expect } from 'vitest'
import { ENGINE_MESSAGE_KEYS } from '@itphx/synth-shared/i18n'
import { dict as ruDict } from './ru'
import { dict as enDict } from './en'

const engineKeys = new Set<string>(ENGINE_MESSAGE_KEYS)
const en: Record<string, string> = enDict
const ru: Record<string, string> = ruDict
const has = (dict: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(dict, key)

/** Индекс закрывающей `}` для блока, открытого на позиции start. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Индекс первого символа на нулевом уровне вложенности `{}`. */
function topLevelIndex(text: string, char: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    else if (text[i] === char && depth === 0) return i
  }
  return -1
}

/**
 * Имена `{param}` в шаблоне. Plural-блок `{name, plural, ...}` даёт один параметр
 * `name`; содержимое его форм — текст перевода и параметрами не считается.
 */
function extractUiParams(template: string): string[] {
  const params = new Set<string>()
  let i = 0
  while (i < template.length) {
    if (template[i] !== '{') {
      i++
      continue
    }
    const end = balancedEnd(template, i)
    if (end === -1) {
      i++
      continue
    }
    const inner = template.slice(i + 1, end)
    const comma = topLevelIndex(inner, ',')
    if (comma !== -1) {
      const name = inner.slice(0, comma).trim()
      const rest = inner.slice(comma + 1)
      const second = topLevelIndex(rest, ',')
      if (second !== -1 && rest.slice(0, second).trim() === 'plural') {
        params.add(name)
        i = end + 1
        continue
      }
    }
    params.add(inner.trim())
    i = end + 1
  }
  return [...params].sort()
}

/**
 * Паритет UI-словарей en ↔ ru. Движковые ключи (AD-041) живут в ru и
 * синхронизируются отдельным тестом `engine-keys.test.ts`, поэтому в обратную
 * сторону (ru → en) они исключаются.
 */
describe('UI-словари en ↔ ru (паритет)', () => {
  it('каждый en-ключ имеет ru-перевод', () => {
    const missing = Object.keys(en).filter((key) => !has(ru, key))
    expect(missing, `ключи без ru-перевода: ${missing.join(', ')}`).toEqual([])
  })

  it('каждый не-движковый ru-ключ имеет en-шаблон', () => {
    const extra = Object.keys(ru).filter((key) => !engineKeys.has(key) && !has(en, key))
    expect(extra, `ru-ключи без en-шаблона: ${extra.join(', ')}`).toEqual([])
  })

  it('набор {param} совпадает для общих ключей', () => {
    const mismatches: string[] = []
    for (const key of Object.keys(en)) {
      if (!has(ru, key)) continue
      const enParams = extractUiParams(en[key]!)
      const ruParams = extractUiParams(ru[key]!)
      if (JSON.stringify(enParams) !== JSON.stringify(ruParams)) {
        mismatches.push(`${key}: en=[${enParams.join(',')}] ru=[${ruParams.join(',')}]`)
      }
    }
    expect(mismatches, `расхождения параметров:\n${mismatches.join('\n')}`).toEqual([])
  })
})
