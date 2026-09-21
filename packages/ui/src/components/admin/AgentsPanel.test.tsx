import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getAllAgents: vi.fn(),
  getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
  getModels: vi.fn(async () => []),
  fetchJSON: vi.fn(async () => ({ files: [] })),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AgentsPanel } from './AgentsPanel'
import type { AgentInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (id: string, mode: AgentInfo['agent_mode']): AgentInfo => ({
  id,
  display_name: id,
  capabilities: [],
  enabled: true,
  icon: null,
  color: null,
  description: null,
  available: true,
  mode: 'simple',
  agent_mode: mode,
  reasoning_level: null,
  subagent_prompt: null,
  max_steps: 0,
  provider: null,
  model: null,
  context_file: null,
  is_builtin: false,
  is_overridden: false,
})

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentsPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('AgentsPanel — фильтр на Kit Tabs (AD-072)', () => {
  beforeEach(() => {
    apiMock.getAllAgents.mockResolvedValue({
      agents: [agent('main', ['primary']), agent('sub', ['subagent'])],
      default_agent: null,
    })
  })

  it('рендерит tablist в теле и оставляет «Add» в шапке', async () => {
    const container = await renderPanel()

    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist).not.toBeNull()
    expect(tablist!.getAttribute('aria-label')).toBe('Agents')
    expect(tablist!.closest('[data-testid="settings-header-meta"]')).toBeNull()

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs).toHaveLength(4)
    expect(Array.from(tabs).map((t) => t.textContent)).toEqual(['All', 'Agents', 'Subagents', 'System'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')

    const addButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add')
    expect(addButton).toBeDefined()
  })

  it('клик по вкладке Subagents фильтрует список', async () => {
    const container = await renderPanel()
    expect(container.textContent).toContain('main')
    expect(container.textContent).toContain('sub')

    const subagentsTab = container.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    await act(async () => {
      subagentsTab.click()
    })
    await act(async () => {})

    expect(container.textContent).toContain('sub')
    expect(container.textContent).not.toContain('main')
  })

  it('без сабагентов/системных переключатель не показывается', async () => {
    apiMock.getAllAgents.mockResolvedValue({
      agents: [agent('main', ['primary'])],
      default_agent: null,
    })
    const container = await renderPanel()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })
})
