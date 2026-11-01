import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SegmentedControl } from './SegmentedControl'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

async function renderControl(
  props: React.ComponentProps<typeof SegmentedControl<string>>,
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  await act(async () => {
    root.render(<SegmentedControl {...props} />)
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

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

describe('SegmentedControl', () => {
  it('дорожка с внутренним отступом, сегменты ниже --control-height', async () => {
    const host = await renderControl({ value: 'a', options: OPTIONS, onChange: vi.fn() })
    const track = host.querySelector('[role="radiogroup"]') as HTMLElement
    // 2px отступа по краям: активная «таблетка» внутри рамки не касается контура;
    // высота сегмента = 30 − 4 = 26px при `--control-height` 30px.
    expect(track.classList.contains('p-0.5')).toBe(true)
    const segments = host.querySelectorAll('[role="radio"]')
    expect(segments).toHaveLength(2)
    segments.forEach((segment) => {
      expect(segment.classList.contains('h-[calc(var(--control-height)-0.25rem)]')).toBe(true)
      expect(segment.classList.contains('h-[var(--control-height)]')).toBe(false)
    })
  })

  it('активный сегмент — таблетка (`bg-surface-card`), неактивный — приглушённый', async () => {
    const host = await renderControl({ value: 'b', options: OPTIONS, onChange: vi.fn() })
    const segments = host.querySelectorAll('[role="radio"]')
    expect(segments[0]!.getAttribute('aria-checked')).toBe('false')
    expect(segments[1]!.getAttribute('aria-checked')).toBe('true')
    expect(segments[1]!.classList.contains('bg-surface-card')).toBe(true)
    expect(segments[0]!.classList.contains('text-muted-foreground')).toBe(true)
  })

  it('клик по сегменту вызывает onChange с его value', async () => {
    const onChange = vi.fn()
    const host = await renderControl({ value: 'a', options: OPTIONS, onChange })
    const segments = host.querySelectorAll('[role="radio"]')
    await act(async () => {
      ;(segments[1] as HTMLButtonElement).click()
    })
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
