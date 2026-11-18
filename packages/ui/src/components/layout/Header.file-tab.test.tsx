import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: vi.fn() }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: 'desktop', isTouch: false }),
}))
vi.mock('../auth/QuickSettingsPopup', () => ({ QuickSettingsPopup: () => null }))
vi.mock('./AnalyticsButton', () => ({ AnalyticsButton: () => null }))
vi.mock('./NotificationPopup', () => ({ NotificationPopup: () => null }))
vi.mock('./GlobalTransportIndicator', () => ({ GlobalTransportIndicator: () => null }))
vi.mock('./HybridStatusIndicator', () => ({ HybridStatusIndicator: () => null }))
vi.mock('./PwaInstallButton', () => ({ PwaInstallButton: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Header } from './Header'
import { useUIStore } from '@/stores/useUIStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import type { CenterTab } from '@/stores/useUIStore'

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

const PROJECT = {
  id: 'p1',
  name: 'MyProject',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

function fileTab(type: 'file-viewer' | 'file-editor'): CenterTab {
  return {
    id: `${type}-p1/docs/a.ts`,
    type,
    title: 'a.ts',
    data: { projectId: 'p1', filePath: 'docs/a.ts' },
  }
}

beforeEach(() => {
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null, rightPanelTab: 'context' })
  useProjectsStore.setState({ projects: [PROJECT] } as never)
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } } as never)
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('Header — файловые вкладки', () => {
  it.each(['file-viewer', 'file-editor'] as const)(
    '%s: есть имя проекта и путь, нет кнопок файла',
    async (type) => {
      const tab = fileTab(type)
      useUIStore.setState({ centerTabs: [tab], activeCenterTabId: tab.id })

      const container = await renderHeader()

      expect(container.textContent).toContain('MyProject')
      expect(container.querySelector('[data-testid="header-file-path"]')?.textContent).toBe(
        'docs/a.ts',
      )
      // Действия файла переехали в панель вкладки — в шапке их нет.
      expect(container.querySelector('[title="Edit"]')).toBeNull()
      expect(container.querySelector('[title="Download"]')).toBeNull()
      expect(container.querySelector('[title="Save"]')).toBeNull()
      expect(container.querySelector('[title="Close"]')).toBeNull()
    },
  )
})
