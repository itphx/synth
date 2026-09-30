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
  getProviders: vi.fn(),
  getModels: vi.fn(),
  getToolsPolicyInfo: vi.fn(),
  getMcpPolicyInfo: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('../chat/ModelSelector', () => ({
  ModelSelector: () => React.createElement('div', { 'data-testid': 'model-selector' }),
}))
// Пикер живёт в Popover: для теста логики сохранения раскрываем содержимое.
vi.mock('@/components/ui/popover', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough }
})

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

/** Как `renderTab`, но под `StrictMode` (двойной прогон эффектов на монтировании). */
async function renderTabStrict(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <React.StrictMode>
        <I18nProvider>
          <TooltipProvider>
            <SessionSettingsTab />
          </TooltipProvider>
        </I18nProvider>
      </React.StrictMode>,
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
  mocks.updateSession.mockImplementation(async (_id: string, data: { settings: Record<string, unknown> }) => ({
    id: 's1',
    name: 'S',
    project_id: null,
    engine: 'synth',
    settings: data.settings,
  }))
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])
  mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'auto', isOverridden: false, defaults: 'auto' })
  mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'consistency', isOverridden: false, defaults: 'consistency' })

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

describe('SessionSettingsTab — тумблер MCP: pending vs disabled', () => {
  it('во время in-flight запроса тумблер не disabled и помечен aria-busy', async () => {
    let resolveUpdate!: (value: unknown) => void
    mocks.updateSessionMcp.mockReturnValue(
      new Promise((resolve) => { resolveUpdate = resolve }),
    )

    const container = await renderTab()
    const toggle = container.querySelector(
      '[data-testid="session-mcp-sys"] button[role="switch"]',
    ) as HTMLButtonElement

    await act(async () => {
      toggle.click()
    })

    const pendingToggle = container.querySelector(
      '[data-testid="session-mcp-sys"] button[role="switch"]',
    ) as HTMLButtonElement
    expect(pendingToggle.disabled).toBe(false)
    expect(pendingToggle.getAttribute('aria-busy')).toBe('true')
    expect(pendingToggle.classList.contains('cursor-progress')).toBe(true)

    // Повторный клик во время запроса не порождает второй вызов (гасит обработчик).
    await act(async () => {
      pendingToggle.click()
    })
    expect(mocks.updateSessionMcp).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveUpdate(effective())
    })
    expect(
      container.querySelector('[data-testid="session-mcp-sys"] button[role="switch"]')!
        .getAttribute('aria-busy'),
    ).toBeNull()
  })

  it('при reason system_disabled/project_disabled — реально disabled, без aria-busy', async () => {
    mocks.getSessionMcpEffective.mockResolvedValue(effective({
      servers: [
        { name: 'sys', level: 'system', enabled: false, reason: 'system_disabled', status: 'disabled', origin: 'instance', trust: 'builtin', tools: [] },
        { name: 'proj', level: 'project', enabled: false, reason: 'project_disabled', status: 'disabled', origin: 'user', trust: 'community', tools: [] },
      ],
      enabled: [],
      disabled: ['sys', 'proj'],
    }))

    const container = await renderTab()
    const sysToggle = container.querySelector(
      '[data-testid="session-mcp-sys"] button[role="switch"]',
    ) as HTMLButtonElement
    const projToggle = container.querySelector(
      '[data-testid="session-mcp-proj"] button[role="switch"]',
    ) as HTMLButtonElement

    expect(sysToggle.disabled).toBe(true)
    expect(projToggle.disabled).toBe(true)
    expect(sysToggle.getAttribute('aria-busy')).toBeNull()
    expect(projToggle.getAttribute('aria-busy')).toBeNull()
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
    // Наследование: «Глобальная (<короткое имя глобальной политики>)».
    expect(toolsTrigger!.textContent).toContain('Global')
    expect(toolsTrigger!.textContent).toContain('By provider')
    expect(mcpTrigger!.textContent).toContain('Global')
    expect(mcpTrigger!.textContent).toContain('Consistency')

    // Селекты автосохраняются сразу — кнопка Save не нужна.
    await selectOption(toolsTrigger!, 'Available only')
    await selectOption(mcpTrigger!, 'Consistency')

    expect(mocks.updateSession).toHaveBeenCalled()
    const settings = mocks.updateSession.mock.calls.at(-1)![1].settings
    expect(settings.toolsPolicy).toBe('available')
    expect(settings.mcpPolicy).toBe('consistency')
  })

  it('при ошибке запроса глобальных политик показывает фоллбек «Global»', async () => {
    mocks.getToolsPolicyInfo.mockRejectedValue(new Error('boom'))
    mocks.getMcpPolicyInfo.mockRejectedValue(new Error('boom'))
    const container = await renderTab()

    const toolsTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global built-in tools policy"]',
    ) as HTMLElement
    const mcpTrigger = container.querySelector(
      '[role="combobox"][aria-label="Global MCP policy"]',
    ) as HTMLElement
    expect(toolsTrigger.textContent).toContain('Global')
    expect(mcpTrigger.textContent).toContain('Global')
    // Без скобки со значением — только фоллбек-метка.
    expect(toolsTrigger.textContent).not.toContain('(')
    expect(mcpTrigger.textContent).not.toContain('(')
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
    expect(toolsTrigger.textContent).toContain('Consistency')
    expect(mcpTrigger.textContent).toContain('Available only')
  })
})

