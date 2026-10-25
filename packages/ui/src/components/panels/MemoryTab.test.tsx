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
})

const mocks = vi.hoisted(() => ({
  getSessionMemory: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MemoryTab } from './MemoryTab'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Ответ `GET /sessions/:id/memory` по умолчанию (всё в порядке). */
function memoryPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: { active: true },
    scope: { projectId: 'p1' },
    lastContext: {
      facts: { chars: 1200, estTokens: 300, status: 'loaded' },
      recall: { chars: 400, estTokens: 100, status: 'truncated' },
    },
    facts: { active: 12 },
    indexes: { total: 5, project: 3, instance: 2, ready: 4, building: 1, failed: 0 },
    readiness: 'ready',
    ...overrides,
  }
}

async function renderMemory(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryTab />
      </I18nProvider>,
    )
  })
  // Дождаться резолва промисов из эффектов.
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSessionMemory.mockResolvedValue(memoryPayload())

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    settingsPage: 'appearance',
    isSettingsDialogOpen: false,
    settingsShowAdvanced: false,
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

describe('MemoryTab — статус и блоки последнего хода (ADR-107)', () => {
  it('рендерит статус (готовность, провайдер, проект) и блоки фактов/recall', async () => {
    const container = await renderMemory()
    const text = container.textContent ?? ''

    expect(mocks.getSessionMemory).toHaveBeenCalledWith('s1')

    // Статус: бейдж готовности, провайдер, проект.
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')?.textContent).toBe('Ready')
    expect(container.querySelector('[data-testid="memory-provider-badge"]')?.textContent).toBe('Active')
    expect(text).toContain('p1')

    // Блоки последнего хода: статус, символы и оценка токенов.
    const facts = container.querySelector('[data-testid="memory-block-facts"]')!
    expect(facts.textContent).toContain('loaded')
    expect(facts.textContent).toContain((1200).toLocaleString('en'))
    expect(facts.textContent).toContain('≈' + (300).toLocaleString('en'))
    expect(facts.textContent).toContain('Block passed in full')

    const recall = container.querySelector('[data-testid="memory-block-recall"]')!
    expect(recall.textContent).toContain('truncated')
    expect(recall.textContent).toContain('truncated by the context budget')
  })

  it('lastContext === null → «память ещё не участвовала в ходах», блоков нет', async () => {
    mocks.getSessionMemory.mockResolvedValue(memoryPayload({ lastContext: null }))

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-no-turns"]')?.textContent).toBe(
      'Memory has not taken part in turns yet',
    )
    expect(container.querySelector('[data-testid="memory-block-facts"]')).toBeNull()
  })

  it('recall отсутствует → «не передавался» + пояснение «не было вопроса в ходе»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        lastContext: {
          facts: { chars: 10, estTokens: 2, status: 'empty' },
        },
      }),
    )

    const container = await renderMemory()
    const recall = container.querySelector('[data-testid="memory-block-recall"]')!

    expect(recall.textContent).toContain('not passed')
    expect(recall.textContent).toContain('Recall is not passed when the turn has no question')

    // Пустой блок фактов — со своим пояснением.
    const facts = container.querySelector('[data-testid="memory-block-facts"]')!
    expect(facts.textContent).toContain('empty')
    expect(facts.textContent).toContain('No facts / nothing found')
  })

  it('скоуп: активные факты и счётчики индексов (total/project/instance/ready/building/failed)', async () => {
    const container = await renderMemory()
    const text = container.textContent ?? ''

    expect(text).toContain('Active facts')
    expect(text).toContain('12')
    expect(text).toContain('Indexes total')
    expect(text).toContain('Project indexes')
    expect(text).toContain('Instance indexes')
    expect(text).toContain('Ready')
    expect(text).toContain('Building')
    expect(text).toContain('Failed')
  })
})

describe('MemoryTab — подсказки и ошибки', () => {
  it('indexes.failed > 0 → подсказка «пересоберите индексы»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        indexes: { total: 5, project: 3, instance: 2, ready: 3, building: 1, failed: 1 },
      }),
    )

    const container = await renderMemory()

    expect(
      container.querySelector('[data-testid="memory-hint-failed-indexes"]')?.textContent,
    ).toBe('Some indexes failed — rebuild them')
  })

  it('provider.active === false → подсказка «плагин памяти не активен»', async () => {
    mocks.getSessionMemory.mockResolvedValue(
      memoryPayload({
        provider: { active: false },
        readiness: 'unavailable',
      }),
    )

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-provider-badge"]')?.textContent).toBe(
      'Inactive',
    )
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')?.textContent).toBe(
      'Unavailable',
    )
    expect(
      container.querySelector('[data-testid="memory-hint-provider-inactive"]')?.textContent,
    ).toBe('Memory plugin is not active')
  })

  it('ошибка API → баннер и кнопка «Повторить» перезапрашивают данные', async () => {
    mocks.getSessionMemory.mockRejectedValueOnce(new Error('boom'))

    const container = await renderMemory()

    const banner = container.querySelector('[data-testid="memory-error"]')
    expect(banner).not.toBeNull()
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.textContent).toContain('boom')

    mocks.getSessionMemory.mockResolvedValue(memoryPayload())
    const retry = container.querySelector('[data-testid="memory-retry"]') as HTMLButtonElement
    expect(retry).not.toBeNull()
    await act(async () => {
      retry.click()
    })
    await act(async () => {})

    expect(mocks.getSessionMemory.mock.calls.length).toBe(2)
    expect(container.querySelector('[data-testid="memory-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-readiness-badge"]')).not.toBeNull()
  })
})

describe('MemoryTab — доступ к настройкам памяти', () => {
  it('ADMIN видит кнопку «Настройки памяти» и открывает админ-раздел', async () => {
    const container = await renderMemory()

    const button = container.querySelector('[data-testid="memory-open-settings"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('Memory settings')

    await act(async () => {
      button.click()
    })

    expect(useUIStore.getState().settingsPage).toBe('memory')
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true)
    // Раздел «Память» скрыт в режиме «Расширенные» — кнопка включает его.
    expect(useUIStore.getState().settingsShowAdvanced).toBe(true)
  })

  it('USER кнопки не видит', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'user', roles: ['USER'] } as never })

    const container = await renderMemory()

    expect(container.querySelector('[data-testid="memory-open-settings"]')).toBeNull()
  })
})
