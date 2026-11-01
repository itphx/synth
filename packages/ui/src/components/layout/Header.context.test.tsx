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

const mocks = vi.hoisted(() => ({
  deviceType: 'desktop' as 'desktop' | 'phone' | 'tablet',
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ deviceType: mocks.deviceType, isTouch: false }),
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
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useChatStore } from '@/stores/chatStore'

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

function assistantMessage(id: string, inputTokens: number) {
  return {
    id,
    role: 'assistant',
    content: 'x',
    created_at: '2026-11-01T17:00:00.000Z',
    usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
  }
}

beforeEach(() => {
  mocks.deviceType = 'desktop'
  mocks.confirm.mockResolvedValue(true)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    rightPanelTab: 'context',
    mobileRightOpen: false,
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'mm' } }],
  } as never)
  useProjectsStore.setState({ projects: [] } as never)
  useProvidersStore.setState({
    models: [{ id: 'mm', name: 'mm', context_window: 200_000 }],
    selectedModelName: null,
  } as never)
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } } as never)
  useChatStore.setState({ messagesBySession: { s1: [] } } as never)
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

describe('Header — индикатор контекстного окна', () => {
  it('показывает процент от окна модели по usage последнего ответа', async () => {
    useChatStore.setState({
      messagesBySession: { s1: [assistantMessage('m1', 195_593)] },
    } as never)

    const container = await renderHeader()
    expect(container.textContent).toContain('98%')
  })

  it('не сбрасывается в 0, если последнее assistant-сообщение без usage', async () => {
    useChatStore.setState({
      messagesBySession: {
        s1: [
          assistantMessage('m1', 195_593),
          { id: 'm2', role: 'assistant', content: '', created_at: '2026-11-01T17:10:00.000Z' },
        ],
      },
    } as never)

    const container = await renderHeader()
    expect(container.textContent).toContain('98%')
  })

  it('title — «токены / окно (процент)»', async () => {
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 195_593)] } } as never)
    const container = await renderHeader()
    const meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter).not.toBeNull()
    const title = meter.getAttribute('title') ?? ''
    expect(title).toContain('/')
    expect(title).toContain('(98%)')
    // Модель с окном — без пометки об оценке.
    expect(title).not.toContain('≈')
  })

  it('title помечает оценку окна, если у модели нет context_window', async () => {
    useProvidersStore.setState({
      models: [{ id: 'mm', name: 'mm' }],
      selectedModelName: null,
    } as never)
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 195_593)] } } as never)
    const container = await renderHeader()
    const meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter.getAttribute('title')).toContain('≈')
  })

  it('цвет индикатора по уровню: зелёный (ok) при малом проценте', async () => {
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 40_000)] } } as never)
    const container = await renderHeader()
    const meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter.dataset.level).toBe('ok')
    expect(meter.textContent).toContain('20%')
    expect(meter.innerHTML).toContain('bg-status-success')
    expect(meter.innerHTML).toContain('text-status-success')
  })

  it('цвет индикатора по уровню: оранжевый (warning) при 75–89%', async () => {
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 150_000)] } } as never)
    const container = await renderHeader()
    const meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter.dataset.level).toBe('warning')
    expect(meter.textContent).toContain('75%')
    expect(meter.innerHTML).toContain('bg-status-caution')
  })

  it('цвет индикатора по уровню: жёлтый (notice) при 50–74% и красный (critical) при ≥90%', async () => {
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 120_000)] } } as never)
    const container = await renderHeader()
    let meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter.dataset.level).toBe('notice')
    expect(meter.innerHTML).toContain('bg-status-notice')

    // Перерисовка того же Header с новыми сообщениями — без перемонтирования.
    useChatStore.setState({ messagesBySession: { s1: [assistantMessage('m1', 195_593)] } } as never)
    await act(async () => {})
    meter = container.querySelector('[data-testid="header-context"]') as HTMLElement
    expect(meter.dataset.level).toBe('critical')
    expect(meter.innerHTML).toContain('bg-destructive')
  })
})