describe('SessionSettingsTab — автосохранение настроек', () => {
  it('тумблер Debug сохраняется сразу, без кнопки Save', async () => {
    const container = await renderTab()
    // Кнопки Save в футере больше нет.
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')).toBeUndefined()

    const section = findSection(container, 'Debug')!
    const toggle = section.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const [sessionId, payload] = mocks.updateSession.mock.calls[0]!
    expect(sessionId).toBe('s1')
    expect(payload.settings.debugEnabled).toBe(true)
  })

  it('инпут таймаута сохраняется с debounce (~500 мс)', async () => {
    const container = await renderTab()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Сразу после ввода запроса ещё нет — срабатывает debounce.
    expect(mocks.updateSession).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const body = mocks.updateSession.mock.calls[0]![1].settings
    expect(body.permission.askTimeoutMs).toBe(45_000)
  })

  it('пустой permission: {} не пишется при изменении другого поля', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: null,
          engine: 'synth',
          settings: { model: 'm', permission: {} },
        },
      ],
    } as never)
    const container = await renderTab()
    const toggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const settings = mocks.updateSession.mock.calls[0]![1].settings
    expect(settings.debugEnabled).toBe(true)
    // «Мусорный» пустой permission не создаётся.
    expect('permission' in settings).toBe(false)
  })

  it('непустой askTimeout-override при permission: {} всё ещё пишется', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: null,
          engine: 'synth',
          settings: { model: 'm', permission: {} },
        },
      ],
    } as never)
    const container = await renderTab()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

    await act(async () => {
      setter.call(input, '45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const body = mocks.updateSession.mock.calls[0]![1].settings
    expect(body.permission).toEqual({ askTimeoutMs: 45_000 })
  })

  it('при смене сессии дофлашивает отложенное сохранение (best-effort)', async () => {
    const container = await renderTab()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '45')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Debounce ещё не сработал.
    expect(mocks.updateSession).not.toHaveBeenCalled()

    // Переключаемся на другую сессию до срабатывания debounce.
    await act(async () => {
      useSessionsStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          { id: 's2', name: 'S2', project_id: null, engine: 'synth', settings: { model: 'm2' } },
        ],
      }) as never)
      useUIStore.setState({
        activeCenterTabId: 'tab-2',
        centerTabs: [
          { id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } },
          { id: 'tab-2', type: 'chat', title: 'Chat', data: { sessionId: 's2' } },
        ],
      })
    })

    // Несохранённый ввод ушёл в API для прежней сессии.
    expect(mocks.updateSession).toHaveBeenCalledWith('s1', expect.objectContaining({
      settings: expect.objectContaining({
        permission: expect.objectContaining({ askTimeoutMs: 45_000 }),
      }),
    }))
  })

  it('выключение таймаута не порождает повторных запросов', async () => {
    const container = await renderTab()
    const toggle = findSection(container, 'Approval timeout')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession.mock.calls[0]![1].settings.permission.askTimeoutMs).toBe(0)

    // Дольше debounce: повторных запросов из-за расхождения секунд быть не должно.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
  })

  it('включение таймаута из выключенного состояния сохраняется по дефолту', async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: null,
          engine: 'synth',
          settings: { model: 'm', permission: { askTimeoutMs: 0 } },
        },
      ],
    } as never)
    const container = await renderTab()
    const toggle = findSection(container, 'Approval timeout')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle.click()
    })
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    // Включение подставляет глобальный дефолт → override не пишем.
    expect(mocks.updateSession.mock.calls[0]![1].settings.permission?.askTimeoutMs).toBeUndefined()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
  })

  it('во время запроса pending только у изменённого тумблера', async () => {
    let resolveUpdate!: (value: unknown) => void
    mocks.updateSession.mockReturnValue(
      new Promise((resolve) => { resolveUpdate = resolve }),
    )

    const container = await renderTab()
    const debugToggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      debugToggle.click()
    })

    const pendingToggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    expect(pendingToggle.disabled).toBe(false)
    expect(pendingToggle.getAttribute('aria-busy')).toBe('true')
    expect(pendingToggle.classList.contains('cursor-progress')).toBe(true)

    // Соседний тумблер (таймаут подтверждения) не подсвечивается как pending.
    const otherToggle = findSection(container, 'Approval timeout')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    expect(otherToggle.getAttribute('aria-busy')).toBeNull()

    await act(async () => {
      resolveUpdate({ id: 's1', name: 'S', project_id: null, engine: 'synth', settings: { model: 'm', debugEnabled: true } })
    })
    expect(
      findSection(container, 'Debug')!.querySelector('button[role="switch"]')!.getAttribute('aria-busy'),
    ).toBeNull()
  })

  it('успешный автосейв даёт единый success-тост, повторный в окне — троттлится', async () => {
    const container = await renderTab()
    const debugToggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    const microToggle = findSection(container, 'Quick answers')!
      .querySelector('button[role="switch"]') as HTMLButtonElement

    await act(async () => {
      debugToggle.click()
    })
    await act(async () => {})
    await act(async () => {
      microToggle.click()
    })
    await act(async () => {})

    const successCalls = mocks.notify.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === 'success',
    )
    expect(successCalls).toHaveLength(1)
    expect(successCalls[0]![0]).toMatchObject({ text: enDict['panel.saved'] })
  })

  it('при ошибке автосейва форма откатывается к серверному состоянию', async () => {
    mocks.updateSession.mockRejectedValueOnce(new Error('boom'))
    const container = await renderTab()
    const debugToggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    expect(debugToggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      debugToggle.click()
    })
    await act(async () => {})

    const after = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    expect(after.getAttribute('aria-checked')).toBe('false')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })
})

