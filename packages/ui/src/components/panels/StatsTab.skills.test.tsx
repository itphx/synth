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
  getModels: vi.fn(),
  getProjectStats: vi.fn(),
  getSessionStats: vi.fn(),
  getSessionPrompt: vi.fn(),
  getSessionMcpEffective: vi.fn(),
  getSessionSkills: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { StatsTab } from './StatsTab'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useSkillsStore } from '@/stores/skillsStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const promptInfo = {
  manifest: {
    totalChars: 300,
    estTokens: 75,
    staticPrefixChars: 0,
    ratio: 4,
    entries: [
      { key: 'skills.catalog', label: 'Skills catalog', tier: 'stable', chars: 240, estTokens: 60, status: 'loaded', source: 'system' },
    ],
  },
  history: {
    messages: { count: 1, chars: 10, estTokens: 3 },
    stateMessages: [],
    excluded: { disabled: 0, hidden: 0, info: 0 },
    attachments: { count: 0, chars: 0 },
    secretPlaceholders: 0,
  },
  promptState: null,
  lastPromptMeta: null,
}

function skillsEffective() {
  return {
    session_id: 's1',
    skills: [
      {
        name: 'api-review', description: 'Review API', level: 'system', scope: 'instance',
        trusted: true, available: true, enabled: true, disabled: false,
      },
      {
        name: 'db-migration', description: 'Migrations', level: 'project', scope: 'project',
        trusted: false, available: false, unavailableReason: 'capabilities', enabled: false, disabled: true,
        disabledReason: 'session',
      },
    ],
    enabled: ['api-review'],
    disabled: ['db-migration'],
  }
}

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
  await act(async () => {})
  return container
}

function findSection(container: HTMLElement, title: string): HTMLElement | null {
  const h = [...container.querySelectorAll('h4')].find((el) => el.textContent === title)
  return (h?.parentElement as HTMLElement) ?? null
}

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
  vi.clearAllMocks()
  mocks.getModels.mockResolvedValue([])
  mocks.getProjectStats.mockResolvedValue(null)
  mocks.getSessionStats.mockResolvedValue(null)
  mocks.getSessionPrompt.mockResolvedValue(promptInfo)
  mocks.getSessionMcpEffective.mockResolvedValue({ servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [] })
  mocks.getSessionSkills.mockResolvedValue(skillsEffective())

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', title: 'S', settings: { model: 'm' }, input_tokens: 0, output_tokens: 0 }],
  } as never)
  useChatStore.setState({
    messagesBySession: { s1: [] },
    streamFinishTickBySession: {},
    streamingBySession: {},
    liveSubagentUsageBySession: {},
  })
  useAgentsStore.setState({ agents: [] })
  useSkillsStore.setState({
    commandInvocationCounts: {},
    skillInvocationCounts: {},
    lastCommandInvocation: null,
    lastSkillInvocation: null,
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
  vi.clearAllMocks()
})

describe('StatsTab — секция «Скиллы» (AD-046 §9.3)', () => {
  it('рендерит таблицу скиллов: scope/уровень, доступность, включение, trust, вклад', async () => {
    const container = await renderStats()
    const section = await expandSection(container, 'Skills')
    const text = section.textContent ?? ''
    expect(text).toContain('api-review')
    expect(text).toContain('instance')
    expect(text).toContain('system')
    expect(text).toContain('available')
    expect(text).toContain('trusted')
    expect(text).toContain('Skills catalog in prompt: ~60 tokens')

    const dbRow = container.querySelector('[data-testid="stats-skill-db-migration"]')!
    expect(dbRow.textContent).toContain('unavailable')
    expect(dbRow.textContent).toContain('capabilities')
    expect(dbRow.textContent).toContain('session opt-out')
    expect(dbRow.textContent).toContain('Untrusted')
  })

  it('токены скилла — оценка с ~ по ratio манифеста', async () => {
    const container = await renderStats()
    await expandSection(container, 'Skills')
    const row = container.querySelector('[data-testid="stats-skill-api-review"]')!
    // name(10) + description(10) = 20 / ratio 4 = 5
    expect(row.querySelector('td[title*="ratio 4"]')).not.toBeNull()
    expect(row.textContent).toContain('~5')
  })

  it('пустое состояние, если скиллов нет', async () => {
    mocks.getSessionSkills.mockResolvedValue({ session_id: 's1', skills: [], enabled: [], disabled: [] })
    const container = await renderStats()
    const section = findSection(container, 'Skills')!
    expect(section.textContent).toContain('No data')
  })

  it('перезапрашивает скиллы при инкременте streamFinishTick', async () => {
    await renderStats()
    const calls = mocks.getSessionSkills.mock.calls.length
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

    expect(mocks.getSessionSkills.mock.calls.length).toBe(calls + 1)
  })
})

describe('StatsTab — секция «Команды» (AD-046 §8.2)', () => {
  it('счётчики и последние вызовы из skillsStore', async () => {
    useSkillsStore.setState({
      commandInvocationCounts: { help: 3, summary: 1 },
      skillInvocationCounts: { 'api-review': 2 },
      lastCommandInvocation: { sessionId: 's1', command: 'help', actor: 'user' },
      lastSkillInvocation: { sessionId: 's1', name: 'api-review', source: 'model' },
    })
    const container = await renderStats()
    const section = await expandSection(container, 'Commands')
    const text = section.textContent ?? ''
    expect(text).toContain('Last command')
    expect(text).toContain('/help')
    expect(text).toContain('Last skill')
    expect(text).toContain('api-review')
    expect(text).toContain('model')

    const commandsCounters = container.querySelector('[data-testid="stats-command-invocations"]')!
    expect(commandsCounters.textContent).toContain('/help')
    expect(commandsCounters.textContent).toContain('3')
    expect(commandsCounters.textContent).toContain('/summary')

    const skillsCounters = container.querySelector('[data-testid="stats-skill-invocations"]')!
    expect(skillsCounters.textContent).toContain('api-review')
    expect(skillsCounters.textContent).toContain('2')
  })

  it('пустое состояние без вызовов', async () => {
    const container = await renderStats()
    const section = findSection(container, 'Commands')!
    expect(section.textContent).toContain('No commands or skills invoked yet')
  })
})
