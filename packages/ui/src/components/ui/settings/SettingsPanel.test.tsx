import { describe, it, expect, afterEach } from 'vitest'
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
})
