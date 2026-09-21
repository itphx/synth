import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SliderField } from './SliderField'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderSlider(props: React.ComponentProps<typeof SliderField>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(<SliderField {...props} />)
  })
  return host
}

function setRangeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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

describe('SliderField', () => {
  it('рендерит range с min/max/step, лейблом и форматированным значением', async () => {
    const host = await renderSlider({
      label: 'Confidence',
      min: 0.5,
      max: 1,
      step: 0.05,
      value: 0.8,
      onValueChange: vi.fn(),
      formatValue: (v) => v.toFixed(2),
    })

    const input = host.querySelector('input[type="range"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.min).toBe('0.5')
    expect(input.max).toBe('1')
    expect(input.step).toBe('0.05')
    expect(input.value).toBe('0.8')
    expect(input.getAttribute('aria-label')).toBe('Confidence')
    expect(host.textContent).toContain('Confidence')
    expect(host.querySelector('[data-testid="slider-value"]')?.textContent).toBe('0.80')
  })

  it('изменение значения вызывает onValueChange с числом', async () => {
    const onValueChange = vi.fn()
    const host = await renderSlider({
      label: 'Confidence',
      min: 0.5,
      max: 1,
      step: 0.05,
      value: 0.8,
      onValueChange,
    })

    const input = host.querySelector('input[type="range"]') as HTMLInputElement
    await act(async () => {
      setRangeValue(input, '0.95')
    })

    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith(0.95)
  })

  it('disabled блокирует слайдер', async () => {
    const host = await renderSlider({ value: 0.5, onValueChange: vi.fn(), disabled: true })
    const input = host.querySelector('input[type="range"]') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('без formatValue показывает сырое значение', async () => {
    const host = await renderSlider({ value: 0.5, onValueChange: vi.fn() })
    expect(host.querySelector('[data-testid="slider-value"]')?.textContent).toBe('0.5')
  })
})
