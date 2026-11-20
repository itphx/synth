import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import {
  useToastPlacement,
  TOAST_PLACEMENT_DEFAULT,
  TOAST_PLACEMENT_MOBILE,
} from './useToastPlacement'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = () => void

/**
 * jsdom не даёт matchMedia, поэтому подменяем носитель признака «зона
 * устройства» — `matchMedia` — и управляем им вручную. `useDevice` читает три
 * запроса (`BREAKPOINTS` из `lib/device.ts`), подписки `useMediaQuery`
 * складываем, чтобы проверять реактивность (поворот/ресайз).
 */
const state = { phone: false, tablet: false, coarse: false }
const listeners = new Set<Listener>()

function matchesQuery(query: string): boolean {
  // Планшетный запрос содержит и min-width, и max-width — проверяем его первым.
  if (query.includes('min-width: 769px')) return state.tablet
  if (query.includes('max-width: 768px')) return state.phone
  if (query.includes('pointer: coarse')) return state.coarse
  return false
}

function installMatchMedia(): void {
  const matchMedia = (query: string) => ({
    media: query,
    matches: matchesQuery(query),
    onchange: null,
    addEventListener: (_type: 'change', listener: Listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'change', listener: Listener) => {
      listeners.delete(listener)
    },
    addListener: (listener: Listener) => {
      listeners.add(listener)
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener)
    },
    dispatchEvent: () => false,
  })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })
}

function setDevice(next: Partial<typeof state>): void {
  Object.assign(state, next)
  for (const listener of [...listeners]) listener()
}

function resetDevice(): void {
  state.phone = false
  state.tablet = false
  state.coarse = false
  listeners.clear()
}

function Probe() {
  const placement = useToastPlacement()
  return <div data-testid="placement">{placement}</div>
}

const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function mountProbe(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<Probe />)
  })
  return host
}

function placement(host: HTMLElement): string | null {
  return host.querySelector('[data-testid="placement"]')!.textContent
}

beforeEach(() => {
  resetDevice()
  installMatchMedia()
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  resetDevice()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('useToastPlacement', () => {
  it('телефон → top-center (тосты не перекрывают композер)', async () => {
    setDevice({ phone: true, coarse: true })

    const host = await mountProbe()

    expect(placement(host)).toBe(TOAST_PLACEMENT_MOBILE)
    expect(TOAST_PLACEMENT_MOBILE).toBe('top-center')
  })

  it('десктоп → прежний bottom-right', async () => {
    const host = await mountProbe()

    expect(placement(host)).toBe(TOAST_PLACEMENT_DEFAULT)
    expect(TOAST_PLACEMENT_DEFAULT).toBe('bottom-right')
  })

  it('планшет остаётся на bottom-right', async () => {
    setDevice({ tablet: true, coarse: true })

    const host = await mountProbe()

    expect(placement(host)).toBe(TOAST_PLACEMENT_DEFAULT)
  })

  it('реактивность: ресайз в телефонную зону и обратно переключает позицию без перезагрузки', async () => {
    const host = await mountProbe()
    expect(placement(host)).toBe(TOAST_PLACEMENT_DEFAULT)

    // Сужение вьюпорта / поворот в портрет: media-query начинает совпадать.
    await act(async () => {
      setDevice({ phone: true, coarse: true })
    })
    expect(placement(host)).toBe(TOAST_PLACEMENT_MOBILE)

    await act(async () => {
      setDevice({ phone: false, coarse: false })
    })
    expect(placement(host)).toBe(TOAST_PLACEMENT_DEFAULT)
  })

  it('без matchMedia (SSR/jsdom-фоллбек) → bottom-right', async () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia

    const host = await mountProbe()

    expect(placement(host)).toBe(TOAST_PLACEMENT_DEFAULT)
  })
})
