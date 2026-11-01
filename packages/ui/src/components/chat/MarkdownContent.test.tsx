import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { i18nText } from '@/lib/i18n'
import { highlightCode, resetThemeWatcher } from '@/lib/markdown/highlight'
import { MarkdownContent, MAX_NUMBERED_CODE_LINES } from './MarkdownContent'

// Подсветка (shiki) — отдельный модуль со своим тестом; здесь проверяем только
// интеграцию: когда вызывается и как применяется/игнорируется результат.
// Остальные экспорты модуля (детектор смены темы) остаются настоящими —
// перекраска проверяется на реальном наблюдателе DOM.
vi.mock('@/lib/markdown/highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markdown/highlight')>()
  return { ...actual, highlightCode: vi.fn(async () => null) }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderTree(
  content: string,
  streaming = false,
): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<MarkdownContent content={content} streaming={streaming} />)
  })
  return { root, container }
}

async function renderMarkdown(content: string): Promise<HTMLElement> {
  const { container } = await renderTree(content)
  return container
}

/** Дождаться асинхронного эффекта подсветки (промис + запись в DOM). */
async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Аксессор `innerHTML` (в jsdom лежит на `Element.prototype`). */
function innerHtmlDescriptor(): PropertyDescriptor {
  let proto: object | null = Object.getPrototypeOf(document.createElement('div'))
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML')
    if (descriptor?.set && descriptor.get) return descriptor
    proto = Object.getPrototypeOf(proto)
  }
  throw new Error('innerHTML accessor not found')
}

/** Дождаться доставки MutationObserver (микротаска jsdom) и её обработчиков. */
async function flushDom(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  const highlight = vi.mocked(highlightCode)
  highlight.mockReset()
  // По умолчанию подсветки нет: тесты блоков кода не зависят от shiki.
  highlight.mockResolvedValue(null)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
  resetThemeWatcher()
  document.documentElement.className = ''
  vi.restoreAllMocks()
})

