import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getToolsDisabledInfo: vi.fn(),
  saveToolsDisabled: vi.fn(),
  resetToolsDisabled: vi.fn(),
  getToolsPolicyInfo: vi.fn(),
  saveToolsPolicy: vi.fn(),
  resetToolsPolicy: vi.fn(),
  getSessionPrompt: vi.fn(),
  getEgressPolicy: vi.fn(),
  saveEgressPolicy: vi.fn(),
  resetEgressPolicy: vi.fn(),
  checkEgress: vi.fn(),
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

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const option = [...document.body.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent?.trim().startsWith(label),
  ) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

beforeEach(() => {
  mocks.getToolsDisabledInfo.mockResolvedValue({
    config: { capabilities: [], tools: [] },
    isOverridden: false,
    defaults: { capabilities: [], tools: [] },
  })
  mocks.saveToolsDisabled.mockImplementation(async (config: unknown) => config)
  mocks.resetToolsDisabled.mockResolvedValue({ capabilities: [], tools: [] })
  mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'consistency', isOverridden: false, defaults: 'consistency' })
  mocks.saveToolsPolicy.mockImplementation(async (policy: unknown) => policy)
  mocks.resetToolsPolicy.mockResolvedValue('consistency')
  mocks.getSessionPrompt.mockResolvedValue({ manifest: {}, history: {}, toolsDetail: TOOLS_DETAIL })
  mocks.getEgressPolicy.mockResolvedValue({
    policy: { mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] },
    isOverridden: false,
    defaults: { mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] },
  })
  mocks.saveEgressPolicy.mockImplementation(async (_scope: string, policy: unknown) => policy)
  mocks.resetEgressPolicy.mockResolvedValue({ mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] })
  mocks.checkEgress.mockResolvedValue({
    allowed: true,
    policy: { mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] },
  })

  useMcpStore.setState({
    toolsDisabled: null,
    toolsDisabledDefaults: null,
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

describe('ToolsDisabledSettings — админский tools.disabled (ADR-071 §2.6)', () => {
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
    mocks.getToolsDisabledInfo.mockResolvedValue({
      config: { capabilities: ['web'], tools: ['git_status'] },
      isOverridden: true,
      defaults: { capabilities: [], tools: [] },
    })
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
    mocks.getToolsDisabledInfo.mockResolvedValue({
      config: { capabilities: ['web'], tools: ['git_status'] },
      isOverridden: true,
      defaults: { capabilities: [], tools: [] },
    })
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

  it('карточка «Политика встроенных инструментов» отображается и сохраняет выбранное значение', async () => {
    const container = await renderSettings()

    expect(mocks.getToolsPolicyInfo).toHaveBeenCalledTimes(1)
    // Заголовок карточки политики встроенных (en-словарь).
    expect(container.textContent).toContain('Built-in tools policy')
    // Текущее значение подтянуто с сервера и видно в триггере селекта.
    expect(container.textContent).toContain('consistency')

    const saveButton = container.querySelector('[data-testid="tools-policy-save"]') as HTMLButtonElement
    expect(saveButton).not.toBeNull()
    // Политика на дефолте: Save/Cancel disabled, Reset — серая и disabled.
    expect(saveButton.disabled).toBe(true)
    const resetButton = container.querySelector('[data-testid="tools-policy-reset"]') as HTMLButtonElement
    expect(resetButton.disabled).toBe(true)
    expect(resetButton.className).toContain('border-muted-foreground')

    // Меняем значение — появляется dirty.
    const card = saveButton.closest('section')!
    const trigger = card.querySelector('[role="combobox"]') as HTMLElement
    await selectOption(trigger, 'available')

    // Изменённое значение: Save/Cancel активны, Reset — цветная.
    expect(saveButton.disabled).toBe(false)
    expect(resetButton.disabled).toBe(false)
    expect(resetButton.className).toContain('border-primary')

    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsPolicy).toHaveBeenCalledWith('available')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('использует шапку SettingsPage с заголовком «Встроенные инструменты»', async () => {
    const container = await renderSettings()
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('Built-in tools')
    // Политика встроенных описывается как относящаяся только к встроенным тулам.
    expect(container.textContent).toContain('Applies to built-in tools only')
  })

  it('в блоках инструментов и политики есть Cancel', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="tools-disabled-cancel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tools-policy-cancel"]')).not.toBeNull()
  })

  it('порядок блоков: инструменты → политика', async () => {
    const container = await renderSettings()
    const tools = container.querySelector('[data-testid="tools-disabled-groups"]')!
    const policy = container.querySelector('[data-testid="tools-policy-save"]')!
    expect(tools.compareDocumentPosition(policy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Cancel сбрасывает черновик к сохранённым значениям', async () => {
    const container = await renderSettings()
    const webGroup = container.querySelector('[data-testid="tools-disabled-group-web"]') as HTMLInputElement
    expect(webGroup.checked).toBe(true)

    await act(async () => {
      webGroup.click()
    })
    expect(webGroup.checked).toBe(false)

    const cancel = container.querySelector('[data-testid="tools-disabled-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    await act(async () => {
      cancel.click()
    })
    expect(webGroup.checked).toBe(true)
  })

  it('кнопки сохранения политики и инструментов — единый вид', async () => {
    const container = await renderSettings()
    for (const testId of ['tools-policy-save', 'tools-disabled-save']) {
      const btn = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
      expect(btn, testId).not.toBeNull()
      expect(btn.className).toContain('bg-primary')
      expect(btn.className).toContain('text-primary-foreground')
      expect(btn.className).toContain('text-xs')
      expect(btn.className).toContain('font-medium')
      expect(btn.className).toContain('rounded-lg')
      expect(btn.className).toContain('focus-visible:ring-2')
      expect(btn.className).not.toContain('active:scale-[0.96]')
      expect(btn.className).not.toContain('transition-[transform,opacity]')
    }
  })

  it('сохранение отключённых инструментов не трогает политику инструментов', async () => {
    const container = await renderSettings()

    // Без изменений Save disabled — делаем черновик dirty.
    const webGroup = container.querySelector('[data-testid="tools-disabled-group-web"]') as HTMLInputElement
    await act(async () => {
      webGroup.click()
    })

    const saveButton = container.querySelector('[data-testid="tools-disabled-save"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveToolsDisabled).toHaveBeenCalledTimes(1)
    expect(mocks.saveToolsPolicy).not.toHaveBeenCalled()
  })

  it('Reset инструментов вызывает resetToolsDisabled и включает всё', async () => {
    mocks.getToolsDisabledInfo.mockResolvedValue({
      config: { capabilities: ['web'], tools: ['git_status'] },
      isOverridden: true,
      defaults: { capabilities: [], tools: [] },
    })
    const container = await renderSettings()

    const webGroup = container.querySelector('[data-testid="tools-disabled-group-web"]') as HTMLInputElement
    expect(webGroup.checked).toBe(false)

    const reset = container.querySelector('[data-testid="tools-disabled-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(mocks.resetToolsDisabled).toHaveBeenCalledTimes(1)
    expect(webGroup.checked).toBe(true)
  })

  it('Reset политики вызывает resetToolsPolicy', async () => {
    // Политика отличается от дефолта — Reset цветная и активна.
    mocks.getToolsPolicyInfo.mockResolvedValue({ policy: 'available', isOverridden: true, defaults: 'consistency' })
    const container = await renderSettings()
    const reset = container.querySelector('[data-testid="tools-policy-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    expect(reset).not.toBeNull()
    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(mocks.resetToolsPolicy).toHaveBeenCalledTimes(1)
  })

  it('показывает бейдж «По умолчанию», когда отключений нет', async () => {
    const container = await renderSettings()
    expect(container.textContent).toContain('Default')
  })

  it('Reset инструментов серый/неактивен, когда конфиг равен серверному дефолту', async () => {
    // Серверный дефолт содержит отключения (config.yaml) — Reset не должен быть цветным.
    mocks.getToolsDisabledInfo.mockResolvedValue({
      config: { capabilities: ['web'], tools: ['git_status'] },
      isOverridden: false,
      defaults: { capabilities: ['web'], tools: ['git_status'] },
    })
    const container = await renderSettings()
    const reset = container.querySelector('[data-testid="tools-disabled-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    expect(reset.className).toContain('border-muted-foreground')
  })

  it('содержит секцию egress-политики встроенных инструментов', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="egress-tools-section"]')).not.toBeNull()
    expect(mocks.getEgressPolicy).toHaveBeenCalledWith('tools')
  })

  it('каркас SettingsPanel: один скролл, без pr-2, гриды с grid-cols-1', async () => {
    const container = await renderSettings()
    expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
    expect(container.querySelector('.max-w-3xl')).not.toBeNull()
    expect(container.innerHTML).not.toContain('pr-2')

    for (const el of container.querySelectorAll('[class*="grid"]')) {
      expect(el.className).toContain('grid-cols-1')
    }
  })
})
