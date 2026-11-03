import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

import { ImageViewer } from './ImageViewer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  await act(async () => {})
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!element) throw new Error(`кнопка ${label} не найдена`)
  return element
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function doubleClick(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
}

function scaleOf(img: HTMLImageElement): number {
  const match = /scale\(([\d.]+)\)/.exec(img.style.transform)
  expect(match).not.toBeNull()
  return Number(match![1])
}

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    while (roots.length > 0) {
      const { root, container } = roots.pop()!
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('рендерит изображение и слой жестов с touch-action: none', async () => {
    const container = await render(<ImageViewer src="/img/cat.png" alt="cat.png" />)

    const img = container.querySelector('img') as HTMLImageElement | null
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('/img/cat.png')
    expect(img!.getAttribute('alt')).toBe('cat.png')
    expect(img!.getAttribute('draggable')).toBe('false')
    expect(img!.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')

    const layer = container.querySelector<HTMLElement>('[data-testid="image-viewer"]')
    expect(layer).not.toBeNull()
    expect(layer!.getAttribute('role')).toBe('group')
    expect(layer!.getAttribute('aria-label')).toBe('cat.png')
    expect(layer!.style.touchAction).toBe('none')
    expect(layer!.style.overscrollBehavior).toBe('contain')
  })

  it('«+» увеличивает масштаб, «Сброс» возвращает исходное состояние', async () => {
    const container = await render(<ImageViewer src="/img/cat.png" alt="cat.png" />)
    const img = container.querySelector('img') as HTMLImageElement

    await click(button(container, 'file.zoomIn'))
    expect(scaleOf(img)).toBeGreaterThan(1)
    expect(img.style.willChange).toBe('transform')

    await click(button(container, 'file.zoomReset'))
    expect(img.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')
  })

  it('двойной клик переключает масштаб 1 ↔ 2.5', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const container = await render(<ImageViewer src="/img/cat.png" alt="cat.png" />)
    const img = container.querySelector('img') as HTMLImageElement
    const layer = container.querySelector<HTMLElement>('[data-testid="image-viewer"]')!

    await doubleClick(layer)
    expect(scaleOf(img)).toBe(2.5)

    now += 1_000
    await doubleClick(layer)
    expect(scaleOf(img)).toBe(1)
    expect(img.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')
  })

  it('проставляет кастомный data-testid на изображение', async () => {
    const container = await render(
      <ImageViewer src="/img/cat.png" alt="cat.png" dataTestId="attachment-gallery-image" />,
    )
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('data-testid')).toBe('attachment-gallery-image')

    // Без пропа атрибут не появляется (нет мусорного `data-testid="undefined"`).
    const plain = await render(<ImageViewer src="/img/cat.png" alt="cat.png" />)
    expect(plain.querySelector('img')?.hasAttribute('data-testid')).toBe(false)
  })

  it('вызывает onError, когда изображение не загрузилось', async () => {
    const onError = vi.fn()
    const container = await render(<ImageViewer src="/img/broken.png" alt="broken.png" onError={onError} />)

    const img = container.querySelector('img') as HTMLImageElement
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('кнопки оверлея имеют aria-label и title', async () => {
    const container = await render(<ImageViewer src="/img/cat.png" alt="cat.png" />)

    for (const label of ['file.zoomOut', 'file.zoomIn', 'file.zoomReset']) {
      const element = button(container, label)
      expect(element.getAttribute('title')).toBe(label)
      expect(element.className).toContain('size-9')
      expect(element.className).toContain('pointer-coarse:size-10')
    }

    // Процент масштаба меняется вместе с состоянием.
    expect(container.textContent).toContain('100')
    await click(button(container, 'file.zoomIn'))
    expect(container.textContent).toContain('150')
  })
})
