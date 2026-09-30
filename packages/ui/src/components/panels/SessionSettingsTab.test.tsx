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
  getAgents: vi.fn(),
  getSessionMcpEffective: vi.fn(),
  updateSessionMcp: vi.fn(),
  getSecuritySettings: vi.fn(),
  updateSession: vi.fn(),
  clearSession: vi.fn(),
  getSessionMessages: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: vi.fn() }),
}))
vi.mock('../chat/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div', { 'data-testid': 'model-selector' }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionSettingsTab } from './SessionSettingsTab'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function effective(overrides: Record<string, unknown> = {}) {
  return {
    servers: [
      {
        name: 'sys',
        level: 'system',
        enabled: true,
        status: 'connected',
        origin: 'instance',
        trust: 'builtin',
        author: null,
        tools: [],
      },
      {
        name: 'proj',
        level: 'project',
        enabled: true,
        status: 'connected',
        origin: 'user',
        trust: 'community',
        author: { userId: 'u9', username: 'alice' },
        tools: [],
      },
    ],
    enabled: ['sys', 'proj'],
    disabled: [],
    mcpServers: ['sys', 'proj'],
    mcpDisabledServers: [],
    ...overrides,
  }
}

async function renderTab(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <SessionSettingsTab />
        </TooltipProvider>
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
  // Закрытый popup может остаться в DOM до конца exit-анимации, поэтому ищем
  // опции только в listbox, связанном с триггером через aria-controls.
  const listId = trigger.getAttribute('aria-controls')
  const scope = listId ? document.getElementById(listId) ?? document.body : document.body
  const allOptions = [...scope.querySelectorAll('[role="option"]')]
  const option = allOptions.find(
    (o) => o.textContent?.trim().startsWith(label),
  ) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

beforeEach(() => {
  mocks.getAgents.mockResolvedValue({ agents: [] })
  mocks.getSessionMcpEffective.mockResolvedValue(effective())
  mocks.updateSessionMcp.mockResolvedValue(effective())
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockResolvedValue({})
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        name: 'S',
        project_id: null,
        engine: 'synth',
        settings: { model: 'm', mcpServers: ['sys', 'proj'], mcpDisabledServers: [] },
      },
    ],
  } as never)
  useProvidersStore.setState({
    providers: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
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

/** Находит секцию с заголовком (по тексту первого дочернего узла). */
function findSection(container: HTMLElement, title: string): HTMLElement | undefined {
  return [...container.querySelectorAll('div')].find(
    (d) => d.firstElementChild?.textContent?.trim() === title,
  ) as HTMLElement | undefined
}

describe('SessionSettingsTab — имя сессии в блоке «Сессия»', () => {
  it('показывает имя над ID', async () => {
    const container = await renderTab()
    const section = findSection(container, 'Session')
    expect(section).toBeTruthy()

    const nameLabel = [...section!.querySelectorAll('span')].find((s) => s.textContent === 'Name')
    const idLabel = [...section!.querySelectorAll('span')].find((s) => s.textContent === 'ID')
    expect(nameLabel, 'поле Name').toBeTruthy()
    expect(idLabel, 'поле ID').toBeTruthy()
    // Значение имени — из фикстуры (name: 'S').
    expect(nameLabel!.parentElement?.textContent).toContain('S')
    // Имя идёт перед ID.
    expect(
      nameLabel!.compareDocumentPosition(idLabel!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('показывает прочерк, если имени нет', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: null, project_id: null, engine: 'synth', settings: { model: 'm' } },
      ],
    } as never)
    const container = await renderTab()
    const section = findSection(container, 'Session')
    const nameLabel = [...section!.querySelectorAll('span')].find((s) => s.textContent === 'Name')
    expect(nameLabel!.parentElement?.textContent).toContain('—')
  })
})

describe('SessionSettingsTab — MCP-скоуп сессии (AD-071 §2.4)', () => {
  it('показывает уровень, статус и причину отключения', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: true, status: 'connected', origin: 'instance', trust: 'builtin', tools: [] },
        {
          name: 'proj',
          level: 'project',
          enabled: false,
          reason: 'session_optout',
          status: 'disabled',
          origin: 'user',
          trust: 'community',
          tools: [],
        },
      ],
      enabled: ['sys'],
      disabled: ['proj'],
    }))
    const container = await renderTab()

    const sysRow = container.querySelector('[data-testid="session-mcp-sys"]')!
    expect(sysRow.textContent).toContain('system')
    // Статус скрыт под катом по умолчанию.
    expect(sysRow.textContent).not.toContain('connected')
    const sysCat = sysRow.querySelector('[data-testid="session-mcp-sys-details-toggle"]') as HTMLButtonElement
    expect(sysCat).toBeTruthy()
    expect(sysCat.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      sysCat.click()
    })
    expect(container.querySelector('[data-testid="session-mcp-sys-details-content"]')!.textContent).toContain('connected')

    const projRow = container.querySelector('[data-testid="session-mcp-proj"]')!
    expect(projRow.textContent).toContain('project')
    const projCat = projRow.querySelector('[data-testid="session-mcp-proj-details-toggle"]') as HTMLButtonElement
    await act(async () => {
      projCat.click()
    })
    const projContent = container.querySelector('[data-testid="session-mcp-proj-details-content"]')!
    expect(projContent.textContent).toContain('disabled')
    expect(projContent.textContent).toContain('session opt-out')
  })

  it('opt-out системного сервера вызывает PUT с { name, enabled: false }', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-mcp-sys"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    mocks.updateSessionMcp.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: false, reason: 'session_optout', status: 'disabled', origin: 'instance', trust: 'builtin', tools: [] },
        { name: 'proj', level: 'project', enabled: true, status: 'connected', origin: 'user', trust: 'community', tools: [] },
      ],
      enabled: ['proj'],
      disabled: ['sys'],
      mcpServers: ['proj'],
      mcpDisabledServers: ['sys'],
    }))

    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'sys', enabled: false })
    // Эффективный список перечитан с сервера; причина — в раскрываемом контенте.
    const updatedRow = container.querySelector('[data-testid="session-mcp-sys"]')!
    const updatedCat = updatedRow.querySelector('[data-testid="session-mcp-sys-details-toggle"]') as HTMLButtonElement
    await act(async () => {
      updatedCat.click()
    })
    expect(container.querySelector('[data-testid="session-mcp-sys-details-content"]')!.textContent).toContain('session opt-out')
  })

  it('включение отключённого сервера вызывает PUT с { name, enabled: true }', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: true, status: 'connected', origin: 'instance', trust: 'builtin', tools: [] },
        { name: 'proj', level: 'project', enabled: false, reason: 'not_default', status: 'disabled', origin: 'user', trust: 'community', tools: [] },
      ],
      enabled: ['sys'],
      disabled: ['proj'],
    }))
    const container = await renderTab()
    const row = container.querySelector('[data-testid="session-mcp-proj"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateSessionMcp).toHaveBeenCalledWith('s1', { name: 'proj', enabled: true })
  })
})