describe('MarkdownContent: блоки кода', () => {
  it('код с языком: .md-code, data-lang, заголовок с языком, кнопка копирования', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')

    const block = container.querySelector('.md-code')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-lang')).toBe('ts')
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('ts')
    expect(container.querySelector('[data-copy-code]')).not.toBeNull()
    expect(container.querySelector('code.language-ts')).not.toBeNull()
    expect(container.querySelectorAll('.md-code-line').length).toBe(1)
    expect(container.querySelector('.md-code-line')?.textContent).toBe('const a = 1')
  })

  it('код без языка → data-lang="text"', async () => {
    const container = await renderMarkdown('```\nplain text\n```')

    const block = container.querySelector('.md-code')
    expect(block?.getAttribute('data-lang')).toBe('text')
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('text')
    expect(container.querySelector('code.language-text')).not.toBeNull()
  })

  it('HTML внутри кода экранирован и не исполняется', async () => {
    const container = await renderMarkdown('```html\n<script>alert(1)</script>\n<b>bold</b>\n```')

    expect(container.querySelector('script')).toBeNull()
    const lines = Array.from(container.querySelectorAll('.md-code-line')).map((el) => el.textContent)
    expect(lines).toEqual(['<script>alert(1)</script>', '<b>bold</b>'])
    expect(container.innerHTML).toContain('&lt;script&gt;')
  })

  it('длинный блок (> MAX_NUMBERED_CODE_LINES) — без номеров строк', async () => {
    const longCode = Array.from({ length: MAX_NUMBERED_CODE_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    const container = await renderMarkdown('```text\n' + longCode + '\n```')

    const block = container.querySelector('.md-code')
    expect(block?.getAttribute('data-numbered')).toBe('false')
    expect(container.querySelectorAll('.md-code-line').length).toBe(MAX_NUMBERED_CODE_LINES + 1)
  })
})

describe('MarkdownContent: таблицы и инлайн-код', () => {
  it('таблица обёрнута в .md-table-wrap (горизонтальный скролл)', async () => {
    const container = await renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')

    const wrap = container.querySelector('.md-table-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap?.querySelector('table')).not.toBeNull()
    expect(wrap?.querySelectorAll('th').length).toBe(2)
    expect(wrap?.querySelectorAll('tbody td').length).toBe(2)
  })

  it('выравнивание колонок GFM сохраняется', async () => {
    const container = await renderMarkdown('| a | b |\n| :-- | --: |\n| 1 | 2 |')

    const heads = Array.from(container.querySelectorAll('.md-table-wrap th'))
    expect(heads.map((el) => el.getAttribute('align'))).toEqual(['left', 'right'])
  })

  it('инлайн-код → .md-inline-code', async () => {
    const container = await renderMarkdown('Запусти `npm test` в корне')

    const code = container.querySelector('code.md-inline-code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe('npm test')
  })
})

describe('MarkdownContent: ссылки', () => {
  it('внешняя ссылка получает target=_blank и rel', async () => {
    const container = await renderMarkdown('[docs](https://example.com/page)')

    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/page')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('якорь и относительная ссылка — без target', async () => {
    const container = await renderMarkdown('[раздел](#anchor) и [файл](./docs/readme.md)')

    const links = Array.from(container.querySelectorAll('a'))
    expect(links.length).toBe(2)
    for (const link of links) {
      expect(link.getAttribute('target')).toBeNull()
      expect(link.getAttribute('rel')).toBeNull()
    }
  })
})

describe('MarkdownContent: копирование', () => {
  it('кнопка — иконка: подпись в aria-label/title, текстового содержимого нет', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')
    expect(button).not.toBeNull()
    expect(button?.classList.contains('md-code-copy')).toBe(true)
    expect(button?.getAttribute('aria-label')).toBe(i18nText('markdown.code.copy'))
    expect(button?.getAttribute('title')).toBe(i18nText('markdown.code.copy'))
    // Текста в кнопке нет: иконку рисует CSS-маска на ::before.
    expect(button?.textContent).toBe('')
  })

  it('клик по кнопке кладёт текст блока в буфер и включает состояние «готово»', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\nconsole.log(a)\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')
    expect(button).not.toBeNull()

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toBe('const a = 1\nconsole.log(a)')
    expect(button?.getAttribute('data-copied')).toBe('true')
    expect(button?.getAttribute('aria-label')).toBe(i18nText('markdown.code.copied'))
    expect(button?.getAttribute('title')).toBe(i18nText('markdown.code.copied'))
    // Состояние меняется атрибутами — текст кнопки не появляется.
    expect(button?.textContent).toBe('')
  })

  it('состояние «готово» снимается по таймеру (атрибут и подпись возвращаются)', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')
    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')!
    vi.useFakeTimers()
    try {
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(button.getAttribute('data-copied')).toBe('true')
      expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.copied'))

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(button.getAttribute('data-copied')).toBeNull()
      expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.copy'))
      expect(button.getAttribute('title')).toBe(i18nText('markdown.code.copy'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('ошибка буфера обмена не ломает рендер', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    const container = await renderMarkdown('```js\nlet x = 1\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('.md-code')).not.toBeNull()
    expect(button?.getAttribute('data-copied')).toBeNull()
    expect(button?.getAttribute('aria-label')).toBe(i18nText('markdown.code.copy'))
  })
})

describe('MarkdownContent: санитайзер', () => {
  it('details/summary не вырезаются', async () => {
    const container = await renderMarkdown('<details><summary>Подробности</summary>\n\nТекст\n\n</details>')

    expect(container.querySelector('details')).not.toBeNull()
    expect(container.querySelector('summary')?.textContent).toBe('Подробности')
    expect(container.querySelector('details')?.textContent).toContain('Текст')
  })
})

describe('MarkdownContent: подсветка кода (shiki)', () => {
  it('во время стриминга не подсвечивает, после завершения — применяет HTML', async () => {
    vi.mocked(highlightCode).mockResolvedValue('<span class="line">HIGHLIGHTED</span>')
    const content = '```ts\nconst a = 1\n```'
    const { root, container } = await renderTree(content, true)

    await flushEffects()
    expect(highlightCode).not.toHaveBeenCalled()
    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(false)

    await act(async () => {
      root.render(<MarkdownContent content={content} streaming={false} />)
    })
    await flushEffects()

    expect(highlightCode).toHaveBeenCalledTimes(1)
    expect(highlightCode).toHaveBeenCalledWith('const a = 1', 'ts')
    const pre = container.querySelector('pre.md-code-pre')
    expect(pre?.classList.contains('shiki')).toBe(true)
    expect(pre?.querySelector('code')?.innerHTML).toContain('HIGHLIGHTED')
    expect(container.querySelector('.md-code')?.getAttribute('data-highlighted')).toBe('1')
  })

  it('null от подсветки блок не ломает (остаётся экранированный текст)', async () => {
    const container = await renderMarkdown('```mermaid\ngraph TD\n```')
    await flushEffects()

    expect(highlightCode).toHaveBeenCalled()
    const pre = container.querySelector('pre.md-code-pre')
    expect(pre?.classList.contains('shiki')).toBe(false)
    expect(container.querySelector('.md-code')?.getAttribute('data-highlighted')).toBeNull()
    expect(container.querySelector('.md-code-line')?.textContent).toBe('graph TD')
  })

  it('блок без языка (text) на подсветку не отправляется', async () => {
    const container = await renderMarkdown('```\nplain\n```')
    await flushEffects()

    expect(highlightCode).not.toHaveBeenCalled()
    expect(container.querySelector('.md-code')?.getAttribute('data-numbered')).toBe('true')
  })

  it('двойное монтирование эффекта (StrictMode) — подсветка всё равно применяется один раз', async () => {
    // Отложенный промис: момент применения результата контролируем тестом.
    let resolveHighlight: ((html: string) => void) | null = null
    vi.mocked(highlightCode).mockImplementation(
      () => new Promise<string | null>((resolve) => { resolveHighlight = resolve }),
    )

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })

    await act(async () => {
      root.render(
        <StrictMode>
          <MarkdownContent content={'```ts\nconst a = 1\n```'} />
        </StrictMode>,
      )
    })

    // Считаем применения подсветки: innerHTML блока ставится ровно один раз.
    const code = container.querySelector('code')!
    const descriptor = innerHtmlDescriptor()
    let applied = 0
    Object.defineProperty(code, 'innerHTML', {
      configurable: true,
      get() { return descriptor.get!.call(this) },
      set(value: string) { applied += 1; descriptor.set!.call(this, value) },
    })

    await act(async () => {
      resolveHighlight!('<span class="line">HIGHLIGHTED</span>')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(applied).toBe(1)
    expect(highlightCode).toHaveBeenCalledTimes(1)
    const pre = container.querySelector('pre.md-code-pre')
    expect(pre?.classList.contains('shiki')).toBe(true)
    expect(code.innerHTML).toContain('HIGHLIGHTED')
    const block = container.querySelector('.md-code')
    expect(block?.getAttribute('data-highlighted')).toBe('1')
    expect(block?.getAttribute('data-highlighting')).toBeNull()
  })

  it('повторный рендер с тем же html не перезапускает токенизацию', async () => {
    vi.mocked(highlightCode).mockResolvedValue('<span class="line">HIGHLIGHTED</span>')
    const content = '```ts\nconst a = 1\n```'
    const { root, container } = await renderTree(content)
    await flushEffects()

    expect(highlightCode).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<MarkdownContent content={content} />)
    })
    await flushEffects()

    expect(highlightCode).toHaveBeenCalledTimes(1)
    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(true)
    expect(container.querySelector('.md-code')?.getAttribute('data-highlighted')).toBe('1')
  })

  it('смена темы перекрашивает уже подсвеченный блок (повторный вызов highlightCode)', async () => {
    let call = 0
    // Как настоящий shiki: текст кода сохраняется (комментарий — метка
    // поколения подсветки, в `textContent` он не попадает).
    vi.mocked(highlightCode).mockImplementation(async (code) => {
      call += 1
      return `<span class="line">${code}</span><!--gen-${call}-->`
    })

    const container = await renderMarkdown('```ts\nconst a = 1\n```')
    await flushEffects()

    expect(highlightCode).toHaveBeenCalledTimes(1)
    expect(container.querySelector('code')?.innerHTML).toContain('gen-1')
    expect(container.querySelector('code')?.textContent).toBe('const a = 1')
    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(true)

    // Смена темы: класс на <html> → epoch растёт → блок перерисовывается.
    await act(async () => {
      document.documentElement.classList.add('dark')
    })
    await flushDom()
    await flushEffects()

    expect(highlightCode).toHaveBeenCalledTimes(2)
    expect(highlightCode).toHaveBeenLastCalledWith('const a = 1', 'ts')
    expect(container.querySelector('code')?.innerHTML).toContain('gen-2')
    expect(container.querySelector('code')?.textContent).toBe('const a = 1')
    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(true)
    expect(container.querySelector('.md-code')?.getAttribute('data-highlighted')).toBe('1')
    expect(container.querySelector('.md-code')?.getAttribute('data-highlighting')).toBeNull()
  })

  it('смена темы во время стриминга не подсвечивает блок', async () => {
    vi.mocked(highlightCode).mockResolvedValue('<span class="line">HIGHLIGHTED</span>')
    const { container } = await renderTree('```ts\nconst a = 1\n```', true)
    await flushEffects()

    await act(async () => {
      document.documentElement.classList.add('dark')
    })
    await flushDom()
    await flushEffects()

    expect(highlightCode).not.toHaveBeenCalled()
    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(false)
  })
})

describe('MarkdownContent: скачивание кода', () => {
  /** Blob'ы, ушедшие в `URL.createObjectURL`. */
  let blobs: Blob[] = []
  /** Ссылки, по которым реально «кликнули» (перехват `a.click()`). */
  let clickedLinks: HTMLAnchorElement[] = []

  beforeEach(() => {
    blobs = []
    clickedLinks = []
    // jsdom не реализует object URL — подменяем, чтобы прочитать содержимое файла.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return `blob:mock-${blobs.length}`
      }),
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
      writable: true,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedLinks.push(this)
    })
  })

  async function clickDownload(container: HTMLElement): Promise<HTMLButtonElement> {
    const button = container.querySelector<HTMLButtonElement>('[data-download-code]')
    expect(button).not.toBeNull()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    return button!
  }

  it('кнопка скачивания есть в шапке и не срезана санитайзером', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-download-code]')
    expect(button).not.toBeNull()
    expect(button?.classList.contains('md-code-download')).toBe(true)
    // Подпись — только в атрибутах: текста в кнопке нет (иконка — CSS-маска).
    expect(button?.getAttribute('aria-label')).toBe(i18nText('markdown.code.download'))
    expect(button?.getAttribute('title')).toBe(i18nText('markdown.code.download'))
    expect(button?.textContent).toBe('')
    // Обе кнопки — в общей группе действий справа от языка.
    const actions = container.querySelector('.md-code-actions')
    expect(actions?.querySelector('[data-copy-code]')).not.toBeNull()
    expect(actions?.contains(button!)).toBe(true)
  })

  it('клик скачивает исходный код файлом с расширением языка', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\nconsole.log(a)\n```')

    await clickDownload(container)

    expect(blobs).toHaveLength(1)
    expect(blobs[0]!.type).toBe('text/plain;charset=utf-8')
    expect(await blobs[0]!.text()).toBe('const a = 1\nconsole.log(a)')
    expect(clickedLinks).toHaveLength(1)
    expect(clickedLinks[0]!.download).toBe('code.ts')
    expect(clickedLinks[0]!.href).toBe('blob:mock-1')
    // Отзыв URL — в следующей макротаске (браузер должен успеть начать загрузку).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('хвостовые пустые строки в файл не попадают', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n\n\n```')

    await clickDownload(container)

    expect(await blobs[0]!.text()).toBe('const a = 1')
  })

  it('неизвестный язык → code.txt', async () => {
    const container = await renderMarkdown('```mermaid\ngraph TD\n```')

    await clickDownload(container)

    expect(clickedLinks[0]!.download).toBe('code.txt')
    expect(await blobs[0]!.text()).toBe('graph TD')
  })

  it('пустой блок кода ничего не скачивает', async () => {
    const container = await renderMarkdown('```ts\n```')

    const button = await clickDownload(container)

    expect(blobs).toHaveLength(0)
    expect(clickedLinks).toHaveLength(0)
    expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.download'))
    expect(button.getAttribute('data-downloaded')).toBeNull()
  })

  it('состояние «Скачано» ставится атрибутом и снимается по таймеру', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')
    const button = container.querySelector<HTMLButtonElement>('[data-download-code]')!
    // Таймеры — фейковые только на время проверки обратной связи.
    vi.useFakeTimers()
    try {
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(button.getAttribute('data-downloaded')).toBe('true')
      expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.downloaded'))
      expect(button.getAttribute('title')).toBe(i18nText('markdown.code.downloaded'))
      expect(button.textContent).toBe('')

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(button.getAttribute('data-downloaded')).toBeNull()
      expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.download'))
      expect(button.getAttribute('title')).toBe(i18nText('markdown.code.download'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('блок после подсветки отдаёт тот же исходный текст (без номеров строк)', async () => {
    // Как настоящий shiki: строки — span'ы, текст (и `\n` между ними) сохраняется,
    // номера строк рисует CSS-счётчик, в `textContent` их нет.
    vi.mocked(highlightCode).mockImplementation(async (code) => `<span class="line">${code}</span>`)
    const container = await renderMarkdown('```ts\nconst a = 1\nconsole.log(a)\n```')
    await flushEffects()

    expect(container.querySelector('pre.md-code-pre')?.classList.contains('shiki')).toBe(true)
    const code = container.querySelector('pre code')!
    expect(code.textContent).toBe('const a = 1\nconsole.log(a)')

    await clickDownload(container)

    expect(await blobs[0]!.text()).toBe('const a = 1\nconsole.log(a)')
    expect(clickedLinks[0]!.download).toBe('code.ts')
  })

  it('ошибка URL.createObjectURL не ломает рендер и обработчик', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => {
        throw new Error('not supported')
      }),
      configurable: true,
      writable: true,
    })
    const container = await renderMarkdown('```ts\nconst a = 1\n```')
    const button = container.querySelector<HTMLButtonElement>('[data-download-code]')!

    await clickDownload(container)

    expect(container.querySelector('.md-code')).not.toBeNull()
    expect(clickedLinks).toHaveLength(0)
    expect(button.getAttribute('aria-label')).toBe(i18nText('markdown.code.download'))
    expect(button.getAttribute('data-downloaded')).toBeNull()
  })
})

