import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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

vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: 'phone', isTouch: true }),
}))

vi.mock('../admin/DashboardPanel', () => ({
  DashboardPanel: () => <div>dashboard-panel</div>,
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SettingsModal } from './SettingsModal'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
})

describe('SettingsModal — мобильная категория по умолчанию', () => {
  it('на телефоне активная категория dashboard помечена aria-current="page"', async () => {
    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    useUIStore.setState({ isSettingsDialogOpen: true, settingsPage: 'dashboard' })
    useAuthStore.setState({ user: { roles: ['ADMIN'] } as never })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsModal />
        </I18nProvider>,
      )
    })

    const active = document.querySelector('button[aria-current="page"]')
    expect(active).not.toBeNull()
    expect(active?.textContent).toContain('Dashboard')
  })
})
