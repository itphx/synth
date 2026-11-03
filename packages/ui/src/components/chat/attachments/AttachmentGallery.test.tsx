import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AttachmentGallery, type AttachmentGalleryImage } from './AttachmentGallery'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IMAGES: AttachmentGalleryImage[] = [
  { url: '/api/v2/sessions/s1/attachments/p1', name: 'a.png' },
  { url: '/api/v2/sessions/s1/attachments/p2', name: 'b.png' },
]

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
  await act(async () => {})
  return { root, container }
}

async function rerender(root: Root, node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
  await act(async () => {})
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function galleryImage(): HTMLImageElement {
  const img = document.querySelector('[data-testid="attachment-gallery-image"]') as HTMLImageElement | null
  if (!img) throw new Error('изображение галереи не найдено')
  return img
}

function scaleOf(img: HTMLImageElement): number {
  const match = /scale\(([\d.]+)\)/.exec(img.style.transform)
  expect(match).not.toBeNull()
  return Number(match![1])
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('AttachmentGallery', () => {
  it('рендерит картинку с data-testid, счётчик и кнопки зума', async () => {
    await mount(
      <AttachmentGallery images={IMAGES} index={0} onIndexChange={() => {}} open onOpenChange={() => {}} />,
    )

    const img = galleryImage()
    expect(img.getAttribute('src')).toBe(IMAGES[0]!.url)
    expect(img.getAttribute('alt')).toBe('a.png')
    expect(img.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')

    const counter = document.querySelector('[data-testid="attachment-gallery-counter"]')
    expect(counter?.textContent).toContain('1 / 2')

    // Кнопки зума — из общего `ImageViewer` (подписи из i18n).
    for (const label of ['Zoom out', 'Zoom in', 'Reset zoom']) {
      expect(document.querySelector(`button[aria-label="${label}"]`)).not.toBeNull()
    }
  })

  it('зум работает, а смена индекса сбрасывает масштаб', async () => {
    const onIndexChange = () => {}
    const { root } = await mount(
      <AttachmentGallery
        images={IMAGES}
        index={0}
        onIndexChange={onIndexChange}
        open
        onOpenChange={() => {}}
      />,
    )

    const zoomIn = document.querySelector('button[aria-label="Zoom in"]')!
    await click(zoomIn)
    expect(scaleOf(galleryImage())).toBeGreaterThan(1)

    // Новая картинка (другой index) — новая геометрия, зум сброшен.
    await rerender(
      root,
      <AttachmentGallery
        images={IMAGES}
        index={1}
        onIndexChange={onIndexChange}
        open
        onOpenChange={() => {}}
      />,
    )

    const next = galleryImage()
    expect(next.getAttribute('src')).toBe(IMAGES[1]!.url)
    expect(next.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')
    const counter = document.querySelector('[data-testid="attachment-gallery-counter"]')
    expect(counter?.textContent).toContain('2 / 2')
  })
})
