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
  syncChatViewModeToProfile: vi.fn().mockResolvedValue(undefined),
  syncChatDensityToProfile: vi.fn().mockResolvedValue(undefined),
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
    syncChatViewModeToProfile: mocks.syncChatViewModeToProfile,
    syncChatDensityToProfile: mocks.syncChatDensityToProfile,
  },
}))
// Тяжёлые соседи шапки — заглушки: тест про быстрый переключатель вида.
vi.mock('./AnalyticsButton', () => ({ AnalyticsButton: () => null }))
vi.mock('./NotificationPopup', () => ({ NotificationPopup: () => null }))
vi.mock('./GlobalTransportIndicator', () => ({ GlobalTransportIndicator: () => null }))
vi.mock('./HybridStatusIndicator', () => ({ HybridStatusIndicator: () => null }))
vi.mock('./PwaInstallButton', () => ({ PwaInstallButton: () => null }))
vi.mock('../auth/QuickSettingsPopup', () => ({ QuickSettingsPopup: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Header } from './Header'
import { useUIStore } from '@/stores/useUIStore'

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

/** Кнопка быстрого переключателя (по `data-testid`). */
function trigger(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="chat-view-controls"]') as HTMLButtonElement | null
}

/** Кнопка-сегмент поповера по видимой подписи. */
function segment(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (b) => b.textContent === label,
  )
}

beforeEach(() => {
  mocks.deviceType = 'desktop'
  vi.clearAllMocks()
  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    chatViewMode: 'detailed',
    chatDensity: 'normal',
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
  // PopoverContent рендерится в портал (document.body) — чистим остатки.
  document.body.innerHTML = ''
})

describe('Header: быстрый переключатель вида и плотности', () => {
  it('кнопка рендерится на чат-вкладке и открывает поповер', async () => {
    await renderHeader()

    const button = trigger()
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-haspopup')).toBe('dialog')

    await act(async () => {
      button!.click()
    })
    await act(async () => {})

    expect(segment('Detailed')).toBeTruthy()
    expect(segment('Feed')).toBeTruthy()
    expect(segment('Normal')).toBeTruthy()
    expect(segment('Compact')).toBeTruthy()
  })

  it('переключение вида и плотности сразу меняет стор и уезжает в профиль', async () => {
    await renderHeader()

    await act(async () => {
      trigger()!.click()
    })
    await act(async () => {})

    await act(async () => {
      segment('Feed')!.click()
    })
    await act(async () => {})

    expect(useUIStore.getState().chatViewMode).toBe('feed')
    expect(mocks.syncChatViewModeToProfile).toHaveBeenCalledWith('feed')

    await act(async () => {
      segment('Compact')!.click()
    })
    await act(async () => {})

    expect(useUIStore.getState().chatDensity).toBe('compact')
    expect(mocks.syncChatDensityToProfile).toHaveBeenCalledWith('compact')
  })

  it('на телефоне кнопка имеет тач-таргет ≥40px', async () => {
    mocks.deviceType = 'phone'
    await renderHeader()

    const button = trigger()
    expect(button).not.toBeNull()
    expect(button!.className).toContain('pointer-coarse:size-10')
  })

  it('не на чат-вкладке кнопки нет', async () => {
    useUIStore.setState({
      activeCenterTabId: 'tab-2',
      centerTabs: [{ id: 'tab-2', type: 'file-viewer', title: 'File', data: { filePath: 'a.txt' } }],
    })
    await renderHeader()

    expect(trigger()).toBeNull()
  })
})
