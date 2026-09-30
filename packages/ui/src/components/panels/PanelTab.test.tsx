import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { PanelTab } from './PanelTab'

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

describe('PanelTab — каркас вкладки правой панели', () => {
  it('рендерит тело с прокруткой и переданным содержимым', async () => {
    const container = await render(
      <PanelTab>
        <span data-testid="content">hello</span>
      </PanelTab>,
    )
    const body = container.querySelector('[data-testid="panel-tab-body"]')
    expect(body).not.toBeNull()
    expect(body!.textContent).toContain('hello')
  })

  it('без footer не рендерит футер', async () => {
    const container = await render(
      <PanelTab>
        <span>body</span>
      </PanelTab>,
    )
    expect(container.querySelector('[data-testid="panel-tab-footer"]')).toBeNull()
  })

  it('с footer рендерит фиксированный футер с переданным содержимым', async () => {
    const container = await render(
      <PanelTab footer={<button type="button">Save</button>}>
        <span>body</span>
      </PanelTab>,
    )
    const footer = container.querySelector('[data-testid="panel-tab-footer"]')
    expect(footer).not.toBeNull()
    expect(footer!.textContent).toContain('Save')
  })
})
