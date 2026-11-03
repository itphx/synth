import { describe, it, expect } from 'vitest'
import { isExternalOrAnchor, resolveRelativePath, splitFilePath } from './relativeAssets'

describe('isExternalOrAnchor', () => {
  it('якоря и protocol-relative — не относительные', () => {
    expect(isExternalOrAnchor('#anchor')).toBe(true)
    expect(isExternalOrAnchor('  #anchor  ')).toBe(true)
    expect(isExternalOrAnchor('//cdn.example.com/a.png')).toBe(true)
  })

  it('схемы URL (https/mailto/data/tel) — не относительные', () => {
    expect(isExternalOrAnchor('https://example.com/a.png')).toBe(true)
    expect(isExternalOrAnchor('HTTP://example.com')).toBe(true)
    expect(isExternalOrAnchor('mailto:user@example.com')).toBe(true)
    expect(isExternalOrAnchor('data:image/png;base64,AAAA')).toBe(true)
    expect(isExternalOrAnchor('tel:+70000000000')).toBe(true)
  })

  it('пустая строка и обычные пути — относительные', () => {
    expect(isExternalOrAnchor('')).toBe(true)
    expect(isExternalOrAnchor('img.png')).toBe(false)
    expect(isExternalOrAnchor('/root.png')).toBe(false)
    expect(isExternalOrAnchor('./docs/a.md')).toBe(false)
    expect(isExternalOrAnchor('../a.png')).toBe(false)
  })
})

describe('splitFilePath', () => {
  it('файл в корне: пустой каталог', () => {
    expect(splitFilePath('img.png')).toEqual({ dir: '', name: 'img.png' })
  })

  it('файл в каталоге', () => {
    expect(splitFilePath('docs/a.md')).toEqual({ dir: 'docs', name: 'a.md' })
    expect(splitFilePath('docs/nested/a.md')).toEqual({ dir: 'docs/nested', name: 'a.md' })
  })

  it('обратные слэши нормализуются', () => {
    expect(splitFilePath('docs\\a.md')).toEqual({ dir: 'docs', name: 'a.md' })
  })
})

describe('resolveRelativePath', () => {
  it('из корня workspace', () => {
    expect(resolveRelativePath('', 'img.png')).toBe('img.png')
  })

  it('из каталога документа', () => {
    expect(resolveRelativePath('docs', 'img.png')).toBe('docs/img.png')
    expect(resolveRelativePath('docs/nested', 'img.png')).toBe('docs/nested/img.png')
  })

  it('./ — остаётся в каталоге документа', () => {
    expect(resolveRelativePath('docs', './a.png')).toBe('docs/a.png')
    expect(resolveRelativePath('', './a.png')).toBe('a.png')
  })

  it('../ — поднимается на уровень выше', () => {
    expect(resolveRelativePath('docs', '../a.png')).toBe('a.png')
    expect(resolveRelativePath('docs/nested', '../a.png')).toBe('docs/a.png')
    expect(resolveRelativePath('docs/nested', '../../a.png')).toBe('a.png')
  })

  it('ведущий / — корень workspace (каталог документа игнорируется)', () => {
    expect(resolveRelativePath('docs/nested', '/root.png')).toBe('root.png')
  })

  it('выход выше корня — null (вне workspace не подставляем)', () => {
    expect(resolveRelativePath('', '../../escape.png')).toBeNull()
    expect(resolveRelativePath('docs', '../../escape.png')).toBeNull()
    expect(resolveRelativePath('docs/nested', '../../../escape.png')).toBeNull()
  })

  it('query/hash отбрасываются', () => {
    expect(resolveRelativePath('docs', 'img.png?x=1#frag')).toBe('docs/img.png')
    expect(resolveRelativePath('docs', './a.md#anchor')).toBe('docs/a.md')
    expect(resolveRelativePath('docs', 'img.png?query#hash')).toBe('docs/img.png')
  })

  it('цель из одного query/hash — null', () => {
    expect(resolveRelativePath('docs', '?query')).toBeNull()
    expect(resolveRelativePath('docs', '?query#hash')).toBeNull()
    expect(resolveRelativePath('docs', '#hash')).toBeNull()
  })

  it('URL-кодированные имена декодируются (кодирование сделает URLSearchParams)', () => {
    expect(resolveRelativePath('docs', '%D1%84.png')).toBe('docs/ф.png')
    expect(resolveRelativePath('docs', 'a%20b.png')).toBe('docs/a b.png')
  })

  it('имена с пробелами сохраняются как есть', () => {
    expect(resolveRelativePath('docs', 'a b.png')).toBe('docs/a b.png')
  })

  it('обратные слэши трактуются как разделители', () => {
    expect(resolveRelativePath('docs', 'sub\\img.png')).toBe('docs/sub/img.png')
    expect(resolveRelativePath('docs', '..\\img.png')).toBe('img.png')
  })

  it('не относительные цели — null', () => {
    expect(resolveRelativePath('docs', '#anchor')).toBeNull()
    expect(resolveRelativePath('docs', 'https://example.com/a.png')).toBeNull()
    expect(resolveRelativePath('docs', 'mailto:user@example.com')).toBeNull()
    expect(resolveRelativePath('docs', '//cdn.example.com/a.png')).toBeNull()
  })

  it('пустая цель — null', () => {
    expect(resolveRelativePath('docs', '')).toBeNull()
    expect(resolveRelativePath('docs', '   ')).toBeNull()
  })

  it('кодированная попытка выхода выше корня тоже отбрасывается', () => {
    expect(resolveRelativePath('docs', '..%2F..%2Fescape.png')).toBeNull()
  })
})
