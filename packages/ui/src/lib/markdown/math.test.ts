import { describe, it, expect, afterEach } from 'vitest'
import { Marked } from 'marked'
import { createMathExtension, renderMathInPlace } from './math'

/**
 * Локальный инстанс marked — как в `MarkdownContent.tsx`: расширение формул
 * подключается на инстансе, глобальный `marked` не мутируется.
 */
const markedWithMath = new Marked(createMathExtension())

const containers: HTMLElement[] = []

/** Разметить markdown и положить готовый HTML в контейнер (как в компоненте). */
function render(markdown: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = markedWithMath.parse(markdown) as string
  document.body.appendChild(container)
  containers.push(container)
  return container
}

afterEach(() => {
  while (containers.length > 0) containers.pop()!.remove()
  document.body.innerHTML = ''
})

describe('markdown/math: расширение marked', () => {
  it('блоковая формула: ровно один .md-math[data-math=block]', () => {
    const container = render('$$E=mc^2$$')

    const math = container.querySelectorAll('.md-math[data-math="block"]')
    expect(math.length).toBe(1)
    expect(math[0]!.getAttribute('data-rendered')).toBeNull()
    // Исходник TeX — текстом внутри элемента (не в атрибутах).
    expect(math[0]!.textContent).toBe('$$E=mc^2$$')
    expect(Array.from(math[0]!.attributes).map((a) => a.name)).toEqual(['class', 'data-math'])
  })

  it('инлайновая формула: .md-math[data-math=inline] внутри абзаца', () => {
    const container = render('текст $$a+b$$ текст')

    const math = container.querySelectorAll('.md-math[data-math="inline"]')
    expect(math.length).toBe(1)
    expect(container.querySelectorAll('.md-math[data-math="block"]').length).toBe(0)
    expect(math[0]!.textContent).toBe('$$a+b$$')
    // Текст вокруг формулы не потерян.
    expect(container.textContent).toContain('текст')
  })

  it('многострочная блочная формула: переносы внутри', () => {
    const container = render('$$\n\\frac{a}{b}\n$$')

    const math = container.querySelector('.md-math[data-math="block"]')
    expect(math?.textContent).toBe('$$\\frac{a}{b}$$')
  })

  it('одинарный $ и непарные $$ — не формула', () => {
    const container = render('Цена $5 и $$ без пары')

    expect(container.querySelectorAll('.md-math').length).toBe(0)
    // Текст остался как был.
    expect(container.textContent).toContain('$5')
    expect(container.textContent).toContain('$$')
  })

  it('две формулы в одной строке — две инлайновые, а не одна битая блоковая', () => {
    const container = render('$$a$$ и $$b$$')

    expect(container.querySelectorAll('.md-math[data-math="inline"]').length).toBe(2)
    expect(container.querySelectorAll('.md-math[data-math="block"]').length).toBe(0)
  })

  it('код (fence и инлайн) — формулой не считается, исходник не изменён', () => {
    const container = render('```\n$$x$$\n```\n\nА вот `$$y$$` код')

    expect(container.querySelectorAll('.md-math').length).toBe(0)
    expect(container.querySelector('pre code')?.textContent).toContain('$$x$$')
    expect(container.querySelector('p code')?.textContent).toBe('$$y$$')
  })
})

describe('markdown/math: рендер KaTeX', () => {
  it('блоковая формула после рендера: data-rendered и .katex внутри', async () => {
    const container = render('$$E=mc^2$$')
    const math = container.querySelector('.md-math[data-math="block"]')!

    await renderMathInPlace(container)

    expect(math.getAttribute('data-rendered')).toBe('1')
    expect(math.querySelector('.katex')).not.toBeNull()
  })

  it('инлайновая формула после рендера: .katex внутри', async () => {
    const container = render('текст $$a+b$$ текст')
    const math = container.querySelector('.md-math[data-math="inline"]')!

    await renderMathInPlace(container)

    expect(math.getAttribute('data-rendered')).toBe('1')
    expect(math.querySelector('.katex')).not.toBeNull()
  })

  it('повторный проход не перерисовывает уже отрисованную формулу', async () => {
    const container = render('$$E=mc^2$$')
    const math = container.querySelector('.md-math[data-math="block"]')!

    await renderMathInPlace(container)
    const rendered = math.innerHTML
    await renderMathInPlace(container)

    expect(math.innerHTML).toBe(rendered)
    expect(math.getAttribute('data-rendered')).toBe('1')
  })

  it('кривой TeX: элемент остаётся исходным текстом, исключения нет', async () => {
    const container = render('$$\\frac{$$')
    const math = container.querySelector('.md-math[data-math="block"]')!

    await expect(renderMathInPlace(container)).resolves.toBeUndefined()

    expect(math.getAttribute('data-rendered')).toBeNull()
    expect(math.textContent).toBe('$$\\frac{$$')
    expect(math.querySelector('.katex')).toBeNull()
  })

  it('пустой контейнер — тихий no-op', async () => {
    const container = document.createElement('div')

    await expect(renderMathInPlace(container)).resolves.toBeUndefined()
  })
})
