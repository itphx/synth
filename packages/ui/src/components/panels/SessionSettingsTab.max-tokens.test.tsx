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
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))
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

function sessionInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('[data-testid="session-max-tokens"]') as HTMLInputElement | null
  expect(input, 'поле «Лимит ответа»').not.toBeNull()
  return input!
}

/** Ввод в контролируемый `input[type="number"]` (как в соседних тестах вкладки). */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Перекрывает окно debounce автосохранения (и даёт выполниться промисам запроса). */
async function waitAutosave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
  await act(async () => {})
}

function setSessionSettings(settings: Record<string, unknown>): void {
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: null, settings: { model: 'm', ...settings } }],
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAgents.mockResolvedValue({ agents: [] })
  mocks.getSessionMcpEffective.mockResolvedValue({
    servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [],
  })
  mocks.updateSessionMcp.mockResolvedValue({
    servers: [], enabled: [], disabled: [], mcpServers: [], mcpDisabledServers: [],
  })
  mocks.getSecuritySettings.mockResolvedValue({ askTimeoutMs: 30_000 })
  mocks.updateSession.mockImplementation(async (_id: string, data: { settings: Record<string, unknown> }) => ({
    id: 's1',
    name: 'S',
    project_id: null,
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
  setSessionSettings({ maxTokens: 0 })
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

describe('SessionSettingsTab — лимит ответа (maxTokens, 0 = авто)', () => {
  it('показывает значение сессии (0 = авто), границы и подсказку', async () => {
    const container = await renderTab()
    const input = sessionInput(container)

    expect(input.value).toBe('0')
    expect(input.type).toBe('number')
    expect(input.min).toBe('0')
    expect(input.max).toBe('200000')
    expect(input.step).toBe('1')
    expect(input.getAttribute('aria-label')).toBe(enDict['sessionSettings.maxTokens'])
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(container.textContent).toContain(enDict['sessionSettings.maxTokensHint'])
  })

  it('гидратирует заданный в сессии лимит', async () => {
    setSessionSettings({ maxTokens: 4096 })
    const container = await renderTab()
    expect(sessionInput(container).value).toBe('4096')
  })

  it('изменение сохраняется с debounce как settings.maxTokens', async () => {
    const container = await renderTab()
    const input = sessionInput(container)

    await typeInto(input, '2048')
    // Сразу после ввода запроса нет — ждём debounce.
    expect(mocks.updateSession).not.toHaveBeenCalled()

    await waitAutosave()

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const [sessionId, payload] = mocks.updateSession.mock.calls[0]!
    expect(sessionId).toBe('s1')
    // Лимит уходит числом; остальные поля формы сохраняются в теле.
    expect(payload.settings).toMatchObject({ maxTokens: 2048, debugEnabled: false })
  })

  it('пустая строка сохраняется как 0 (авто)', async () => {
    setSessionSettings({ maxTokens: 4096 })
    const container = await renderTab()
    const input = sessionInput(container)
    expect(input.value).toBe('4096')

    await typeInto(input, '')
    await waitAutosave()

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    const settings = mocks.updateSession.mock.calls[0]![1].settings
    expect(settings.maxTokens).toBe(0)
  })

  it('невалидное значение (больше 200000 или отрицательное) не сохраняется', async () => {
    const container = await renderTab()
    const input = sessionInput(container)

    await typeInto(input, '250000')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await waitAutosave()
    expect(mocks.updateSession).not.toHaveBeenCalled()

    await typeInto(input, '-5')
    await waitAutosave()
    expect(mocks.updateSession).not.toHaveBeenCalled()

    // Возврат к валидному значению снова включает автосейв.
    await typeInto(input, '1024')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    await waitAutosave()
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession.mock.calls[0]![1].settings.maxTokens).toBe(1024)
  })

  it('невалидный ввод не затирает лимит при автосейве другого поля', async () => {
    setSessionSettings({ maxTokens: 4096 })
    const container = await renderTab()
    const input = sessionInput(container)

    await typeInto(input, '999999')
    // Меняем тумблер Debug — сохраняется тело целиком.
    const debugSection = [...container.querySelectorAll('div')].find(
      (d) => d.firstElementChild?.textContent?.trim() === 'Debug',
    ) as HTMLElement
    const toggle = debugSection.querySelector('button[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession.mock.calls[0]![1].settings.maxTokens).toBe(4096)
  })

  it('при ошибке автосейва поле откатывается к серверному значению', async () => {
    mocks.updateSession.mockRejectedValueOnce(new Error('boom'))
    const container = await renderTab()
    const input = sessionInput(container)

    await typeInto(input, '2048')
    await waitAutosave()

    expect(mocks.updateSession).toHaveBeenCalledTimes(1)
    expect(sessionInput(container).value).toBe('0')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: enDict['panel.saveError'], type: 'error' }),
    )
  })
})
