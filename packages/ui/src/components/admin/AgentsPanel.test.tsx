import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getAllAgents: vi.fn(),
  getAgents: vi.fn(),
  getProviders: vi.fn(async () => ({ providers: [], default_provider: '' })),
  getModels: vi.fn(async () => []),
  getContextFiles: vi.fn(async () => ({ files: [] })),
  getAgentDetail: vi.fn(async () => ({})),
  saveAgent: vi.fn(async () => ({})),
  toggleAgent: vi.fn(async () => undefined),
  deleteAgent: vi.fn(async () => undefined),
  getDefaultAgentInfo: vi.fn(async () => ({ defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant' })),
  setDefaultAgent: vi.fn(async (id: string) => ({ defaultAgent: id })),
  resetDefaultAgent: vi.fn(async () => ({ status: 'restored', defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant' })),
  listSshKeys: vi.fn(async () => []),
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

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const allOptions = [...document.body.querySelectorAll('[role="option"]')]
  const option = allOptions.find((o) => o.textContent?.trim().startsWith(label)) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
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

describe('AgentsPanel — агент по умолчанию (AD-072)', () => {
  const AGENTS = [
    agent('main', ['primary']),
    agent('other', ['primary']),
    agent('sub', ['subagent']),
  ]

  beforeEach(() => {
    apiMock.getAllAgents.mockResolvedValue({ agents: AGENTS, default_agent: null })
    apiMock.getAgents.mockResolvedValue({ agents: AGENTS, default_agent: 'main' })
    apiMock.setDefaultAgent.mockResolvedValue({ defaultAgent: 'other' })
    apiMock.resetDefaultAgent.mockResolvedValue({
      status: 'restored', defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant',
    })
    // Переопределено: текущий 'main', дефолт 'assistant' → Reset активен.
    apiMock.getDefaultAgentInfo.mockResolvedValue({
      defaultAgent: 'main', isOverridden: true, defaults: 'assistant',
    })
  })

  it('рендерит контрол; без изменений Save/Cancel неактивны', async () => {
    const container = await renderPanel()

    expect(container.textContent).toContain('Default agent')
    expect(container.querySelector('[role="combobox"]')).not.toBeNull()

    const save = container.querySelector('[data-testid="default-agent-save"]') as HTMLButtonElement
    const cancel = container.querySelector('[data-testid="default-agent-cancel"]') as HTMLButtonElement
    expect(save).not.toBeNull()
    expect(cancel).not.toBeNull()
    expect(save.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
  })

  it('выбор агента + Save вызывает setDefaultAgent(id) и обновляет список', async () => {
    const container = await renderPanel()

    const trigger = container.querySelector('[role="combobox"]') as HTMLElement
    await selectOption(trigger, 'other')

    const save = container.querySelector('[data-testid="default-agent-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)

    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(apiMock.setDefaultAgent).toHaveBeenCalledWith('other')
    expect(apiMock.getAgents).toHaveBeenCalled()
  })

  it('Reset вызывает resetDefaultAgent(), когда значение переопределено', async () => {
    const container = await renderPanel()

    const reset = container.querySelector('[data-testid="default-agent-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    expect(reset.disabled).toBe(false)

    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(apiMock.resetDefaultAgent).toHaveBeenCalledTimes(1)
    expect(apiMock.getAgents).toHaveBeenCalled()
  })

  it('ошибка загрузки настройки не ломает панель', async () => {
    apiMock.getDefaultAgentInfo.mockRejectedValueOnce(new Error('boom'))
    const container = await renderPanel()

    // Секция настройки не рендерится, но список агентов на месте.
    expect(container.querySelector('[data-testid="default-agent-save"]')).toBeNull()
    expect(container.textContent).toContain('main')
  })

  it('при дефолтном значении Reset неактивен и серый', async () => {
    apiMock.getAllAgents.mockResolvedValue({
      agents: [agent('assistant', ['primary'])],
      default_agent: null,
    })
    apiMock.getDefaultAgentInfo.mockResolvedValue({
      defaultAgent: 'assistant', isOverridden: false, defaults: 'assistant',
    })
    const container = await renderPanel()

    const reset = container.querySelector('[data-testid="default-agent-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    expect(reset.disabled).toBe(true)
    expect(reset.className).toContain('border-muted-foreground')
  })
})
