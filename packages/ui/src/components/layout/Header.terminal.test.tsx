import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — мок для детерминизма.
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

if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {}
}

const mocks = vi.hoisted(() => ({
  deviceType: 'desktop' as 'desktop' | 'phone' | 'tablet',
  open: vi.fn().mockResolvedValue(undefined),
  launcherArgs: [] as Array<{ sessionId?: string; projectId?: string }>,
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: vi.fn() }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: mocks.deviceType, isTouch: false }),
}))
vi.mock('@/lib/api/profileService', () => ({
  profileService: {
    syncChatViewModeToProfile: vi.fn().mockResolvedValue(undefined),
    syncChatDensityToProfile: vi.fn().mockResolvedValue(undefined),
  },
}))
// Тяжёлые соседи шапки — заглушки: тест про кнопку «Терминал».
vi.mock('./AnalyticsButton', () => ({ AnalyticsButton: () => null }))
vi.mock('./NotificationPopup', () => ({ NotificationPopup: () => null }))
vi.mock('./GlobalTransportIndicator', () => ({ GlobalTransportIndicator: () => null }))
vi.mock('./HybridStatusIndicator', () => ({ HybridStatusIndicator: () => null }))
vi.mock('./PwaInstallButton', () => ({ PwaInstallButton: () => null }))
vi.mock('../auth/QuickSettingsPopup', () => ({ QuickSettingsPopup: () => null }))
// Терминальный запуск — предмет теста; сам хук проверяется отдельно.
vi.mock('@/hooks/useTerminalLauncher', () => ({
  useTerminalLauncher: (sessionId?: string, projectId?: string) => {
    mocks.launcherArgs.push({ sessionId, projectId })
    return { liveTerminal: undefined, open: mocks.open, busy: false }
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Header } from './Header'
import { useUIStore } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderHeader(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Header onSettingsClick={() => {}} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

/** Кнопка «Терминал» в шапке. */
function terminalButton(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="header-terminal"]') as HTMLButtonElement | null
}

beforeEach(() => {
  mocks.deviceType = 'desktop'
  mocks.launcherArgs = []
  vi.clearAllMocks()
  mocks.open.mockResolvedValue(undefined)
  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'Session', project_id: 'p1' }] as never,
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('Header: кнопка «Терминал»', () => {
  it('рендерится на чат-вкладке и открывает терминал сессии', async () => {
    await renderHeader()

    const button = terminalButton()
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-label')).toBe('Terminal')

    await act(async () => {
      button!.click()
    })
    await act(async () => {})

    expect(mocks.open).toHaveBeenCalledTimes(1)
    // Хук получает сессию активной вкладки и её проект — иначе терминал негде создать.
    expect(mocks.launcherArgs[mocks.launcherArgs.length - 1]).toEqual({
      sessionId: 's1',
      projectId: 'p1',
    })
  })

  it('на телефоне кнопка с увеличенным тач-таргетом', async () => {
    mocks.deviceType = 'phone'
    await renderHeader()

    const button = terminalButton()
    expect(button).not.toBeNull()
    expect(button!.className).toContain('h-9')
  })

  it('не на чат-вкладке кнопки нет', async () => {
    useUIStore.setState({
      activeCenterTabId: 'tab-2',
      centerTabs: [{ id: 'tab-2', type: 'file-viewer', title: 'File', data: { filePath: 'a.txt' } }],
    })
    await renderHeader()

    expect(terminalButton()).toBeNull()
  })
})
