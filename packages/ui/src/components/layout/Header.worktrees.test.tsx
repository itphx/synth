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

const mocks = vi.hoisted(() => ({
  deviceType: 'desktop' as 'desktop' | 'phone' | 'tablet',
  notify: vi.fn(),
  confirm: vi.fn(),
  getSessionMessages: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: mocks.deviceType, isTouch: false }),
}))
// Тяжёлые соседи шапки — заглушки: тест про индикатор worktree'а.
vi.mock('../auth/QuickSettingsPopup', () => ({ QuickSettingsPopup: () => null }))
vi.mock('./AnalyticsButton', () => ({ AnalyticsButton: () => null }))
vi.mock('./NotificationPopup', () => ({ NotificationPopup: () => null }))
vi.mock('./GlobalTransportIndicator', () => ({ GlobalTransportIndicator: () => null }))
vi.mock('./HybridStatusIndicator', () => ({ HybridStatusIndicator: () => null }))
vi.mock('./PwaInstallButton', () => ({ PwaInstallButton: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { Header } from './Header'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useWorktreesStore } from '@/stores/worktreesStore'
import type { WorktreeSummary } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const WORKTREE: WorktreeSummary = {
  id: 'wkt_1',
  projectId: 'p1',
  directory: '/ws/.worktrees/p1/feature-x',
  branch: 'feature/x',
  name: 'feature-x',
  strategy: 'git',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as WorktreeSummary

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

/** Сессия с привязкой к worktree'у. */
function sessionWithWorktree(worktreeId: string | null, directory = '/ws/.worktrees/p1/feature-x') {
  return {
    id: 's1',
    name: 'S',
    project_id: 'p1',
    settings: { model: 'm' },
    worktree: worktreeId
      ? {
          worktree_id: worktreeId,
          project_id: 'p1',
          repo_path: null,
          directory,
          branch: 'feature/x',
        }
      : null,
  }
}

beforeEach(() => {
  mocks.deviceType = 'desktop'
  mocks.confirm.mockResolvedValue(true)
  mocks.getSessionMessages.mockResolvedValue({ messages: [] })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    rightPanelTab: 'context',
    mobileRightOpen: false,
  })
  useSessionsStore.setState({ sessions: [sessionWithWorktree('wkt_1')] } as never)
  useProjectsStore.setState({ projects: [{ id: 'p1', name: 'P' }] } as never)
  useProvidersStore.setState({ models: [], selectedModelName: null } as never)
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } } as never)
  useWorktreesStore.setState({ byProject: { p1: [WORKTREE] }, loadingByProject: {}, error: null })
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

describe('Header — индикатор worktree' + "'а (ADR-114 §9)", () => {
  it('показывает «worktree: <имя> · <ветка>» из инвентаря проекта', async () => {
    const container = await renderHeader()

    const indicator = container.querySelector('[data-testid="header-worktree-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator!.textContent).toContain('worktree: feature-x · feature/x')
  })

  it('без привязки индикатора нет', async () => {
    useSessionsStore.setState({ sessions: [sessionWithWorktree(null)] } as never)

    const container = await renderHeader()

    expect(container.querySelector('[data-testid="header-worktree-indicator"]')).toBeNull()
  })

  it('имя worktree' + "'а не найдено в инвентаре — фолбэк на имя каталога", async () => {
    useWorktreesStore.setState({ byProject: {}, loadingByProject: {}, error: null })
    useSessionsStore.setState({
      sessions: [sessionWithWorktree('wkt_unknown', '/ws/.worktrees/p1/from-disk')],
    } as never)

    const container = await renderHeader()

    const indicator = container.querySelector('[data-testid="header-worktree-indicator"]')!
    expect(indicator.textContent).toContain('worktree: from-disk · feature/x')
  })

  it('клик на десктопе открывает вкладку «Проект» правой панели', async () => {
    const container = await renderHeader()

    const indicator = container.querySelector('[data-testid="header-worktree-indicator"]') as HTMLElement
    await act(async () => {
      indicator.click()
    })

    expect(useUIStore.getState().rightPanelTab).toBe('project')
    expect(useUIStore.getState().mobileRightOpen).toBe(false)
  })

  it('клик на мобильном открывает правую панель и вкладку «Проект»', async () => {
    mocks.deviceType = 'phone'
    const container = await renderHeader()

    const indicator = container.querySelector('[data-testid="header-worktree-indicator"]') as HTMLElement
    expect(indicator).toBeTruthy()
    await act(async () => {
      indicator.click()
    })

    expect(useUIStore.getState().rightPanelTab).toBe('project')
    expect(useUIStore.getState().mobileRightOpen).toBe(true)
  })
})
