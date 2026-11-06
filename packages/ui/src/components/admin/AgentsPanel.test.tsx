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
  // PROP-124: режим инстанса для SSH-ключей (`/settings/ssh`).
  getSshSettings: vi.fn(async () => ({
    mode: 'tools',
    saved: null,
    defaults: 'tools',
    source: 'config',
    envLocked: false,
    restartRequired: false,
  })),
  setSshMode: vi.fn(async () => ({
    mode: 'tools',
    saved: null,
    defaults: 'tools',
    source: 'runtime',
    envLocked: false,
    restartRequired: false,
  })),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AgentsPanel } from './AgentsPanel'
import type { AgentInfo } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom не реализует scrollIntoView, а панель прокручивает форму после открытия
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {}
}

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

describe('AgentsPanel — фильтр на Kit Tabs (ADR-072)', () => {
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

describe('AgentsPanel — температура агента: Auto (дефолт модели)', () => {
  const AGENT = agent('main', ['primary'])

  beforeEach(() => {
    apiMock.getAllAgents.mockResolvedValue({ agents: [AGENT], default_agent: null })
  })

  /** Открывает форму редактирования агента «main» через кнопку Edit. */
  async function openEditor(container: HTMLElement): Promise<void> {
    const editButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    ) as HTMLButtonElement | undefined
    expect(editButton).toBeDefined()
    await act(async () => {
      editButton!.click()
    })
    await act(async () => {})
  }

  const autoCheckbox = (container: HTMLElement) =>
    container.querySelector('[data-testid="agent-temperature-auto"]') as HTMLInputElement
  const slider = (container: HTMLElement) =>
    container.querySelector('input[type="range"]') as HTMLInputElement

  it('агент без температуры: включён Auto, слайдер заблокирован, сохраняется null', async () => {
    apiMock.getAgentDetail.mockResolvedValue({})
    const container = await renderPanel()
    await openEditor(container)

    const checkbox = autoCheckbox(container)
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(true)

    const range = slider(container)
    expect(range.disabled).toBe(true)

    const save = container.querySelector('[data-testid="agent-save"]') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(apiMock.saveAgent).toHaveBeenCalledTimes(1)
    expect(apiMock.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ temperature: null }))
  })

  it('агент с температурой: Auto снят, слайдер отправляет число', async () => {
    apiMock.getAgentDetail.mockResolvedValue({ temperature: 0.9 })
    const container = await renderPanel()
    await openEditor(container)

    const checkbox = autoCheckbox(container)
    expect(checkbox.checked).toBe(false)

    const range = slider(container)
    expect(range.disabled).toBe(false)
    expect(range.value).toBe('0.9')

    // Меняем значение слайдера (React слушает нативный input)
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setter.call(range, '0.5')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = container.querySelector('[data-testid="agent-save"]') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(apiMock.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.5 }))
  })

  it('выключение Auto подставляет 0.3, включение — снова сбрасывает в null', async () => {
    apiMock.getAgentDetail.mockResolvedValue({})
    const container = await renderPanel()
    await openEditor(container)

    const checkbox = autoCheckbox(container)
    expect(checkbox.checked).toBe(true)

    await act(async () => {
      checkbox.click()
    })
    expect(autoCheckbox(container).checked).toBe(false)
    expect(slider(container).value).toBe('0.3')

    await act(async () => {
      autoCheckbox(container).click()
    })
    expect(autoCheckbox(container).checked).toBe(true)

    const save = container.querySelector('[data-testid="agent-save"]') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(apiMock.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ temperature: null }))
  })
})

describe('AgentsPanel — агент по умолчанию (ADR-072)', () => {
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

describe('AgentsPanel — усилие рассуждений (effort, ADR-117)', () => {
  /** Открывает форму редактирования агента через кнопку Edit. */
  async function openEditor(container: HTMLElement): Promise<void> {
    const editButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    ) as HTMLButtonElement | undefined
    expect(editButton).toBeDefined()
    await act(async () => {
      editButton!.click()
    })
    await act(async () => {})
  }

  const effortTrigger = (container: HTMLElement) =>
    container.querySelector('[data-testid="agent-effort"]') as HTMLElement

  const save = async (container: HTMLElement): Promise<Record<string, unknown>> => {
    const button = container.querySelector('[data-testid="agent-save"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await act(async () => {})
    expect(apiMock.saveAgent).toHaveBeenCalledTimes(1)
    const call = apiMock.saveAgent.mock.calls[0] as unknown as [Record<string, unknown>]
    return call[0]
  }

  it('«Авто» (тир не задан): поле в payload не отправляется', async () => {
    apiMock.getAllAgents.mockResolvedValue({ agents: [agent('main', ['primary'])], default_agent: null })
    apiMock.getAgentDetail.mockResolvedValue({})
    const container = await renderPanel()
    await openEditor(container)

    // «Авто» (пустое значение) — стартовое состояние у агента без сохранённого тира.
    expect(effortTrigger(container)).toBeTruthy()

    const payload = await save(container)
    expect('effort' in payload).toBe(false)
  })

  it('round-trip: сохранённый тир виден в форме, выбранный уходит в payload', async () => {
    apiMock.getAllAgents.mockResolvedValue({
      agents: [{ ...agent('main', ['primary']), effort: 'xhigh' }],
      default_agent: null,
    })
    apiMock.getAgentDetail.mockResolvedValue({})
    const container = await renderPanel()
    await openEditor(container)

    expect(effortTrigger(container).textContent).toContain('xhigh')

    // `max` — только явный тир (из уровня размышлений не выводится).
    await selectOption(effortTrigger(container), 'max')

    const payload = await save(container)
    expect(payload.effort).toBe('max')
  })

  it('сброс сохранённого тира в «Авто» передаётся явным null', async () => {
    apiMock.getAllAgents.mockResolvedValue({
      agents: [{ ...agent('main', ['primary']), effort: 'high' }],
      default_agent: null,
    })
    apiMock.getAgentDetail.mockResolvedValue({})
    const container = await renderPanel()
    await openEditor(container)

    await selectOption(effortTrigger(container), 'Auto (from reasoning level)')

    const payload = await save(container)
    // `null` = «поле не задано» на сервере (как у temperature); без него
    // прежнее значение осталось бы в записи агента.
    expect(payload.effort).toBeNull()
  })
})
