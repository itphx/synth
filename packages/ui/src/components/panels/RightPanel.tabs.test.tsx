import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

  // useAdaptiveIcons создаёт ResizeObserver — в jsdom его нет.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getSessionMemory: vi.fn(),
  getOptimization: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { RIGHT_TABS } from './RightPanel'
import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { RightPanel } from './RightPanel'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderRightPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <RightPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSessionMemory.mockResolvedValue({
    provider: { active: true },
    scope: { projectId: 'p1' },
    lastContext: null,
    facts: { active: 0 },
    indexes: { total: 0, project: 0, instance: 0, ready: 0, building: 0, failed: 0 },
    readiness: 'ready',
  })
  // Вкладка «Контекст» (дефолтная) тоже ходит в API.
  mocks.getOptimization.mockResolvedValue({
    context_optimization: 'none',
    sliding_window_mode: 'none',
    sliding_window_message_limit: 0,
    sliding_window_token_threshold: 0,
    summarization_enabled: false,
    summarization_trigger_mode: 'none',
    summarize_after_n: 0,
    summarize_token_threshold: 0,
    summarize_head_messages: 0,
    summarize_tail_messages: 0,
  })
  useUIStore.setState({
    rightPanelTab: 'context',
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useAuthStore.setState({ user: { id: 'u1', username: 'admin', roles: ['ADMIN'] } as never })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('RightPanel — порядок вкладок (ADR-071)', () => {
  it('первый ряд — «Сессия», «Проект», «Контекст», «Статистика»', () => {
    const ids = RIGHT_TABS.map((tab) => tab.id)
    expect(ids).toEqual([
      'params',
      'project',
      'context',
      'stats',
      'memory',
      'references',
      'scheduler',
    ])
    expect(ids.indexOf('params')).toBe(0)
    expect(ids.indexOf('project')).toBe(1)
    expect(ids.indexOf('context')).toBe(2)
    expect(ids.indexOf('stats')).toBe(3)
  })

  it('вкладка «Память» идёт сразу после «Статистики» (ADR-107)', () => {
    const ids = RIGHT_TABS.map((tab) => tab.id)
    expect(ids.indexOf('memory')).toBe(ids.indexOf('stats') + 1)
  })

  it('сетка вкладок: 4 в первом ряду, остальные — во втором', () => {
    // 7 вкладок без «Безопасности» (она только для ADMIN/AUDITOR).
    expect(RIGHT_TABS.slice(0, 4).length).toBe(4)
    expect(RIGHT_TABS.slice(4).length).toBe(3)
  })

  it('дефолтная вкладка правой панели — «Контекст»', () => {
    expect(useUIStore.getState().rightPanelTab).toBe('context')
  })

  it('кнопка «Память» есть в шапке и открывает вкладку', async () => {
    const container = await renderRightPanel()

    const memoryButton = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('title') === 'Memory',
    )
    expect(memoryButton).toBeDefined()

    await act(async () => {
      memoryButton!.click()
    })

    expect(useUIStore.getState().rightPanelTab).toBe('memory')
  })
})
