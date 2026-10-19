import { afterEach, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'

import { SettingsSection } from './SettingsSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderSection(
  props: Omit<React.ComponentProps<typeof SettingsSection>, 'children'>,
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SettingsSection {...props}>
          <div>CONTENT</div>
        </SettingsSection>
      </TooltipProvider>,
    )
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

describe('SettingsSection — подсказка только рядом с заголовком', () => {
  it('без title не рендерит висящую иконку ⓘ', async () => {
    const host = await renderSection({ id: 'no-title', tooltip: 'Help' })

    expect(host.querySelector('[data-testid="settings-field-tooltip"]')).toBeNull()
    // Без заголовка/описания/actions шапки нет вовсе.
    expect(host.querySelector('h3')).toBeNull()
    expect(host.textContent).toContain('CONTENT')
  })

  it('с title рендерит иконку ⓘ в той же строке, что и заголовок', async () => {
    const host = await renderSection({ id: 'with-title', title: 'Section', tooltip: 'Help' })

    const heading = host.querySelector('h3')!
    const tooltip = host.querySelector('[data-testid="settings-field-tooltip"]')!
    expect(heading.textContent).toBe('Section')
    expect(tooltip).not.toBeNull()
    expect(tooltip.getAttribute('aria-label')).toBe('Help')
    // Иконка — сосед заголовка внутри одной flex-строки, а не отдельной строкой.
    expect(tooltip.parentElement).toBe(heading.parentElement)
    expect(tooltip.parentElement?.className).toContain('flex')
  })

  it('с title без tooltip иконки нет', async () => {
    const host = await renderSection({ id: 'plain-title', title: 'Section' })

    expect(host.querySelector('h3')?.textContent).toBe('Section')
    expect(host.querySelector('[data-testid="settings-field-tooltip"]')).toBeNull()
  })
})
