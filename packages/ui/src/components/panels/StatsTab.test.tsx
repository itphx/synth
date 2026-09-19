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
  getModels: vi.fn(),
  getProjectStats: vi.fn(),
  getSessionStats: vi.fn(),
  getSessionPrompt: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { StatsTab } from './StatsTab'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const promptInfo = {
  manifest: { totalChars: 100, estTokens: 25, staticPrefixChars: 40, entries: [] },
  history: {
    messages: { count: 7, chars: 1234, estTokens: 309 },
    stateMessages: [
      { type: 'mode_change', count: 2, chars: 300, estTokens: 75 },
      { type: 'plan_updated', count: 1, chars: 120, estTokens: 30 },
    ],
    excluded: { disabled: 1, hidden: 2, info: 3 },
    attachments: { count: 4, chars: 500 },
    secretPlaceholders: 5,
  },
  promptState: null,
  lastPromptMeta: null,
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderStats(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StatsTab />
      </I18nProvider>,
    )
  })
  // Дождаться резолва промисов из эффектов.
  await act(async () => {})
  return container
}

function findSection(container: HTMLElement, title: string): HTMLElement | null {
  const h = [...container.querySelectorAll('h4')].find((el) => el.textContent === title)
  return (h?.parentElement as HTMLElement) ?? null
}

beforeEach(() => {
  mocks.getModels.mockResolvedValue([])
  mocks.getProjectStats.mockResolvedValue(null)
  mocks.getSessionStats.mockResolvedValue(null)
  mocks.getSessionPrompt.mockResolvedValue(promptInfo)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        title: 'S',
        settings: { model: 'm' },
        input_tokens: 0,
        output_tokens: 0,
      },
    ],
  } as never)
  useChatStore.setState({ messagesBySession: { s1: [] }, streamFinishTickBySession: {} })
  useAgentsStore.setState({ agents: [] })
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