describe('MarkdownContent: иконки кнопок шапки (CSS-маска)', () => {
  // jsdom не вычисляет стили псевдоэлементов, поэтому саму иконку проверяем
  // по CSS-правилам: у обоих состояний (действие и «готово») есть mask-image.
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
    'utf8',
  )
  /** CSS без комментариев: они могут стоять между правилами и мешать разбору. */
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')

  /** Все тела правил, в списке селекторов которых есть `selector`. */
  function ruleBodies(selector: string): string[] {
    const bodies: string[] = []
    for (const chunk of cssRules.split('}')) {
      const open = chunk.lastIndexOf('{')
      if (open < 0) continue
      const selectors = chunk.slice(0, open).split(',').map((s) => s.trim())
      if (selectors.includes(selector)) bodies.push(chunk.slice(open + 1))
    }
    return bodies
  }

  it('кнопки-иконки: mask-image задан для копирования и скачивания', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\n```')
    const copy = container.querySelector<HTMLButtonElement>('.md-code-copy')
    const download = container.querySelector<HTMLButtonElement>('.md-code-download')
    expect(copy).not.toBeNull()
    expect(download).not.toBeNull()
    expect(copy!.hasAttribute('data-copy-code')).toBe(true)
    expect(download!.hasAttribute('data-download-code')).toBe(true)

    for (const selector of [
      '.markdown-content .md-code-copy::before',
      '.markdown-content .md-code-download::before',
    ]) {
      // Правил может быть несколько (общая база + своя иконка) — берём все.
      const body = ruleBodies(selector).join('\n')
      expect(body, `нет правил для ${selector}`).not.toBe('')
      expect(body).toContain('mask-image: url("data:image/svg+xml,')
      expect(body).toContain('-webkit-mask-image: url("data:image/svg+xml,')
    }
  })

  it('состояния «готово» переключают маску на галочку', () => {
    for (const selector of [
      ".markdown-content .md-code-copy[data-copied='true']::before",
      ".markdown-content .md-code-download[data-downloaded='true']::before",
    ]) {
      const body = ruleBodies(selector).join('\n')
      expect(body).toContain('mask-image: url("data:image/svg+xml,')
    }
  })

  it('на coarse-указателе кнопки увеличиваются до тач-таргета', () => {
    expect(css).toContain('html.pointer-coarse .markdown-content .md-code-copy')
    expect(css).toContain('html.pointer-coarse .markdown-content .md-code-download')
  })
})
