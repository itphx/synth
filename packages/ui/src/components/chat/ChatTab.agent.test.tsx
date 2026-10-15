import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatTab } from './ChatTab'
import { useAgentsStore } from '@/stores/agentsStore'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
import type { CenterTab } from '@/stores/useUIStore'

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getSessionMessages: vi.fn(),
      getAgents: vi.fn(),
      getSession: vi.fn(),
    },
  }
})

// Тяжёлый композер не нужен: проверяем эффект восстановления агента в ChatTab.
vi.mock('./ChatInput', () => ({ ChatInput: () => null }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function makeAgent(id: string, display_name: string): AgentInfo {
  return {
    id,
    display_name,
    capabilities: [],
    enabled: true,
    icon: null,
    color: null,
    description: null,
    available: true,
    mode: 'simple',
    agent_mode: null,
    subagent_prompt: null,
    max_steps: null,
    provider: null,
    model: null,
    context_file: null,
    is_builtin: true,
    is_overridden: false,
  }
}

const AGENTS: AgentInfo[] = [
  makeAgent('developer', 'Разработчик'),
  makeAgent('alistent', 'Алистент'),
]

const TAB: CenterTab = {
  id: 'chat-s1',
  type: 'chat',
  title: 'Сессия',
  data: { sessionId: 's1' },
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  useAgentsStore.setState({ agents: AGENTS, activeAgentId: 'developer', defaultAgentId: 'developer', loading: false })
  vi.mocked(synthApi.getSessionMessages).mockResolvedValue({ messages: [], session_id: 's1' })
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: 's1',
    settings: { agentRole: 'alistent' },
    session_origin: null,
    pending_messages: [],
    sticky_notes: [],
  } as never)
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

describe('ChatTab: восстановление агента из настроек сессии', () => {
  it('выставляет activeAgentId из session.settings.agentRole (camelCase)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })

    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatTab tab={TAB} />
        </I18nProvider>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(useAgentsStore.getState().activeAgentId).toBe('alistent')
  })
})
