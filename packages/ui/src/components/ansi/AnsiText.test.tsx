// AnsiText: рендер ANSI-вывода спанами (см. `lib/ansi.ts`).
//
// Проверяем три вещи, от которых зависит вид лога: 16 базовых цветов идут
// классами темы, 256/truecolor — инлайновым стилем (HTML не собирается), а
// `colors=false` даёт плоский текст без единого раскрашенного спана.

import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { AnsiText } from './AnsiText'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<pre>{element}</pre>)
  })
  await act(async () => {})
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('AnsiText', () => {
  it('раскрашивает 16 базовых цветов классами темы', async () => {
    const container = await render(
      <AnsiText text={'\u001b[31merr\u001b[0m \u001b[90mgray\u001b[0m'} colors />,
    )

    expect(container.textContent).toBe('err gray')
    expect(container.querySelector('.text-ansi-red')?.textContent).toBe('err')
    expect(container.querySelector('.text-ansi-bright-black')?.textContent).toBe('gray')
    expect(container.textContent).not.toContain('\u001b')
  })

  it('начертания — классами, фон — классом цвета фона', async () => {
    const container = await render(
      <AnsiText text={'\u001b[1;3;4;42mstyled\u001b[0m'} colors />,
    )

    const span = container.querySelector('span')
    expect(span?.className).toContain('font-bold')
    expect(span?.className).toContain('italic')
    expect(span?.className).toContain('underline')
    expect(span?.className).toContain('bg-ansi-green')
  })

  it('256/truecolor — инлайновый стиль, без dangerouslySetInnerHTML', async () => {
    const container = await render(
      <AnsiText text={'\u001b[38;2;18;52;86mtc\u001b[0m \u001b[48;5;196mbg\u001b[0m'} colors />,
    )

    const spans = Array.from(container.querySelectorAll<HTMLElement>('span'))
    const colored = spans.filter((span) => span.style.color !== '')
    const background = spans.filter((span) => span.style.backgroundColor !== '')

    expect(colored[0]?.style.color).toBe('rgb(18, 52, 86)')
    expect(background[0]?.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('colors=false — плоский текст без раскраски', async () => {
    const container = await render(
      <AnsiText text={'\u001b[31merr\u001b[0m \u001b[1mbold\u001b[0m'} colors={false} />,
    )

    expect(container.textContent).toBe('err bold')
    expect(container.querySelectorAll('span')).toHaveLength(0)
    expect(container.textContent).not.toContain('\u001b')
  })

  it('сохраняет переводы строк и табуляцию (родитель — <pre>)', async () => {
    const container = await render(<AnsiText text={'a\tb\n\u001b[32mc\u001b[0m'} colors />)

    expect(container.textContent).toBe('a\tb\nc')
  })

  it('testId и className попадают на обёртку', async () => {
    const container = await render(
      <AnsiText text={'plain'} colors={false} className="wrap" testId="ansi-here" />,
    )

    const wrapper = container.querySelector('[data-testid="ansi-here"]')
    expect(wrapper?.className).toBe('wrap')
    expect(wrapper?.textContent).toBe('plain')
  })

  it('\\r-перезапись: прогресс-бар показывает финальный кадр', async () => {
    const container = await render(<AnsiText text={'\r 10%\r 55%\r100%'} colors />)

    expect(container.textContent).toBe('100%')
  })
})
