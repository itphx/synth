import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — мок для детерминизма.
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
  getSessionSkills: vi.fn(),
  updateSessionSkills: vi.fn(),
  getSecuritySettings: vi.fn(),
  updateSession: vi.fn(),
  getProviders: vi.fn(),
  getModels: vi.fn(),
  getToolsPolicyInfo: vi.fn(),
  getMcpPolicyInfo: vi.fn(),
  getProject: vi.fn(),
  listWorktrees: vi.fn(),
  getExecutionProfiles: vi.fn(),
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
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore } from '@/stores/entityEditStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = { id: 'p1', name: 'P', owner_id: 'u1', members: { u1: 'owner' } }
const CATALOG = {
  provider: 'static',
  pooling: 'instance',
  defaultProfile: 'default',
  profiles: ['default', 'devops', 'staging'],
  // PROP-135 (браузерный контур): отдельный каталог браузерных профилей.
  browserProfiles: ['browser', 'browser-full'],
  browserDefaultProfile: 'browser',
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
  await act(async () => {})
  return container
}

/** Сменить значение нативного select (native setter + change event). */
const selectValue = async (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
}

const profileSelect = (container: HTMLElement): HTMLSelectElement =>
  container.querySelector('[data-testid="session-executor-profile"]') as HTMLSelectElement

beforeEach(() => {
  mocks.getAgents.mockResolvedValue({ agents: [] })
  mocks.getSessionMcpEffective.mockResolvedValue({
    servers: [],
    enabled: [],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })
  mocks.updateSessionMcp.mockResolvedValue({
    servers: [],
    enabled: [],
    disabled: [],
    mcpServers: [],
    mcpDisabledServers: [],
  })
  mocks.getSessionSkills.mockResolvedValue({
    session_id: 's1',
    skills: [],
    enabled: [],
    disabled: [],
  })
  mocks.updateSessionSkills.mockResolvedValue({
    session_id: 's1',
    skills: [],
    enabled: [],
    disabled: [],
  })
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockImplementation(
    async (_id: string, data: { settings: Record<string, unknown> }) => ({
      id: 's1',
      name: 'S',
      project_id: 'p1',
      settings: { model: 'm', ...data.settings },
    }),
  )
  mocks.getProviders.mockResolvedValue({ providers: [], default_provider: null })
  mocks.getModels.mockResolvedValue([])
  mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'auto', isOverridden: false, defaults: 'auto' })
  mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'consistency', isOverridden: false, defaults: 'consistency' })
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.listWorktrees.mockResolvedValue([])
  mocks.getExecutionProfiles.mockResolvedValue(CATALOG)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        name: 'S',
        project_id: 'p1',
        settings: { model: 'm' },
      },
    ],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useProvidersStore.setState({
    providers: [],
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
  })
  useEntityEditStore.setState({ target: null })
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

