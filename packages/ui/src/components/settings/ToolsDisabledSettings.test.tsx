import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getToolsDisabled: vi.fn(),
  saveToolsDisabled: vi.fn(),
  getToolsPolicy: vi.fn(),
  saveToolsPolicy: vi.fn(),
  getSessionPrompt: vi.fn(),
  notify: vi.fn(),
}))

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

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ToolsDisabledSettings } from './ToolsDisabledSettings'
import { useMcpStore } from '@/stores/mcpStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const TOOLS_DETAIL = [
  { name: 'read_file', capabilities: ['file_read'], available: true, source: 'built-in' as const },
  { name: 'git_status', capabilities: ['git_read'], available: true, source: 'built-in' as const },
  { name: 'plan_read', capabilities: ['runtime'], available: true, source: 'built-in' as const },
]

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ToolsDisabledSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getToolsDisabled.mockResolvedValue({ capabilities: [], tools: [] })
  mocks.saveToolsDisabled.mockImplementation(async (config: unknown) => config)
  mocks.getToolsPolicy.mockResolvedValue('consistency')
  mocks.saveToolsPolicy.mockImplementation(async (policy: unknown) => policy)
  mocks.getSessionPrompt.mockResolvedValue({ manifest: {}, history: {}, toolsDetail: TOOLS_DETAIL })

  useMcpStore.setState({
    toolsDisabled: null,
    toolsDisabledLoading: false,
    toolsDisabledError: null,
  })
  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    toolsDisabledTick: 0,
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

describe('ToolsDisabledSettings — админский tools.disabled (AD-071 §2.6)', () => {
  it('галочка = включён: по умолчанию все группы и тулы отмечены; runtime защищён', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="tools-disabled-group-git_read"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tools-disabled-group-file_read"]')).not.toBeNull()

    // checked = включён (в disabled-списке пусто).
    const gitGroup = container.querySelector('[data-testid="tools-disabled-group-git_read"]') as HTMLInputElement
    expect(gitGroup.checked).toBe(true)
    const readTool = container.querySelector('[data-testid="tools-disabled-tool-read_file"]') as HTMLInputElement
    expect(readTool.checked).toBe(true)

    const runtimeGroupInput = container.querySelector('[data-testid="tools-disabled-runtime"] input') as HTMLInputElement
    expect(runtimeGroupInput.disabled).toBe(true)
    expect(runtimeGroupInput.checked).toBe(true)

    const runtimeTool = container.querySelector('[data-testid="tools-disabled-runtime-tool-plan_read"] input') as HTMLInputElement
    expect(runtimeTool).not.toBeNull()
    expect(runtimeTool.disabled).toBe(true)
    expect(runtimeTool.checked).toBe(true)

    expect(container.querySelector('[data-testid="tools-disabled-tool-read_file"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tools-disabled-tool-git_status"]')).not.toBeNull()
  })

  it('снятие галочки группы git_read добавляет её в disabled, PUT и тик', async () => {
    const container = await renderSettings()
    const gitGroup = container.querySelector('[data-testid="tools-disabled-group-git_read"]') as HTMLInputElement
    expect(gitGroup.checked).toBe(true)

    await act(async () => {
      gitGroup.click()
    })
    // Тул группы становится недоступен для точечного управления.
    const gitTool = container.querySelector('[data-testid="tools-disabled-tool-git_status"]') as HTMLInputElement
    expect(gitTool.disabled).toBe(true)
    expect(gitTool.checked).toBe(false)

    const saveButton = container.querySelector('[data-testid="tools-disabled-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsDisabled).toHaveBeenCalledWith({ capabilities: ['git_read'], tools: [] })
    expect(useUIStore.getState().toolsDisabledTick).toBe(1)
  })

  it('ранее отключённые группы/тулы показаны без галочки', async () => {
    mocks.getToolsDisabled.mockResolvedValue({ capabilities: ['web'], tools: ['git_status'] })
    const container = await renderSettings()

    const webGroup = container.querySelector('[data-testid="tools-disabled-group-web"]') as HTMLInputElement
    expect(webGroup.checked).toBe(false)
    const gitReadGroup = container.querySelector('[data-testid="tools-disabled-group-git_read"]') as HTMLInputElement
    expect(gitReadGroup.checked).toBe(true)
    const gitTool = container.querySelector('[data-testid="tools-disabled-tool-git_status"]') as HTMLInputElement
    expect(gitTool.checked).toBe(false)
    const readTool = container.querySelector('[data-testid="tools-disabled-tool-read_file"]') as HTMLInputElement
    expect(readTool.checked).toBe(true)
  })

  it('установка галочки убирает группу и тул из disabled', async () => {
    mocks.getToolsDisabled.mockResolvedValue({ capabilities: ['web'], tools: ['git_status'] })
    const container = await renderSettings()

    const webGroup = container.querySelector('[data-testid="tools-disabled-group-web"]') as HTMLInputElement
    const gitTool = container.querySelector('[data-testid="tools-disabled-tool-git_status"]') as HTMLInputElement

    await act(async () => {
      webGroup.click()
    })
    await act(async () => {
      gitTool.click()
    })

    const saveButton = container.querySelector('[data-testid="tools-disabled-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsDisabled).toHaveBeenCalledWith({ capabilities: [], tools: [] })
  })

  it('карточка «Политика инструментов» отображается и сохраняет выбранное значение', async () => {
    mocks.getToolsPolicy.mockResolvedValue('available')
    const container = await renderSettings()

    expect(mocks.getToolsPolicy).toHaveBeenCalledTimes(1)
    // Заголовок карточки политики (en-словарь).
    expect(container.textContent).toContain('Tools policy')
    // Текущее значение подтянуто с сервера и видно в триггере селекта.
    expect(container.textContent).toContain('available')

    const saveButton = container.querySelector('[data-testid="tools-policy-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsPolicy).toHaveBeenCalledWith('available')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('сохранение отключённых инструментов не трогает политику инструментов', async () => {
    const container = await renderSettings()

    const saveButton = container.querySelector('[data-testid="tools-disabled-save"]') as HTMLButtonElement
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsDisabled).toHaveBeenCalledTimes(1)
    expect(mocks.saveToolsPolicy).not.toHaveBeenCalled()
  })
})
