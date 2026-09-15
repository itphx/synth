import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { useFullscreen } from './useFullscreen'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FullscreenResult = ReturnType<typeof useFullscreen>

let result: FullscreenResult | undefined

function Probe() {
  result = useFullscreen()
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

function defineFullscreen(prop: string, value: unknown): void {
  Object.defineProperty(document, prop, { configurable: true, get: () => value })
}

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.restoreAllMocks()
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled
  delete (document as unknown as Record<string, unknown>).webkitFullscreenEnabled
  delete (document as unknown as Record<string, unknown>).fullscreenElement
  delete (document as unknown as Record<string, unknown>).webkitFullscreenElement
  delete (document as unknown as Record<string, unknown>).exitFullscreen
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen
  delete (document.documentElement as unknown as Record<string, unknown>).webkitRequestFullscreen
  result = undefined
})

describe('useFullscreen', () => {
  it('в jsdom без Fullscreen API сообщает supported=false', async () => {
    await mountProbe()
    expect(result?.supported).toBe(false)
    expect(result?.isFullscreen).toBe(false)
  })

  it('поддерживает webkit-префикс и реагирует на webkitfullscreenchange', async () => {
    defineFullscreen('webkitFullscreenEnabled', true)
    const request = vi.fn()
    Object.defineProperty(document.documentElement, 'webkitRequestFullscreen', {
      configurable: true,
      value: request,
    })

    await mountProbe()
    expect(result?.supported).toBe(true)

    await act(async () => {
      result?.toggle()
    })
    expect(request).toHaveBeenCalledTimes(1)

    defineFullscreen('webkitFullscreenElement', document.documentElement)
    await act(async () => {
      document.dispatchEvent(new Event('webkitfullscreenchange'))
    })
    expect(result?.isFullscreen).toBe(true)
  })

  it('вызывает requestFullscreen/exitFullscreen без префикса', async () => {
    defineFullscreen('fullscreenEnabled', true)
    defineFullscreen('fullscreenElement', null)
    const request = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: request,
    })
    const exit = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exit,
    })

    await mountProbe()
    expect(result?.supported).toBe(true)

    await act(async () => {
      result?.toggle()
    })
    expect(request).toHaveBeenCalledTimes(1)

    defineFullscreen('fullscreenElement', document.documentElement)
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(result?.isFullscreen).toBe(true)

    await act(async () => {
      result?.toggle()
    })
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('гасит отклонённый промис запроса', async () => {
    defineFullscreen('fullscreenEnabled', true)
    defineFullscreen('fullscreenElement', null)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('not allowed')),
    })

    await mountProbe()
    await act(async () => {
      expect(() => result?.toggle()).not.toThrow()
    })
  })

  it('снимает слушатели при размонтировании', async () => {
    defineFullscreen('fullscreenEnabled', true)
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    await mountProbe()
    expect(addSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
    expect(addSpy).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function))

    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()

    expect(removeSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('webkitfullscreenchange', expect.any(Function))
  })
})
