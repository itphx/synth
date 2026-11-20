import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) захватывает localStorage при импорте сторов — заглушка до импорта.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

/** Перехват пропсов ToastContainer: проверяем, что `position` приходит из хука. */
const toastProps = vi.hoisted(() => ({ latest: null as null | { position?: string } }))

vi.mock('react-toastify', () => ({
  ToastContainer: (props: { position?: string }) => {
    toastProps.latest = props
    return null
  },
}))

// App — каркас из десятков тяжёлых зон (транспорт, панели, ленивые модалки),
// поэтому в этом тесте они подменены заглушками: проверяется только проброс
// позиции тостов, а не рендер приложения целиком.
vi.mock('./components/layout/Sidebar', () => ({
  Sidebar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('./components/layout/Header', () => ({ Header: () => null }))
vi.mock('./components/layout/CenterPanel', () => ({ CenterPanel: () => null }))
vi.mock('./components/layout/MobileDrawer', () => ({
  MobileDrawer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('./components/layout/BackendConnection', () => ({ BackendConnection: () => null }))
vi.mock('./components/layout/ConnectionStatus', () => ({ ConnectionStatus: () => null }))
vi.mock('./components/layout/PwaUpdatePrompt', () => ({ PwaUpdatePrompt: () => null }))
vi.mock('./components/layout/HybridOfflineBanner', () => ({ HybridOfflineBanner: () => null }))
vi.mock('./components/panels/LeftPanel', () => ({ LeftPanel: () => null }))
vi.mock('./components/panels/RightPanel', () => ({ RightPanel: () => null }))
vi.mock('./components/panels/ProjectsTabToolbar', () => ({ ProjectsTabToolbar: () => null }))
vi.mock('./components/panels/FilesTabToolbar', () => ({ FilesTabToolbar: () => null }))
vi.mock('./components/panels/GitTabToolbar', () => ({ GitTabToolbar: () => null }))
vi.mock('./components/ui/EntityEditDialog', () => ({ EntityEditDialog: () => null }))
vi.mock('./components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }))
vi.mock('./components/ui/TitleTooltipBridge', () => ({ TitleTooltipBridge: () => null }))
vi.mock('./components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('./components/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/lib/api/profileService', () => ({
  profileService: {
    getEffectivePreferences: async () => null,
    getDefaults: async () => ({}),
  },
}))
vi.mock('@/hooks/useViewportHeight', () => ({ useViewportHeight: () => {} }))
vi.mock('@/hooks/useStaleTurnGuard', () => ({ useStaleTurnGuard: () => {} }))

import App from './App'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = () => void
const state = { phone: false }
const listeners = new Set<Listener>()

function matchesQuery(query: string): boolean {
  if (query.includes('min-width: 769px')) return false
  if (query.includes('max-width: 768px')) return state.phone
  return false
}

function installMatchMedia(): void {
  const matchMedia = (query: string) => ({
    media: query,
    matches: matchesQuery(query),
    onchange: null,
    addEventListener: (_type: 'change', listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: 'change', listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => false,
  })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })
}

/** jsdom не даёт ResizeObserver, а `App` вешает его на центральную колонку. */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function mountApp(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<App />)
  })
}

beforeEach(() => {
  state.phone = false
  listeners.clear()
  toastProps.latest = null
  installMatchMedia()
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  listeners.clear()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
  vi.unstubAllGlobals()
})

describe('App: позиция ToastContainer', () => {
  it('десктоп → bottom-right', async () => {
    await mountApp()

    expect(toastProps.latest?.position).toBe('bottom-right')
  })

  it('телефон → top-center', async () => {
    state.phone = true

    await mountApp()

    expect(toastProps.latest?.position).toBe('top-center')
  })

  it('смена зоны устройства в рантайме переключает позицию без перезагрузки', async () => {
    await mountApp()
    expect(toastProps.latest?.position).toBe('bottom-right')

    await act(async () => {
      state.phone = true
      for (const listener of [...listeners]) listener()
    })

    expect(toastProps.latest?.position).toBe('top-center')
  })
})
