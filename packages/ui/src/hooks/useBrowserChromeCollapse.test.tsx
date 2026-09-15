import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { useBrowserChromeCollapse } from './useBrowserChromeCollapse'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function installMatchMedia(mobile: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const matches = mobile && query === '(max-width: 768px)'
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
  })
}

function Probe() {
  useBrowserChromeCollapse()
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let scrollTo: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // Запас прокрутки: scrollHeight > innerHeight, как в мобильной зоне.
  vi.stubGlobal('innerHeight', 768)
  Object.defineProperty(document, 'scrollingElement', {
    configurable: true,
    get: () => document.documentElement,
  })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => 776,
  })
  scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

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
  delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight
  delete (document as unknown as Record<string, unknown>).scrollingElement
})

describe('useBrowserChromeCollapse', () => {
  it('на мобильном делает нудж root-документа после монтирования', async () => {
    installMatchMedia(true)
    await mountProbe()
    await act(async () => {
      await wait(60)
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 8)
  })

  it('повторяет нудж после фокуса в поле ввода', async () => {
    installMatchMedia(true)
    await mountProbe()
    await act(async () => {
      await wait(60)
    })
    scrollTo.mockClear()

    window.dispatchEvent(new Event('focusin'))
    await act(async () => {
      await wait(400)
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 8)
  })

  it('на десктопе — no-op', async () => {
    installMatchMedia(false)
    await mountProbe()
    await act(async () => {
      await wait(80)
    })
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