describe('StatsTab — секция «История» (AD-070 §2.5)', () => {
  it('по умолчанию свёрнута: показана сводка, таблицы state-сообщений нет', async () => {
    const container = await renderStats()
    const text = container.textContent ?? ''

    expect(text).toContain('History')
    expect(text).toContain('Messages')
    expect(text).toContain('7')
    expect(text).toContain((1234).toLocaleString())
    expect(text).toContain('~309')

    // Таблица state-сообщений и детали скрыты.
    expect(text).not.toContain('mode_change')
    expect(text).not.toContain('Excluded')
    expect(text).not.toContain('Attachments')

    const section = findSection(container, 'History')
    expect(section).not.toBeNull()
    const toggle = section!.querySelector('button[aria-expanded]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
  })

  it('раскрывается и показывает state-сообщения, исключённые, вложения и секреты', async () => {
    const container = await renderStats()
    const section = findSection(container, 'History')!
    const toggle = section.querySelector('button[aria-expanded]') as HTMLButtonElement

    await act(async () => {
      toggle.click()
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const text = container.textContent ?? ''
    expect(text).toContain('mode_change')
    expect(text).toContain('plan_updated')
    expect(text).toContain('Type')
    expect(text).toContain('Count')

    expect(text).toContain('Excluded')
    expect(text).toContain('disabled 1')
    expect(text).toContain('hidden 2')
    expect(text).toContain('info 3')

    expect(text).toContain('Attachments')
    expect(text).toContain('4 / 500')
    expect(text).toContain('Secrets')
    expect(text).toContain('5')
  })
})

describe('StatsTab — блок «Сабагенты» в «Последнем ответе» (AD-070 §2.6)', () => {
  const subagentBreakdown = {
    sessions: 1, input_tokens: 300, output_tokens: 30,
    cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0.00036,
  }

  function setLastAssistant(metadata?: Record<string, unknown>): void {
    useChatStore.setState({
      messagesBySession: {
        s1: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'ok',
            disabled: false,
            hidden: false,
            usage: { input_tokens: 100, output_tokens: 10 },
            metadata: metadata ?? null,
          },
        ],
      },
    } as never)
  }

  it('показывает блок сабагентов из последнего сообщения (сессии/токены/стоимость) и подпись', async () => {
    mocks.getSessionStats.mockResolvedValue({
      session_id: 's1',
      agents: [],
      users: [],
      subagents: subagentBreakdown,
    })
    setLastAssistant({ subagents: subagentBreakdown })

    const container = await renderStats()

    const section = findSection(container, 'Last answer')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('Subagents')
    expect(section!.textContent).toContain('Sessions')
    expect(section!.textContent).toContain('300')
    expect(section!.textContent).toContain('Separate from the answer — not counted in the context window')
  })

  it('usage_estimated → префикс ~ у входных/выходных токенов последнего ответа', async () => {
    setLastAssistant({ usage_estimated: true })
    const container = await renderStats()
    const section = findSection(container, 'Last answer')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('~100')
    expect(section!.textContent).toContain('~10')
  })

  it('без usage_estimated токены последнего ответа без ~', async () => {
    setLastAssistant({})
    const container = await renderStats()
    const section = findSection(container, 'Last answer')!
    expect(section.textContent).not.toContain('~100')
  })

  it('перезапрашивает статистику при инкременте streamFinishTick', async () => {
    const container = await renderStats()

    const promptCalls = mocks.getSessionPrompt.mock.calls.length
    const statsCalls = mocks.getSessionStats.mock.calls.length
    expect(promptCalls).toBeGreaterThanOrEqual(1)
    expect(statsCalls).toBeGreaterThanOrEqual(1)

    // Симуляция завершения стрима: finishStream/cancelStream увеличивают тик,
    // не меняя id assistant-сообщения.
    await act(async () => {
      useChatStore.setState((s) => ({
        streamFinishTickBySession: {
          ...s.streamFinishTickBySession,
          s1: (s.streamFinishTickBySession['s1'] ?? 0) + 1,
        },
      }))
    })
    await act(async () => {})

    expect(mocks.getSessionPrompt.mock.calls.length).toBe(promptCalls + 1)
    expect(mocks.getSessionStats.mock.calls.length).toBe(statsCalls + 1)
    expect(container.textContent).toContain('History')
  })

  it('перезапрашивает project stats при инкременте streamFinishTick', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'S',
          project_id: 'p1',
          settings: { model: 'm' },
          input_tokens: 0,
          output_tokens: 0,
        },
      ],
    } as never)

    await renderStats()

    const projectCalls = mocks.getProjectStats.mock.calls.length
    expect(projectCalls).toBeGreaterThanOrEqual(1)
    expect(mocks.getProjectStats).toHaveBeenLastCalledWith('p1')

    await act(async () => {
      useChatStore.setState((s) => ({
        streamFinishTickBySession: {
          ...s.streamFinishTickBySession,
          s1: (s.streamFinishTickBySession['s1'] ?? 0) + 1,
        },
      }))
    })
    await act(async () => {})

    expect(mocks.getProjectStats.mock.calls.length).toBe(projectCalls + 1)
    expect(mocks.getProjectStats).toHaveBeenLastCalledWith('p1')
  })

  it('скрывает блок, если у последнего ответа нет сабагентов (даже при ненулевой сессионной сводке)', async () => {
    // Регрессия: раньше блок брался из sessionStats.subagents и висел после
    // ответов без сабагентов.
    mocks.getSessionStats.mockResolvedValue({
      session_id: 's1',
      agents: [],
      users: [],
      subagents: subagentBreakdown,
    })
    setLastAssistant()

    const container = await renderStats()
    const section = findSection(container, 'Last answer')!
    expect(section.textContent).not.toContain('Subagents')
    expect(section.textContent).not.toContain('Separate from the answer')
  })

  it('секция «Сессия» суммирует activeSession и sessionStats.subagents', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'S',
          settings: { model: 'm' },
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_tokens: 500,
          cache_write_tokens: 50,
          reasoning_tokens: 20,
        },
      ],
    } as never)
    mocks.getSessionStats.mockResolvedValue({
      session_id: 's1',
      agents: [],
      users: [],
      subagents: {
        sessions: 1, input_tokens: 300, output_tokens: 30,
        cache_read_tokens: 100, cache_write_tokens: 5, reasoning_tokens: 7, cost_usd: 0.001,
      },
    })
    setLastAssistant()

    const container = await renderStats()
    const section = findSection(container, 'Session')!
    const text = section.textContent ?? ''
    expect(text).toContain((1300).toLocaleString()) // input 1000 + 300
    expect(text).toContain('130') // output 100 + 30
    expect(text).toContain('600') // cache read 500 + 100
    expect(text).toContain('55') // cache write 50 + 5
    expect(text).toContain('27') // reasoning 20 + 7
    expect(text).toContain('46%') // 600 / 1300
    expect(text).toContain('incl. subagents')
  })
})
