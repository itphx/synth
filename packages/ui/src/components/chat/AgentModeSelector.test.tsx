import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { AgentModeSelector } from './AgentModeSelector'
import { useAgentsStore } from '@/stores/agentsStore'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getAgents: vi.fn(),
    updateSession: vi.fn(),
  },
}))

// Примитив дропдауна заменяем сквозными элементами: тест проверяет логику
// селектора (какой агент и в каком формате уходит в API), а не поведение Radix.
vi.mock('@radix-ui/react-dropdown-menu', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return {
    Root: Passthrough,
    Trigger: Passthrough,
    Portal: Passthrough,
    Content: Passthrough,
    Separator: () => ReactMod.createElement('hr'),
    Item: ({ children, disabled, onClick }: { children?: React.ReactNode; disabled?: boolean; onClick?: () => void }) =>
      ReactMod.createElement('button', { type: 'button', disabled, onClick }, children),
  }
})

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

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
}

async function renderSelector(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentModeSelector sessionId="s1" />
      </I18nProvider>,
    )
  })
  return container
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: AGENTS, default_agent: 'developer' })
  vi.mocked(synthApi.updateSession).mockResolvedValue({} as never)
  useAgentsStore.setState({ agents: AGENTS, activeAgentId: 'developer', defaultAgentId: 'developer', loading: false })
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

describe('AgentModeSelector', () => {
  it('выбор агента сохраняет его в сессию как settings.agentRole (camelCase)', async () => {
    const container = await renderSelector()

    const item = findButton(container, 'Алистент')
    expect(item).toBeDefined()
    await clickButton(item!)

    expect(synthApi.updateSession).toHaveBeenCalledTimes(1)
    expect(synthApi.updateSession).toHaveBeenCalledWith('s1', { settings: { agentRole: 'alistent' } })
    // snake_case не должен попадать в настройки сессии
    expect(JSON.stringify(vi.mocked(synthApi.updateSession).mock.calls)).not.toContain('agent_role')
    expect(useAgentsStore.getState().activeAgentId).toBe('alistent')
  })

  it('«сбросить на умолчание» использует defaultAgentId из стора, а не хардкод', async () => {
    useAgentsStore.setState({ activeAgentId: 'alistent' })
    const container = await renderSelector()

    const reset = findButton(container, 'Сбросить на умолчание')
    expect(reset).toBeDefined()
    await clickButton(reset!)

    expect(synthApi.updateSession).toHaveBeenCalledWith('s1', { settings: { agentRole: 'developer' } })
    expect(useAgentsStore.getState().activeAgentId).toBe('developer')
  })
})