describe('SessionSettingsTab — иконка в строке «Имя» (AD-075)', () => {
  beforeEach(() => {
    // Сохраняем settings сессии при PATCH icon/color (иначе рендер упадёт на
    // «settings.permission» — мок возвращает только переданные поля).
    mocks.updateSession.mockImplementation(async (_id: string, data: { settings?: Record<string, unknown>; icon?: string | null; color?: string | null }) => ({
      id: 's1',
      name: 'S',
      project_id: null,
      engine: 'synth',
      settings: { model: 'm', ...(data.settings ?? {}) },
      icon: data.icon ?? null,
      color: data.color ?? null,
    }))
  })

  it('триггер иконки встроен в строку «Имя» секции «Сессия», отдельной секции нет', async () => {
    const container = await renderTab()
    const section = findSection(container, 'Session')!
    const nameLabel = [...section.querySelectorAll('span')].find((s) => s.textContent === 'Name')
    expect(nameLabel, 'поле Name').toBeTruthy()
    expect(
      nameLabel!.parentElement!.querySelector('[data-testid="session-icon-color-trigger"]'),
      'триггер иконки в строке «Имя»',
    ).not.toBeNull()
    expect(findSection(container, 'Icon & color'), 'отдельная секция «Иконка и цвет»').toBeUndefined()
  })

  it('клик по ключу иконки сохраняет канонический ключ через updateSession', async () => {
    const container = await renderTab()
    expect(container.querySelector('[data-testid="session-icon-color-trigger"]')).not.toBeNull()

    const iconBtn = container.querySelector('[data-testid="entity-icon-rocket"]') as HTMLButtonElement
    expect(iconBtn).toBeTruthy()
    await act(async () => { iconBtn.click() })

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { icon: 'rocket' })
  })

  it('выбор и сброс цвета уходят ключом и null', async () => {
    const container = await renderTab()
    const colorBtn = container.querySelector('[data-testid="entity-color-primary"]') as HTMLButtonElement
    await act(async () => { colorBtn.click() })
    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { color: 'primary' })

    const none = container.querySelector('[data-testid="entity-color-none"]') as HTMLButtonElement
    await act(async () => { none.click() })
    expect(mocks.updateSession).toHaveBeenLastCalledWith('s1', { color: null })
  })
})

describe('SessionSettingsTab — StrictMode: монтирование не запускает автосохранение', () => {
  // Сессия с не-дефолтными настройками: до фикса двойной прогон эффектов в StrictMode
  // видел «устаревшую» (дефолтную) форму vs session.settings и сохранял её.
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: null,
          engine: 'synth',
          settings: { model: 'm', debugEnabled: true, toolsPolicy: 'auto', microFirst: true },
        },
      ],
    } as never)
  })

  it('монтирование вкладки без действий не вызывает updateSession и не шлёт panel.saved', async () => {
    await renderTabStrict()
    // С запасом перекрываем debounce-окно автосейва.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    expect(mocks.updateSession).not.toHaveBeenCalled()
    const successCalls = mocks.notify.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === 'success',
    )
    expect(successCalls).toHaveLength(0)
  })

  it('реальное изменение пользователем по-прежнему автосохраняется', async () => {
    const container = await renderTabStrict()
    const toggle = findSection(container, 'Debug')!
      .querySelector('button[role="switch"]') as HTMLButtonElement
    // Гидратация подтянула session.settings (debugEnabled: true).
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession.mock.calls[0]![1].settings.debugEnabled).toBe(false)
  })
})
