import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { Tabs } from './Tabs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderTabs(props: React.ComponentProps<typeof Tabs>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(<Tabs {...props} />)
  })
  return host
}

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  document.body.innerHTML = ''
})

const ITEMS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

describe('Tabs', () => {
  it('рендерит вкладки, активная помечена aria-selected', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'b', onChange: vi.fn() })

    const list = host.querySelector('[role="tablist"]') as HTMLElement
    const tabs = host.querySelectorAll('[role="tab"]')
    expect(list).not.toBeNull()
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.textContent).toBe('Beta')
  })

  it('ariaLabel попадает на tablist', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange: vi.fn(), ariaLabel: 'Views' })
    expect(host.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Views')
  })

  it('клик по вкладке вызывает onChange с её value', async () => {
    const onChange = vi.fn()
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange })
    const tabs = host.querySelectorAll('[role="tab"]')
    await act(async () => {
      ;(tabs[1] as HTMLButtonElement).click()
    })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('мобильно-устойчиво: контейнер items-stretch, вкладки flex-1 min-w-0', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange: vi.fn() })
    const list = host.querySelector('[role="tablist"]') as HTMLElement
    expect(list.classList.contains('items-stretch')).toBe(true)
    expect(list.classList.contains('flex')).toBe(true)
    host.querySelectorAll('[role="tab"]').forEach((tab) => {
      expect(tab.classList.contains('flex-1')).toBe(true)
      expect(tab.classList.contains('min-w-0')).toBe(true)
    })
  })

  it('segmented: активная вкладка с фоном, неактивная — muted', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange: vi.fn() })
    const tabs = host.querySelectorAll('[role="tab"]')
    expect(tabs[0]!.classList.contains('bg-background')).toBe(true)
    expect(tabs[1]!.classList.contains('text-muted-foreground')).toBe(true)
  })

  it('variant underline: подчёркивание активной, без фона', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange: vi.fn(), variant: 'underline' })
    const tabs = host.querySelectorAll('[role="tab"]')
    expect(tabs[0]!.classList.contains('border-b-2')).toBe(true)
    expect(tabs[0]!.classList.contains('bg-background')).toBe(false)
    expect(host.querySelector('[role="tablist"]')!.classList.contains('tab-scroll-container')).toBe(true)
  })

  it('дефолтный variant — segmented', async () => {
    const host = await renderTabs({ items: ITEMS, value: 'a', onChange: vi.fn() })
    expect(host.querySelector('[role="tablist"]')!.classList.contains('bg-muted')).toBe(true)
  })
})
