import { describe, it, expect } from 'vitest'
import {
  isExternalOrAnchor,
  resolveRelativePath,
  rewriteRelativeAssets,
  splitFilePath,
} from './relativeAssets'

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

describe('rewriteRelativeAssets', () => {
  /** Резолвер вкладки файла: путь → URL предпросмотра в workspace. */
  const resolve = (target: string) => `/api/v2/fs/raw?path=${target}`
  const rewrite = (html: string) => rewriteRelativeAssets(html, resolve)

  function parse(html: string): HTMLElement {
    const doc = new DOMParser().parseFromString(rewrite(html), 'text/html')
    return doc.body
  }

  it('сырой HTML: относительный src картинки переписывается, размеры сохраняются', () => {
    const body = parse('<img src="docs/a.png" alt="A" width="96" height="24">')

    const img = body.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/api/v2/fs/raw?path=docs/a.png')
    expect(img.getAttribute('alt')).toBe('A')
    expect(img.getAttribute('width')).toBe('96')
    expect(img.getAttribute('height')).toBe('24')
  })

  it('сырой HTML: ссылка на файл → href="#" + data-file-path (путь из разметки)', () => {
    const body = parse('<a href="docs/a.md" title="файл">Файл</a>')

    const link = body.querySelector('a')!
    expect(link.getAttribute('href')).toBe('#')
    expect(link.getAttribute('data-file-path')).toBe('docs/a.md')
    expect(link.getAttribute('title')).toBe('файл')
  })

  it('picture/source: переписаны и srcset, и src; media сохранён', () => {
    const body = parse(
      '<picture><source srcset="docs/dark.svg" media="(prefers-color-scheme: dark)"><img src="docs/light.svg" alt="Synth" width="96"></picture>',
    )

    const source = body.querySelector('source')!
    expect(source.getAttribute('srcset')).toBe('/api/v2/fs/raw?path=docs/dark.svg')
    expect(source.getAttribute('media')).toBe('(prefers-color-scheme: dark)')
    expect(body.querySelector('picture img')!.getAttribute('src')).toBe(
      '/api/v2/fs/raw?path=docs/light.svg',
    )
  })

  it('srcset с дескрипторами: относительные переписаны, дескрипторы сохранены', () => {
    const body = parse('<img srcset="a.png 1x, b.png 2x" src="a.png">')

    expect(body.querySelector('img')!.getAttribute('srcset')).toBe(
      '/api/v2/fs/raw?path=a.png 1x, /api/v2/fs/raw?path=b.png 2x',
    )
  })

  it('srcset с ширинами и абсолютными URL: абсолютные не трогаются', () => {
    const body = parse(
      '<img srcset="a.png 100w, https://cdn.example.com/b.png 200w, //cdn.example.com/c.png 300w">',
    )

    expect(body.querySelector('img')!.getAttribute('srcset')).toBe(
      '/api/v2/fs/raw?path=a.png 100w, https://cdn.example.com/b.png 200w, //cdn.example.com/c.png 300w',
    )
  })

  it('srcset с data: URI не разбивается внутренней запятой', () => {
    const body = parse('<img srcset="data:image/png;base64,AAAA 1x, a.png 2x">')

    expect(body.querySelector('img')!.getAttribute('srcset')).toBe(
      'data:image/png;base64,AAAA 1x, /api/v2/fs/raw?path=a.png 2x',
    )
  })

  it('уже резолвленные адреса приложения (`/api/…`) не переписываются повторно', () => {
    const body = parse(
      '<img src="/api/v2/fs/raw?path=docs/a.png"><a href="/api/v2/fs/raw?path=docs/a.md">x</a>',
    )

    expect(body.querySelector('img')!.getAttribute('src')).toBe(
      '/api/v2/fs/raw?path=docs/a.png',
    )
    const link = body.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/api/v2/fs/raw?path=docs/a.md')
    expect(link.hasAttribute('data-file-path')).toBe(false)
  })

  it('якоря, схемы и protocol-relative не трогаются', () => {
    const body = parse(
      '<a href="#anchor">якорь</a><a href="mailto:user@example.com">почта</a><img src="data:image/png;base64,AAAA"><img src="//cdn.example.com/a.png">',
    )

    expect(body.querySelector('a[href="#anchor"]')).not.toBeNull()
    expect(body.querySelector('a[href="mailto:user@example.com"]')).not.toBeNull()
    expect(body.querySelector('img[src^="data:"]')).not.toBeNull()
    expect(body.querySelector('img[src^="//"]')).not.toBeNull()
    expect(body.querySelectorAll('a[data-file-path]').length).toBe(0)
  })

  it('резолвер вернул null — значения остаются как есть', () => {
    const html = rewriteRelativeAssets('<img src="../escape.png"><a href="../escape.md">x</a>', () => null)

    const body = new DOMParser().parseFromString(html, 'text/html').body
    expect(body.querySelector('img')!.getAttribute('src')).toBe('../escape.png')
    expect(body.querySelector('a')!.getAttribute('href')).toBe('../escape.md')
    expect(body.querySelector('a')!.hasAttribute('data-file-path')).toBe(false)
  })

  it('пустой HTML — без изменений', () => {
    expect(rewriteRelativeAssets('', resolve)).toBe('')
  })
})
