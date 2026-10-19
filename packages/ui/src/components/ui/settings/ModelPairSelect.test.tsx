import { afterEach, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'

import { ModelPairSelect, type ModelPairSelectProps } from './ModelPairSelect'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

const BASE_PROPS: ModelPairSelectProps = {
  label: 'Pair',
  provider: 'itphx',
  model: 'model-a',
  providers: [{ name: 'itphx' }, { name: 'ollama' }],
  models: [{ name: 'model-a', provider: 'itphx' }],
  providerLabel: 'Provider',
  modelLabel: 'Model',
  providerTooltip: 'Provider help',
  modelTooltip: 'Model help',
  providerTestId: 'pair-provider',
  modelTestId: 'pair-model',
  onProviderChange: () => {},
  onModelChange: () => {},
}

async function renderPair(overrides: Partial<ModelPairSelectProps> = {}): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ModelPairSelect {...BASE_PROPS} {...overrides} />
      </TooltipProvider>,
    )
  })
  return host
}

function labelByText(host: HTMLElement, text: string): HTMLLabelElement | undefined {
  return Array.from(host.querySelectorAll('label')).find(
    (label) => label.textContent?.trim() === text,
  ) as HTMLLabelElement | undefined
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

describe('ModelPairSelect — подписи и подсказки (ADR-072/ADR-089)', () => {
  it('в variant=settings рендерит подписи «Provider»/«Model» и иконку ⓘ рядом с каждой', async () => {
    const host = await renderPair({ variant: 'settings' })

    const providerLabel = labelByText(host, 'Provider')
    const modelLabel = labelByText(host, 'Model')
    expect(providerLabel).toBeTruthy()
    expect(modelLabel).toBeTruthy()

    const providerTooltip = providerLabel!.querySelector('[data-testid="settings-field-tooltip"]')
    const modelTooltip = modelLabel!.querySelector('[data-testid="settings-field-tooltip"]')
    expect(providerTooltip).not.toBeNull()
    expect(modelTooltip).not.toBeNull()
    expect(providerTooltip!.getAttribute('aria-label')).toBe('Provider help')
    expect(modelTooltip!.getAttribute('aria-label')).toBe('Model help')
  })

  it('в variant=compact не рендерит подписи и висящие иконки, даже если tooltip передан', async () => {
    const host = await renderPair({ variant: 'compact' })

    expect(host.querySelectorAll('label')).toHaveLength(0)
    expect(host.querySelectorAll('[data-testid="settings-field-tooltip"]')).toHaveLength(0)

    expect(
      host.querySelector('[data-testid="pair-provider"]')?.getAttribute('aria-label'),
    ).toBe('Pair — Provider')
    expect(
      host.querySelector('[data-testid="pair-model"]')?.getAttribute('aria-label'),
    ).toBe('Pair — Model')
  })
})
