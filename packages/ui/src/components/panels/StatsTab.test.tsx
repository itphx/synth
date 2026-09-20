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
  getSessionMcpEffective: vi.fn(),
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

/** AD-071 §2.6: таблицы инструментов/MCP свёрнуты — раскрываем через toggle. */
async function expandSection(container: HTMLElement, title: string): Promise<HTMLElement> {
  const section = findSection(container, title)
  expect(section).not.toBeNull()
  const toggle = section!.querySelector('button[aria-expanded]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  await act(async () => {
    toggle.click()
  })
  return section!
}

beforeEach(() => {
  mocks.getModels.mockResolvedValue([])
  mocks.getProjectStats.mockResolvedValue(null)
  mocks.getSessionStats.mockResolvedValue(null)
  mocks.getSessionPrompt.mockResolvedValue(promptInfo)
  mocks.getSessionMcpEffective.mockResolvedValue({
    servers: [],
    enabled: [],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })

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
  useChatStore.setState({
    messagesBySession: { s1: [] },
    streamFinishTickBySession: {},
    streamingBySession: {},
    liveSubagentUsageBySession: {},
  })
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

describe('StatsTab — таблицы инструментов и MCP (AD-071 §2.6)', () => {
  const toolsDetail = [
    { name: 'read_file', capabilities: ['file_read'], available: true, source: 'built-in' as const },
    { name: 'write_file', capabilities: ['file_write'], available: false, reason: 'mode' as const, source: 'built-in' as const },
    { name: 'git_commit', capabilities: ['git_write'], available: false, reason: 'role' as const, source: 'built-in' as const },
  ]

  function setPromptWithTools(toolsPolicy: 'consistency' | 'available'): void {
    mocks.getSessionPrompt.mockResolvedValue({
      ...promptInfo,
      manifest: { ...promptInfo.manifest, toolsPolicy },
      toolsDetail,
    })
  }

  it('рендерит таблицу «Встроенные инструменты»: имя, capability, доступность, источник', async () => {
    setPromptWithTools('consistency')
    const container = await renderStats()
    const section = await expandSection(container, 'Built-in tools')
    const text = section.textContent ?? ''
    expect(text).toContain('read_file')
    expect(text).toContain('file_read')
    expect(text).toContain('write_file')
    expect(text).toContain('available')
    expect(text).toContain('unavailable (mode)')
    expect(text).toContain('unavailable (role)')
    expect(text).toContain('built-in')
    expect(text).toContain('Source')
  })

  it('в режиме available недоступные инструменты помечены как скрытые', async () => {
    setPromptWithTools('available')
    const container = await renderStats()
    const section = await expandSection(container, 'Built-in tools')
    const text = section.textContent ?? ''
    expect(text).toContain('hidden')
    expect(text).not.toContain('unavailable (mode)')
  })

  it('пустое состояние «Встроенные инструменты»', async () => {
    const container = await renderStats()
    const section = findSection(container, 'Built-in tools')!
    expect(section.textContent).toContain('No data')
  })

  it('рендерит таблицу «MCP» со всеми серверами, включая отключённый с причиной', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue({
      servers: [
        {
          name: 'sys', level: 'system', enabled: true, connected: true, status: 'connected',
          origin: 'instance', trust: 'builtin', author: null, tools: ['echo', 'ping'],
        },
        {
          name: 'proj', level: 'project', enabled: false, reason: 'project_disabled', connected: false,
          status: 'disabled', origin: 'user', trust: 'community',
          author: { userId: 'u1', username: 'alice' }, tools: [],
        },
      ],
      enabled: ['sys'],
      disabled: ['proj'],
      mcpServers: [],
      mcpDisabledServers: [],
    })

    const container = await renderStats()
    const section = await expandSection(container, 'MCP')
    const text = section.textContent ?? ''
    // Активный сервер: уровень, статус, тулы.
    expect(text).toContain('sys')
    expect(text).toContain('system')
    expect(text).toContain('connected')
    expect(text).toContain('available')
    // Отключённый сервер не исчезает: причина и автор.
    expect(text).toContain('proj')
    expect(text).toContain('project')
    expect(text).toContain('disabled')
    expect(text).toContain('project disabled')
    expect(text).toContain('alice')
    // Список имён тулов в title.
    const toolsCell = container.querySelector('[data-testid="stats-mcp-sys"] td[title="echo, ping"]')
    expect(toolsCell).not.toBeNull()
  })

  it('таблицы «Встроенные инструменты» и «MCP» свёрнуты по умолчанию и раскрываются', async () => {
    setPromptWithTools('consistency')
    mocks.getSessionMcpEffective.mockResolvedValue({
      servers: [
        {
          name: 'sys', level: 'system', enabled: true, connected: true, status: 'connected',
          origin: 'instance', trust: 'builtin', author: null, tools: ['echo'],
        },
      ],
      enabled: ['sys'],
      disabled: [],
      mcpServers: [],
      mcpDisabledServers: [],
    })

    const container = await renderStats()
    const toolsSection = findSection(container, 'Built-in tools')!
    const mcpSection = findSection(container, 'MCP')!
    expect(toolsSection.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(mcpSection.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(toolsSection.textContent).not.toContain('read_file')
    expect(mcpSection.textContent).not.toContain('sys')

    await expandSection(container, 'Built-in tools')
    await expandSection(container, 'MCP')
    expect(findSection(container, 'Built-in tools')!.textContent).toContain('read_file')
    expect(findSection(container, 'MCP')!.textContent).toContain('sys')
  })

  it('колонка токенов: ~ при некалиброванном ratio, без ~ при калиброванном', async () => {
    mocks.getSessionPrompt.mockResolvedValue({
      ...promptInfo,
      manifest: { ...promptInfo.manifest, toolsPolicy: 'consistency' },
      toolsDetail: [
        { name: 'read_file', capabilities: ['file_read'], available: true, source: 'built-in' as const, chars: 326, estTokens: 82, ratio: 4 },
        { name: 'grep_files', capabilities: ['search'], available: true, source: 'built-in' as const, chars: 100, estTokens: 10, ratio: 2.5 },
      ],
    })
    const container = await renderStats()
    await expandSection(container, 'Built-in tools')

    const readRow = container.querySelector('[data-testid="stats-tool-read_file"]')!
    expect(readRow.textContent).toContain('~82')
    const grepRow = container.querySelector('[data-testid="stats-tool-grep_files"]')!
    expect(grepRow.textContent).toContain('10')
    expect(grepRow.textContent).not.toContain('~10')
  })

  it('admin-disabled тулы не показываются в таблице состава промпта', async () => {
    mocks.getSessionPrompt.mockResolvedValue({
      ...promptInfo,
      manifest: { ...promptInfo.manifest, toolsPolicy: 'consistency' },
      toolsDetail: [
        { name: 'read_file', capabilities: ['file_read'], available: true, source: 'built-in' as const },
        {
          name: 'git_status', capabilities: ['git_read'], available: false,
          reason: 'admin_disabled' as const, adminDisabled: true, source: 'built-in' as const,
        },
      ],
    })
    const container = await renderStats()
    const section = await expandSection(container, 'Built-in tools')
    expect(section.textContent).toContain('read_file')
    expect(section.textContent).not.toContain('git_status')
  })

  it('MCP: агрегат токенов по серверу и строки тулов при раскрытии', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue({
      servers: [
        {
          name: 'sys', level: 'system', enabled: true, connected: true, status: 'connected',
          origin: 'instance', trust: 'builtin', author: null, tools: ['echo'],
          chars: 100, estTokens: 25, ratio: 4,
          toolDetails: [{ name: 'echo', chars: 100, estTokens: 25, ratio: 4 }],
        },
      ],
      enabled: ['sys'],
      disabled: [],
      mcpServers: [],
      mcpDisabledServers: [],
    })

    const container = await renderStats()
    await expandSection(container, 'MCP')
    const serverRow = container.querySelector('[data-testid="stats-mcp-sys"]')!
    expect(serverRow.textContent).toContain('~25')
    const toolRow = container.querySelector('[data-testid="stats-mcp-tool-sys-echo"]')!
    expect(toolRow.textContent).toContain('echo')
    expect(toolRow.textContent).toContain('~25')
  })

  it('пустое состояние «MCP»', async () => {
    const container = await renderStats()
    const section = findSection(container, 'MCP')!
    expect(section.textContent).toContain('No data')
  })

  it('перезапрашивает MCP-скоуп при инкременте streamFinishTick', async () => {
    await renderStats()
    const calls = mocks.getSessionMcpEffective.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(1)

    await act(async () => {
      useChatStore.setState((s) => ({
        streamFinishTickBySession: {
          ...s.streamFinishTickBySession,
          s1: (s.streamFinishTickBySession['s1'] ?? 0) + 1,
        },
      }))
    })
    await act(async () => {})

    expect(mocks.getSessionMcpEffective.mock.calls.length).toBe(calls + 1)
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

describe('StatsTab — live-обновление (AD-070 §2.6)', () => {
  function makeStream(overrides: Record<string, unknown> = {}) {
    return {
      streamId: 'st1',
      agentRole: 'coder',
      content: 'partial',
      reasoningBlocks: [],
      intermediateTextBlocks: [],
      isStreaming: true,
      hasContent: true,
      model: 'live-model',
      provider: 'prov',
      usage: {
        input_tokens: 2000, output_tokens: 300, total_tokens: 2300,
        cache_read_tokens: 1000, cache_write_tokens: 20, reasoning_tokens: 10,
      },
      costUsd: 0.05,
      usageEstimated: false,
      toolCalls: [],
      toolIteration: 0,
      _lastContentLen: 0,
      ...overrides,
    }
  }

  function setActiveStream(
    sessionId = 's1',
    streamId = 'st1',
    overrides: Record<string, unknown> = {},
  ): void {
    useChatStore.setState({
      streamingBySession: { [sessionId]: { [streamId]: makeStream({ streamId, ...overrides }) } },
    } as never)
  }

  function setLiveSubagents(sessionId = 's1'): void {
    useChatStore.setState({
      liveSubagentUsageBySession: {
        [sessionId]: {
          usage: {
            input_tokens: 500, output_tokens: 50, total_tokens: 550,
            cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
          },
          costUsd: 0.002,
          estimated: false,
          byCall: {},
        },
      },
    } as never)
  }

  it('«Последний ответ» при активном стриме показывает live-значения и ~ при usageEstimated', async () => {
    useChatStore.setState({
      messagesBySession: {
        s1: [
          {
            id: 'm1', role: 'assistant', content: 'old', disabled: false, hidden: false,
            usage: { input_tokens: 100, output_tokens: 10 }, metadata: null,
          },
        ],
      },
    } as never)
    setActiveStream('s1', 'st1', {
      usageEstimated: true,
      usage: { input_tokens: 2000, output_tokens: 300, total_tokens: 2300 },
    })

    const container = await renderStats()
    const section = findSection(container, 'Last answer')!
    const text = section.textContent ?? ''
    expect(text).toContain(`~${(2000).toLocaleString()}`)
    expect(text).toContain('~300')
    expect(text).toContain('live-model')
    expect(text).toContain('live')
  })

  it('«Последний ответ» без оценки не добавляет ~ к live-токенам', async () => {
    setActiveStream('s1', 'st1', {
      usageEstimated: false,
      usage: { input_tokens: 2000, output_tokens: 300, total_tokens: 2300 },
    })
    const container = await renderStats()
    const section = findSection(container, 'Last answer')!
    expect(section.textContent).toContain((2000).toLocaleString())
    expect(section.textContent).not.toContain(`~${(2000).toLocaleString()}`)
  })

  it('секция «Сессия» = серверные значения + live активного стрима', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', title: 'S', settings: { model: 'm' }, input_tokens: 1000, output_tokens: 100 },
      ],
    } as never)
    setActiveStream('s1', 'st1', {
      usage: { input_tokens: 200, output_tokens: 20, total_tokens: 220 },
    })

    const container = await renderStats()
    const section = findSection(container, 'Session')!
    const text = section.textContent ?? ''
    expect(text).toContain((1200).toLocaleString()) // 1000 + 200
    expect(text).toContain('120') // 100 + 20
  })

  it('строка «Сабагенты» в «Сессии» растёт из liveSubagentUsageBySession и входит в итог', async () => {
    setLiveSubagents('s1')

    const container = await renderStats()
    const section = findSection(container, 'Session')!
    const text = section.textContent ?? ''
    expect(text).toContain('Subagents')
    expect(text).toContain('500')
    expect(text).toContain('50')
    expect(text).toContain('~$0.002')
    // Итог включает live-сабагентов (серверных токенов нет).
    expect(text).toContain('500')
  })

  it('дочерняя сессия показывает live из своего stream.usage без спец-условий', async () => {
    useUIStore.setState({
      activeCenterTabId: 'tab-1',
      centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Child', data: { sessionId: 'child' } }],
    })
    useSessionsStore.setState({
      sessions: [
        { id: 'child', title: 'Child', settings: { model: 'm' }, input_tokens: 0, output_tokens: 0 },
      ],
    } as never)
    useChatStore.setState({ messagesBySession: { child: [] } })
    setActiveStream('child', 'stc', {
      usage: { input_tokens: 400, output_tokens: 40, total_tokens: 440 },
    })

    const container = await renderStats()
    const section = findSection(container, 'Last answer')!
    expect(section.textContent).toContain('400')
  })

  it('после stream.done live сбрасывается — панель снова из серверных/сообщения', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', title: 'S', settings: { model: 'm' }, input_tokens: 1000, output_tokens: 100 },
      ],
    } as never)
    setActiveStream('s1', 'st1', {
      usage: { input_tokens: 9999, output_tokens: 999, total_tokens: 10998 },
    })
    setLiveSubagents('s1')

    const container = await renderStats()
    // 1000 (сервер) + 9999 (live-стрим) + 500 (live-сабагенты)
    expect(findSection(container, 'Session')!.textContent).toContain((11499).toLocaleString())

    await act(async () => {
      useChatStore.getState().finishStream('s1', 'st1', {
        content: 'final',
        usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
      })
    })
    await act(async () => {})

    const sessionSection = findSection(container, 'Session')!
    expect(sessionSection.textContent).not.toContain((11499).toLocaleString())
    expect(sessionSection.textContent).not.toContain('Subagents')
    expect(sessionSection.textContent).toContain((1000).toLocaleString())
    const lastSection = findSection(container, 'Last answer')
    if (lastSection) expect(lastSection.textContent).not.toContain(`~${(2000).toLocaleString()}`)
  })
})
