import { describe, it, expect, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SettingsPanel } from './SettingsPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderPanel(
  props: React.ComponentProps<typeof SettingsPanel>,
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(<SettingsPanel {...props} />)
  })
  return host
}

/** Заглушка matchMedia: телефон + coarse pointer, иначе — всё false (десктоп). */
function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 768px)' || query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollTop', { value, writable: true, configurable: true })
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('SettingsPanel', () => {
  it('рендерит заголовок, описание, actions и контент', async () => {
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      actions: <button>ACTION</button>,
      children: <div>CONTENT</div>,
    })

    expect(host.querySelector('h2')?.textContent).toBe('Network')
    expect(host.textContent).toContain('Configure networking')
    expect(host.textContent).toContain('ACTION')
    expect(host.textContent).toContain('CONTENT')
  })

  it('fixed: футер вне scroll-тела', async () => {
    const host = await renderPanel({
      title: 'Network',
      footer: <button>FOOTER</button>,
      children: <div>CONTENT</div>,
    })

    const scroll = host.querySelector('.overflow-y-auto')
    const footer = host.querySelector('button')!
    expect(scroll).not.toBeNull()
    expect(scroll!.contains(footer)).toBe(false)
  })

  it('sticky: футер внутри scroll-тела', async () => {
    const host = await renderPanel({
      title: 'Network',
      footerVariant: 'sticky',
      footer: <button>FOOTER</button>,
      children: <div>CONTENT</div>,
    })

    const scroll = host.querySelector('.overflow-y-auto')
    const footer = host.querySelector('button')!
    expect(scroll).not.toBeNull()
    expect(scroll!.contains(footer)).toBe(true)
    expect(host.querySelector('.sticky')).not.toBeNull()
  })

  it('не рендерит футер, если он не передан', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    expect(host.querySelector('button')).toBeNull()
  })

  it('нет горизонтального скролла: контент центрирован max-w-3xl и min-w-0', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    expect(host.querySelector('.overflow-x-hidden')).not.toBeNull()
    expect(host.querySelector('.max-w-3xl')).not.toBeNull()
    expect(host.querySelector('.min-w-0')).not.toBeNull()
    expect(host.innerHTML).not.toContain('pr-2')
  })

  it('тело помечено settings-scroll-container', async () => {
    const host = await renderPanel({ title: 'Network', children: <div>CONTENT</div> })
    const body = host.querySelector('.settings-scroll-container')
    expect(body).not.toBeNull()
    expect(body!.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('collapsibleHeader: на теле при скролле описание скрывается, наверх — разворачивается', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    expect(desc).not.toBeNull()
    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)

    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(desc.classList.contains('opacity-0')).toBe(true)
    expect(body.getAttribute('data-scroll-shadow')).toBe('top')

    setScrollTop(body, 0)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
    expect(desc.classList.contains('opacity-100')).toBe(true)
    expect(body.hasAttribute('data-scroll-shadow')).toBe(false)
  })

  it('collapsibleHeader: сворачивание реально уменьшает высоту шапки (0fr + min-h-0/overflow-hidden)', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement
    // Без min-h-0/overflow-hidden строка grid не схлопывается ниже min-content,
    // поэтому визуально описание исчезает, а высота шапки не уменьшается.
    const text = desc.querySelector('p') as HTMLElement
    expect(text.classList.contains('min-h-0')).toBe(true)
    expect(text.classList.contains('overflow-hidden')).toBe(true)
    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)

    setScrollTop(body, 20)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    // При схлопывании строка становится 0fr, а дочерний <p> — нулевой min-height.
    expect(desc.classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(text.classList.contains('min-h-0')).toBe(true)
    expect(text.classList.contains('overflow-hidden')).toBe(true)
  })

  it('collapsibleHeader: на десктопе описание остаётся видимым', async () => {
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement

    setScrollTop(body, 50)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
    // Затенение при этом работает и на десктопе.
    expect(body.getAttribute('data-scroll-shadow')).toBe('top')
  })

  it('collapsibleHeader=false: на теле описание не сворачивается', async () => {
    stubPhone()
    const host = await renderPanel({
      title: 'Network',
      description: 'Configure networking',
      collapsibleHeader: false,
      children: <div>CONTENT</div>,
    })
    const body = host.querySelector('.settings-scroll-container') as HTMLElement
    const desc = host.querySelector('[data-testid="settings-header-description"]') as HTMLElement

    setScrollTop(body, 40)
    await act(async () => {
      body.dispatchEvent(new Event('scroll'))
    })

    expect(desc.classList.contains('grid-rows-[1fr]')).toBe(true)
  })
})
