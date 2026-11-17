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
  getSchedules: vi.fn(),
  listTimers: vi.fn(),
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
  // Вкладка «Автоматизация» (PROP-141, этап 7b) тоже ходит в API.
  mocks.getSchedules.mockResolvedValue({ schedules: [] })
  mocks.listTimers.mockResolvedValue({
    timers: [],
    total: 0,
    offset: 0,
    limit: 50,
    next_offset: null,
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
      'automation',
      'processes',
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

  it('вкладка «Процессы» идёт рядом с «Автоматизацией» (PROP-096/097)', () => {
    const ids = RIGHT_TABS.map((tab) => tab.id)
    expect(ids.indexOf('processes')).toBe(ids.indexOf('automation') + 1)
  })

  it('сетка вкладок: 4 в первом ряду, остальные — во втором', () => {
    // 8 вкладок без «Безопасности» (она только для ADMIN/AUDITOR).
    expect(RIGHT_TABS.slice(0, 4).length).toBe(4)
    expect(RIGHT_TABS.slice(4).length).toBe(4)
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

  it('вкладка «Автоматизация» открывается и рендерит свои секции', async () => {
    useUIStore.setState({ rightPanelTab: 'automation' })
    const container = await renderRightPanel()

    // Ленивый импорт вкладки — дожидаемся появления секции.
    // `vi.waitFor` внутри `act` блокирует разрешение промиса ленивого чанка
    // (act держит очередь обновлений), поэтому ждём снаружи.
    await vi.waitFor(
      () => {
        expect(
          container.querySelector('[data-testid="automation-section-schedule"]'),
        ).not.toBeNull()
      },
      { timeout: 5000, interval: 10 },
    )

    expect(container.querySelector('[data-testid="automation-section-timer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="automation-section-alarm"]')).not.toBeNull()
  })
})

describe('RightPanel — выделенный проект (сессии нет)', () => {
  const tabButton = (container: HTMLElement, id: string): HTMLButtonElement =>
    container.querySelector(`[data-tab-id="${id}"]`) as HTMLButtonElement

  it('сессионные вкладки недоступны, проектные — доступны', async () => {
    useUIStore.setState({ selectedProjectId: 'p1' })
    const container = await renderRightPanel()

    for (const id of ['params', 'context', 'stats', 'memory', 'references', 'secrets']) {
      const button = tabButton(container, id)
      expect(button, `вкладка ${id}`).toBeTruthy()
      expect(button.disabled, `вкладка ${id} должна быть недоступна`).toBe(true)
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(button.getAttribute('title')).toBe(enDict['rightPanel.tab.requiresSession'])
    }

    for (const id of ['project', 'automation', 'processes']) {
      const button = tabButton(container, id)
      expect(button, `вкладка ${id}`).toBeTruthy()
      expect(button.disabled, `вкладка ${id} должна быть доступна`).toBe(false)
      expect(button.getAttribute('aria-disabled')).toBeNull()
      expect(button.getAttribute('title')).not.toBe(enDict['rightPanel.tab.requiresSession'])
    }
  })

  it('активная сессионная вкладка переключается на «Проект»', async () => {
    useUIStore.setState({ rightPanelTab: 'context', selectedProjectId: 'p1' })
    await renderRightPanel()

    expect(useUIStore.getState().rightPanelTab).toBe('project')
  })

  it('сессионная вкладка не переключается кликом (нужна сессия)', async () => {
    useUIStore.setState({ rightPanelTab: 'project', selectedProjectId: 'p1' })
    const container = await renderRightPanel()

    const sessionButton = tabButton(container, 'params')
    await act(async () => {
      sessionButton.click()
    })

    expect(useUIStore.getState().rightPanelTab).toBe('project')
  })

  it('без выделенного проекта поведение вкладок прежнее', async () => {
    useUIStore.setState({ rightPanelTab: 'context', selectedProjectId: null })
    const container = await renderRightPanel()

    expect(useUIStore.getState().rightPanelTab).toBe('context')
    const sessionButton = tabButton(container, 'params')
    expect(sessionButton.disabled).toBe(false)
    expect(sessionButton.getAttribute('aria-disabled')).toBeNull()
    expect(sessionButton.getAttribute('title')).toBe(enDict['rightPanel.tab.session'])
  })
})
