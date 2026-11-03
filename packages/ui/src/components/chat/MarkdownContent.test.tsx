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
  resolveAsset?: (target: string) => string | null,
): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <MarkdownContent content={content} streaming={streaming} resolveAsset={resolveAsset} />,
    )
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

describe('MarkdownContent: относительные картинки и ссылки (resolveAsset)', () => {
  /** Резолвер вкладки файла: путь → URL предпросмотра в workspace. */
  const resolve = (target: string) => `/api/v2/fs/raw?path=${target}`
  const renderWithResolve = (content: string) => renderTree(content, false, resolve)

  it('картинка с относительным src получает рабочий URL', async () => {
    const { container } = await renderWithResolve('![a](img.png)')

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')!.startsWith('/api/v2/fs/raw?')).toBe(true)
    expect(img!.getAttribute('src')).toContain('path=img.png')
    expect(img!.getAttribute('alt')).toBe('a')
  })

  it('внешняя картинка не резолвится', async () => {
    const { container } = await renderWithResolve('![a](https://example.com/a.png)')

    const img = container.querySelector('img')
    expect(img!.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('относительная ссылка → href="#" + data-file-path', async () => {
    const { container } = await renderWithResolve('[файл](docs/a.md)')

    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('#')
    expect(link!.getAttribute('data-file-path')).toBe('docs/a.md')
    expect(link!.getAttribute('target')).toBeNull()
  })

  it('внешняя ссылка и якорь не тронуты', async () => {
    const { container } = await renderWithResolve(
      '[внешняя](https://example.com/a) [раздел](#anchor)',
    )

    const links = Array.from(container.querySelectorAll('a'))
    expect(links.length).toBe(2)
    expect(links[0].getAttribute('data-file-path')).toBeNull()
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[1].getAttribute('href')).toBe('#anchor')
    expect(links[1].getAttribute('data-file-path')).toBeNull()
  })

  it('резолвер вернул null — прежнее поведение (обычная относительная ссылка)', async () => {
    const { container } = await renderTree('[файл](missing.md)', false, () => null)

    const link = container.querySelector('a')
    expect(link!.getAttribute('href')).toBe('missing.md')
    expect(link!.getAttribute('data-file-path')).toBeNull()
    expect(link!.getAttribute('target')).toBeNull()
  })

  it('без resolveAsset — прежнее поведение (src/href как в markdown)', async () => {
    const container = await renderMarkdown('![a](img.png) [файл](docs/a.md)')

    const img = container.querySelector('img')
    expect(img!.getAttribute('src')).toBe('img.png')
    const link = container.querySelector('a')
    expect(link!.getAttribute('href')).toBe('docs/a.md')
    expect(link!.getAttribute('data-file-path')).toBeNull()
  })

  it('title ссылки и картинки сохраняется', async () => {
    const { container } = await renderWithResolve(
      '![a](img.png "подсказка") [файл](docs/a.md "файл")',
    )

    expect(container.querySelector('img')!.getAttribute('title')).toBe('подсказка')
    expect(container.querySelector('a')!.getAttribute('title')).toBe('файл')
  })
})

describe('MarkdownContent: заголовки и якорные ссылки', () => {
  /** `scrollIntoView` в jsdom отсутствует — ставим шпион на прототип. */
  let scrollSpy: ReturnType<typeof vi.fn>
  let originalScroll: PropertyDescriptor | undefined

  beforeEach(() => {
    originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    scrollSpy = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollSpy,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    if (originalScroll) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll)
    } else {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  async function clickLink(container: HTMLElement): Promise<MouseEvent> {
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => {
      link!.dispatchEvent(event)
    })
    return event
  }

  it('заголовок получает id по GitHub-slug', async () => {
    const container = await renderMarkdown('# Заголовок')

    const heading = container.querySelector('h1')
    expect(heading).not.toBeNull()
    expect(heading?.getAttribute('id')).toBe('заголовок')
    expect(heading?.textContent).toBe('Заголовок')
  })

  it('кириллица, регистр и пунктуация в slug', async () => {
    const container = await renderMarkdown('## Что нового? 🎉\n\n### API v2')

    const ids = Array.from(container.querySelectorAll('h2, h3')).map((el) => el.getAttribute('id'))
    expect(ids).toEqual(['что-нового', 'api-v2'])
  })

  it('два одинаковых заголовка получают уникальные id (счётчик на документ)', async () => {
    const container = await renderMarkdown('# Повтор\n\n## Повтор\n\n### Повтор')

    const ids = Array.from(container.querySelectorAll('h1, h2, h3')).map((el) => el.getAttribute('id'))
    expect(ids).toEqual(['повтор', 'повтор-1', 'повтор-2'])
  })

  it('заголовок с разметкой: slug без `*`, инлайн-HTML сохранён', async () => {
    const container = await renderMarkdown('## **Жирный** пункт')

    const heading = container.querySelector('h2')
    expect(heading?.getAttribute('id')).toBe('жирный-пункт')
    expect(heading?.querySelector('strong')?.textContent).toBe('Жирный')
  })

  it('счётчик дубликатов сбрасывается на каждый документ', async () => {
    // Два независимых экземпляра markdown: модульный singleton рендерера
    // оставил бы во втором «один-1» — контракт требует сброса на документ.
    const first = await renderMarkdown('# Один')
    const second = await renderMarkdown('# Один')

    expect(first.querySelector('h1')?.getAttribute('id')).toBe('один')
    expect(second.querySelector('h1')?.getAttribute('id')).toBe('один')
  })

  it('клик по якорю скроллит к заголовку и не меняет hash в URL', async () => {
    const container = await renderMarkdown('[К заголовку](#заголовок)\n\n# Заголовок')
    const before = window.location.hash

    const event = await clickLink(container)

    expect(event.defaultPrevented).toBe(true)
    expect(window.location.hash).toBe(before)
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    const target = scrollSpy.mock.contexts[0] as Element
    expect(target.getAttribute('id')).toBe('заголовок')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('клик по URL-кодированному якорю работает', async () => {
    const container = await renderMarkdown(
      '[К разделу](#%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB)\n\n# Раздел',
    )

    const event = await clickLink(container)

    expect(event.defaultPrevented).toBe(true)
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect((scrollSpy.mock.contexts[0] as Element).getAttribute('id')).toBe('раздел')
  })

  it('несуществующий якорь — тихий no-op без исключения', async () => {
    const container = await renderMarkdown('[Нет цели](#нет-такой)\n\n# Есть')
    const before = window.location.hash

    const event = await clickLink(container)

    expect(event.defaultPrevented).toBe(true)
    expect(window.location.hash).toBe(before)
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('битый процент в якоре не бросает', async () => {
    const container = await renderMarkdown('[Битый](#%)\n\n# Есть')

    await expect(clickLink(container)).resolves.toBeDefined()
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('цель ищется внутри своего контейнера, а не в документе', async () => {
    // Чужой элемент с тем же id — в документе, но не в этом markdown.
    const foreign = document.createElement('div')
    foreign.id = 'заголовок'
    document.body.appendChild(foreign)

    const container = await renderMarkdown('[К заголовку](#заголовок)\n\n# Заголовок')

    await clickLink(container)

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect((scrollSpy.mock.contexts[0] as Element).closest('.markdown-content')).not.toBeNull()
    expect(scrollSpy.mock.contexts[0]).not.toBe(foreign)
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

describe('MarkdownContent: правый зазор блока кода (CSS)', () => {
  // jsdom не считает геометрию, поэтому проверяем само правило: `pre` —
  // скролл-контейнер, и его внутренний `padding-right` прокручивается
  // вместе с кодом. Зазор до правой рамки карточки должен быть снаружи
  // прокручиваемой области (`margin-inline-end` у `pre`, в LTR — справа),
  // иначе при `scrollLeft = 0` обрезанный текст прилипает к границе.
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
    'utf8',
  )
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')

  /** Тела правил с ровно таким селектором (без `:hover`, потомков и т.п.). */
  function exactRuleBodies(selector: string): string[] {
    const bodies: string[] = []
    for (const chunk of cssRules.split('}')) {
      const open = chunk.lastIndexOf('{')
      if (open < 0) continue
      const selectors = chunk.slice(0, open).split(',').map((s) => s.trim())
      if (selectors.includes(selector)) bodies.push(chunk.slice(open + 1))
    }
    return bodies
  }

  /** Правый (LTR) внешний отступ по каскаду объявлений правила. */
  function rightMargin(body: string): string | null {
    let right: string | null = null
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      const prop = declaration.slice(0, colon).trim()
      const value = declaration.slice(colon + 1).trim()
      // Логическое свойство `margin-inline-end` — тоже «правый» отступ в LTR
      // (RTL-безопасная замена `margin-right`).
      if (prop === 'margin-inline-end' || prop === 'margin-right') {
        right = value
        continue
      }
      if (prop === 'margin-inline') {
        const parts = value.split(/\s+/)
        right = parts[1] ?? parts[0]!
        continue
      }
      if (prop !== 'margin') continue
      const parts = value.split(/\s+/)
      if (parts.length === 1) right = parts[0]!
      else if (parts.length >= 2) right = parts[1]!
    }
    return right
  }

  /** CSS-длина в px (rem/em считаем от 16px — этого хватает для диапазона 6–10px). */
  function toPx(value: string): number | null {
    const match = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(value.trim())
    if (!match) return null
    const amount = Number(match[1])
    return match[2] === 'px' ? amount : amount * 16
  }

  it('у `.md-code-pre` есть правый margin 6–10px (зазор вне прокрутки)', () => {    const bodies = exactRuleBodies('.markdown-content .md-code-pre')
    expect(bodies.length).toBeGreaterThan(0)

    const right = rightMargin(bodies.join('\n'))
    expect(right, 'у .md-code-pre не задан правый отступ').not.toBeNull()
    const px = toPx(right!)
    expect(px, `правый отступ "${right}" не в px/rem/em`).not.toBeNull()
    expect(px!).toBeGreaterThanOrEqual(6)
    expect(px!).toBeLessThanOrEqual(10)
  })

  it('ни одно другое правило не сбрасывает зазор у `.md-code-pre`', () => {
    // Зазор должен действовать и без подсветки, и после shiki: общий `pre`
    // один, а правила подсветки трогают только строки (`.line`).
    for (const body of exactRuleBodies('.markdown-content .md-code-pre')) {
      const right = rightMargin(body)
      if (right === null) continue
      const px = toPx(right)
      expect(px, `правый отступ "${right}" должен оставаться ненулевым`).not.toBe(0)
    }
  })
})

describe('MarkdownContent: фон блока кода и таблицы (CSS)', () => {
  // Требование продукта: фон у блоков кода и таблиц одинаковый в любом виде
  // чата (`detailed`/`feed`) и равен фону блока кода. jsdom не считает каскад,
  // поэтому проверяем сами объявления в `styles/index.css`: оба правила
  // задают один токен, а оверрайда для «ленты» с `--card` больше нет.
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../styles/index.css'),
    'utf8',
  )
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')

  interface CssRule {
    selectors: string[]
    body: string
  }

  function allRules(): CssRule[] {
    const list: CssRule[] = []
    for (const chunk of cssRules.split('}')) {
      const open = chunk.lastIndexOf('{')
      if (open < 0) continue
      const selectors = chunk
        .slice(0, open)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      list.push({ selectors, body: chunk.slice(open + 1) })
    }
    return list
  }

  /** Последнее (по каскаду) значение `background` у правила с ровно таким селектором. */
  function backgroundOf(selector: string): string | null {
    let value: string | null = null
    for (const rule of allRules()) {
      if (!rule.selectors.includes(selector)) continue
      for (const declaration of rule.body.split(';')) {
        const colon = declaration.indexOf(':')
        if (colon < 0) continue
        const prop = declaration.slice(0, colon).trim()
        if (prop !== 'background' && prop !== 'background-color') continue
        value = declaration.slice(colon + 1).trim()
      }
    }
    return value
  }

  it('`.md-code` и `.md-table-wrap` задают одинаковый фон `var(--surface-subtle, var(--card))`', () => {
    const expected = 'var(--surface-subtle, var(--card))'
    expect(backgroundOf('.markdown-content .md-code')).toBe(expected)
    expect(backgroundOf('.markdown-content .md-table-wrap')).toBe(expected)
  })

  it('правил вида «лента» с фоном `var(--card)` больше нет', () => {
    const offenders: string[] = []
    for (const rule of allRules()) {
      const feed = rule.selectors.some((s) => /data-view-mode\s*=\s*['"]?feed['"]?/.test(s))
      if (!feed) continue
      for (const declaration of rule.body.split(';')) {
        const colon = declaration.indexOf(':')
        if (colon < 0) continue
        const prop = declaration.slice(0, colon).trim()
        if (prop !== 'background' && prop !== 'background-color') continue
        if (declaration.slice(colon + 1).includes('var(--card')) {
          offenders.push(`${rule.selectors.join(', ')} { ${declaration.trim()} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
