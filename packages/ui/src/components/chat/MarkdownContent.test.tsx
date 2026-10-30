import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
  it('клик по кнопке кладёт текст блока в буфер и меняет подпись', async () => {
    const container = await renderMarkdown('```ts\nconst a = 1\nconsole.log(a)\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe(i18nText('markdown.code.copy'))

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]).toBe('const a = 1\nconsole.log(a)')
    expect(button?.textContent).toBe(i18nText('markdown.code.copied'))
    expect(button?.getAttribute('data-copied')).toBe('true')
  })

  it('ошибка буфера обмена не ломает рендер', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    const container = await renderMarkdown('```js\nlet x = 1\n```')

    const button = container.querySelector<HTMLButtonElement>('[data-copy-code]')
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('.md-code')).not.toBeNull()
    expect(button?.textContent).toBe(i18nText('markdown.code.copy'))
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
