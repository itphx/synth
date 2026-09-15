import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { useViewportHeight } from './useViewportHeight'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const APP_HEIGHT_VAR = '--synth-app-height'

function Probe() {
  useViewportHeight()
  return null
}

type Mounted = { host: HTMLElement; root: Root }
const mounted: Mounted[] = []

async function mountProbe(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<Probe />)
  })
}

function makeVisualViewport(init: Partial<VisualViewport>): VisualViewport {
  return {
    width: 400,
    height: 600,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    ...init,
  } as unknown as VisualViewport
}

function installVisualViewport(vv: VisualViewport | undefined): void {
  if (vv === undefined) {
    delete (window as unknown as Record<string, unknown>).visualViewport
    return
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
}

function appHeight(): string {
  return document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR)
}

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).visualViewport
  document.documentElement.style.removeProperty(APP_HEIGHT_VAR)
})

describe('useViewportHeight', () => {
  it('ограничивает высоту layout viewport, если visualViewport больше (альбомная ориентация)', async () => {
    vi.stubGlobal('innerHeight', 700)
    installVisualViewport(makeVisualViewport({ height: 900 }))

    await mountProbe()

    expect(appHeight()).toBe('min(100dvh, 700px)')
  })

  it('уменьшает высоту вместе с visualViewport (открытая клавиатура)', async () => {
    vi.stubGlobal('innerHeight', 900)
    installVisualViewport(makeVisualViewport({ height: 560 }))

    await mountProbe()

    expect(appHeight()).toBe('min(100dvh, 560px)')
  })

  it('без visualViewport использует window.innerHeight', async () => {
    vi.stubGlobal('innerHeight', 800)
    installVisualViewport(undefined)

    await mountProbe()

    expect(appHeight()).toBe('min(100dvh, 800px)')
  })

  it('не пишет высоту при нулевых данных (остаётся CSS-fallback)', async () => {
    vi.stubGlobal('innerHeight', 0)
    installVisualViewport(makeVisualViewport({ height: 0 }))

    await mountProbe()

    expect(appHeight()).toBe('')
  })

  it('снимает переменную при размонтировании', async () => {
    vi.stubGlobal('innerHeight', 800)
    installVisualViewport(makeVisualViewport({ height: 800 }))

    await mountProbe()
    expect(appHeight()).toBe('min(100dvh, 800px)')

    const { root } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })

    expect(appHeight()).toBe('')
  })
})
