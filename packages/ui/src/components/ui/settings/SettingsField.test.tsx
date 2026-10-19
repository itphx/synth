import { afterEach, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'

import { SettingsField } from './SettingsField'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderField(
  props: Omit<React.ComponentProps<typeof SettingsField>, 'children'>,
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SettingsField {...props}>
          <input aria-label="control" />
        </SettingsField>
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

describe('SettingsField — подсказка только рядом с заголовком', () => {
  it('с лейблом рендерит ⓘ внутри строки заголовка', async () => {
    const host = await renderField({ label: 'Field', tooltip: 'Help' })

    const label = host.querySelector('label')!
    expect(label.textContent).toContain('Field')
    expect(label.querySelector('[data-testid="settings-field-tooltip"]')).not.toBeNull()
  })

  it('без лейбла не рендерит висящую иконку ⓘ', async () => {
    const host = await renderField({ tooltip: 'Help' })

    expect(host.querySelector('label')).toBeNull()
    expect(host.querySelector('[data-testid="settings-field-tooltip"]')).toBeNull()
  })
})