describe('SessionSettingsTab — профиль исполнения сессии (PROP-135 Ф6b)', () => {
  it('каталог загружается: «Наследовать» + профили, у сессии без поля выбран «Наследовать»', async () => {
    const container = await renderTab()

    const select = profileSelect(container)
    expect(select).toBeTruthy()
    expect(select.value).toBe('')
    const options = [...select.options].map((o) => o.value)
    expect(options).toEqual(['', 'default', 'devops', 'staging'])
    // Подпись «Наследовать» несёт профиль по умолчанию из каталога.
    expect(select.options[0]!.textContent).toBe(
      enDict['sessionSettings.executor.inheritDefault'].replace('{profile}', CATALOG.defaultProfile),
    )
  })

  it('выбор профиля сохраняется тем же механизмом, что остальные поля сессии', async () => {
    const container = await renderTab()

    await selectValue(profileSelect(container), 'devops')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', {
      settings: { executorProfile: 'devops' },
    })
  })

  it('«Наследовать» сбрасывает профиль (пустая строка — явный сброс)', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm', executorProfile: 'devops' } },
      ],
    } as never)

    const container = await renderTab()
    const select = profileSelect(container)
    expect(select.value).toBe('devops')

    await selectValue(select, '')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', {
      settings: { executorProfile: '' },
    })
  })

  it('inline: профили не применимы — пояснение вместо селектора, сохранения нет', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      details: [],
    })

    const container = await renderTab()

    expect(
      container.querySelector('[data-testid="session-executor-not-applicable"]')!.textContent,
    ).toContain(enDict['sessionSettings.executor.notApplicable'])
    expect(profileSelect(container)).toBeNull()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('ошибка каталога: только «Наследовать» и предупреждение, вкладка не падает', async () => {
    mocks.getExecutionProfiles.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )

    const container = await renderTab()

    const select = profileSelect(container)
    expect(select).toBeTruthy()
    expect([...select.options].map((o) => o.value)).toEqual([''])
    expect(select.options[0]!.textContent).toBe(enDict['sessionSettings.executor.inheritUnknown'])
    expect(container.querySelector('[data-testid="session-executor-profiles-error"]')).not.toBeNull()
    // Остальные секции вкладки отрисованы — 401/403 каталога её не блокируют.
    expect(container.querySelector('[data-testid="model-selector"]')).not.toBeNull()
  })

  it('при ошибке каталога сохранённое значение остаётся видимым и сбрасываемым', async () => {
    mocks.getExecutionProfiles.mockRejectedValue(new Error('network'))
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm', executorProfile: 'ghost' } },
      ],
    } as never)

    const container = await renderTab()

    const select = profileSelect(container)
    expect(select.value).toBe('ghost')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'ghost'])
  })

  it('подсказка о наследовании показывает профиль проекта, если он задан', async () => {
    mocks.getProject.mockResolvedValue({ ...PROJECT, executor: { profile: 'devops' } })
    useProjectsStore.setState({
      projects: [{ ...PROJECT, executor: { profile: 'devops' } }] as never,
    })

    const container = await renderTab()

    const hint = enDict['sessionSettings.executor.inheritHintProject'].replace('{profile}', 'devops')
    expect(container.querySelector('[data-testid="session-executor"]')!.textContent).toContain(hint)
  })

  it('ошибка сохранения (403): тост о правах, выбор остаётся серверным', async () => {
    mocks.updateSession.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )

    const container = await renderTab()
    await selectValue(profileSelect(container), 'devops')

    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      text: enDict['sessionSettings.executor.forbidden'],
      type: 'error',
    }))
    // Оптимистичной подмены нет: значение остаётся тем, что в сессии.
    expect(profileSelect(container).value).toBe('')
  })
})

describe('SessionSettingsTab — профиль браузера сессии (PROP-135)', () => {
  const browserSelect = (container: HTMLElement): HTMLSelectElement =>
    container.querySelector('[data-testid="session-browser-profile-select"]') as HTMLSelectElement

  it('каталог браузерных профилей: «Наследовать» + только браузерные имена', async () => {
    const container = await renderTab()

    const select = browserSelect(container)
    expect(select).toBeTruthy()
    expect(select.value).toBe('')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'browser', 'browser-full'])
    expect(select.options[0]!.textContent).toBe(
      enDict['sessionSettings.browserProfile.inheritDefault'].replace('{profile}', 'browser'),
    )
  })

  it('выбор сохраняется отдельным полем settings.browserProfile', async () => {
    const container = await renderTab()

    await selectValue(browserSelect(container), 'browser-full')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', {
      settings: { browserProfile: 'browser-full' },
    })
  })

  it('«Наследовать» сбрасывает профиль (пустая строка)', async () => {
    useSessionsStore.setState({
      sessions: [
        { id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm', browserProfile: 'browser-full' } },
      ],
    } as never)

    const container = await renderTab()
    const select = browserSelect(container)
    expect(select.value).toBe('browser-full')

    await selectValue(select, '')

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', {
      settings: { browserProfile: '' },
    })
  })

  it('подсказка о наследовании показывает браузерный профиль проекта', async () => {
    mocks.getProject.mockResolvedValue({ ...PROJECT, executor: { browserProfile: 'browser-full' } })
    useProjectsStore.setState({
      projects: [{ ...PROJECT, executor: { browserProfile: 'browser-full' } }] as never,
    })

    const container = await renderTab()

    const hint = enDict['sessionSettings.browserProfile.inheritHintProject'].replace(
      '{profile}',
      'browser-full',
    )
    expect(container.querySelector('[data-testid="session-browser-profile"]')!.textContent).toContain(hint)
  })

  it('inline: браузерный профиль не применим — пояснение вместо селектора', async () => {
    mocks.getExecutionProfiles.mockResolvedValue({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      browserProfiles: [],
      browserDefaultProfile: '',
      details: [],
    })

    const container = await renderTab()

    expect(
      container.querySelector('[data-testid="session-browser-profile-not-applicable"]')!.textContent,
    ).toContain(enDict['sessionSettings.browserProfile.notApplicable'])
    expect(browserSelect(container)).toBeNull()
  })

  it('ошибка сохранения (403): тост о правах, значение остаётся серверным', async () => {
    mocks.updateSession.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )

    const container = await renderTab()
    await selectValue(browserSelect(container), 'browser-full')

    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      text: enDict['sessionSettings.browserProfile.forbidden'],
      type: 'error',
    }))
    expect(browserSelect(container).value).toBe('')
  })
})