describe('SessionSettingsTab — per-session политики инструментов (AD-071 §2.3)', () => {
  it('переопределяет обе политики (встроенные + MCP) и сохраняет их', async () => {
    const container = await renderTab()
    const toolsTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global built-in tools policy"]',
    ) as HTMLElement | null
    const mcpTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global MCP policy"]',
    ) as HTMLElement | null
    expect(toolsTrigger).not.toBeNull()
    expect(mcpTrigger).not.toBeNull()
    // «Follow global» — дефолт (пусто).
    expect(toolsTrigger!.textContent).toContain('Follow global')
    expect(mcpTrigger!.textContent).toContain('Follow global')

    await selectOption(toolsTrigger!, 'available')
    await selectOption(mcpTrigger!, 'consistency')

    const saveButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const settings = mocks.updateSession.mock.calls[0][1].settings
    expect(settings.toolsPolicy).toBe('available')
    expect(settings.mcpPolicy).toBe('consistency')
  })

  it('подтягивает per-session переопределения обеих политик', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: null,
          engine: 'synth',
          settings: { model: 'm', toolsPolicy: 'consistency', mcpPolicy: 'available' },
        },
      ],
    } as never)
    const container = await renderTab()

    const toolsTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global built-in tools policy"]',
    ) as HTMLElement
    const mcpTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global MCP policy"]',
    ) as HTMLElement
    expect(toolsTrigger.textContent).toContain('consistency')
    expect(mcpTrigger.textContent).toContain('available')
  })
})
