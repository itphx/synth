import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getMcpRegistry: vi.fn(),
  getMcpToolSettings: vi.fn(),
  getMcpNetworkPolicyInfo: vi.fn(),
  getMcpPolicyInfo: vi.fn(),
  addMcpRegistryEntry: vi.fn(),
  updateMcpRegistryEntry: vi.fn(),
  deleteMcpRegistryEntry: vi.fn(),
  saveMcpToolSettings: vi.fn(),
  saveMcpNetworkPolicy: vi.fn(),
  saveMcpPolicy: vi.fn(),
  resetMcpSettings: vi.fn(),
  resetMcpNetworkPolicy: vi.fn(),
  resetMcpPolicy: vi.fn(),
  probeMcpServer: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
// Стабильный notify (не в deps, но так предсказуемее).
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { McpSettings } from './McpSettings'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ENTRY_SYS = {
  schemaVersion: 1,
  id: 'e-sys',
  name: 'sys',
  config: { type: 'http', url: 'http://sys/mcp', description: 'System server' },
  origin: 'instance',
  author: null,
  trust: 'builtin',
  enabledByDefault: true,
  createdAt: '',
  updatedAt: '',
}

const ENTRY_COMMUNITY = {
  schemaVersion: 1,
  id: 'e-com',
  name: 'community',
  config: { type: 'http', url: 'http://c/mcp', description: 'Community server' },
  origin: 'user',
  author: { userId: 'u1', username: 'alice' },
  trust: 'community',
  enabledByDefault: false,
  createdAt: '',
  updatedAt: '',
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <McpSettings />
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
  const option = allOptions.find(
    (o) => o.textContent?.trim().startsWith(label),
  ) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

beforeEach(() => {
  mocks.getMcpRegistry.mockResolvedValue({ entries: [ENTRY_SYS, ENTRY_COMMUNITY] })
  mocks.getMcpToolSettings.mockResolvedValue({ servers: {} })
  mocks.getMcpNetworkPolicyInfo.mockResolvedValue({
    policy: { mode: 'deny', list: ['10.0.0.0/8'] },
    isOverridden: false,
    defaults: { mode: 'deny', list: ['10.0.0.0/8'] },
  })
  mocks.addMcpRegistryEntry.mockResolvedValue(ENTRY_COMMUNITY)
  mocks.updateMcpRegistryEntry.mockResolvedValue(ENTRY_COMMUNITY)
  mocks.deleteMcpRegistryEntry.mockResolvedValue({ success: true })
  mocks.saveMcpToolSettings.mockResolvedValue({ servers: {} })
  mocks.saveMcpNetworkPolicy.mockImplementation(async (p: unknown) => p)
  mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'auto', isOverridden: false, defaults: 'auto' })
  mocks.saveMcpPolicy.mockImplementation(async (p: unknown) => p)
  mocks.resetMcpSettings.mockResolvedValue({ servers: {} })
  mocks.resetMcpNetworkPolicy.mockResolvedValue({ mode: 'deny', list: [] })
  mocks.resetMcpPolicy.mockResolvedValue('auto')
  mocks.probeMcpServer.mockResolvedValue({ name: 'sys', tools: [] })

  useMcpStore.setState({
    registry: null,
    loading: false,
    error: null,
    toolSettings: null,
    toolSettingsLoading: false,
    toolSettingsError: null,
    networkPolicy: null,
    networkPolicyDefaults: null,
    networkPolicyLoading: false,
    networkPolicyError: null,
  })
  useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles: ['ADMIN'] } as never })
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

describe('McpSettings — реестр MCP (AD-071 §2.5)', () => {
  it('показывает origin, trust и автора', async () => {
    const container = await renderSettings()
    const sysRow = container.querySelector('[data-testid="mcp-registry-sys"]')!
    expect(sysRow.textContent).toContain('system')
    expect(sysRow.textContent).toContain('trusted')

    const comRow = container.querySelector('[data-testid="mcp-registry-community"]')!
    expect(comRow.textContent).toContain('user')
    expect(comRow.textContent).toContain('community')
    expect(comRow.textContent).toContain('author: alice')
  })

  it('ADMIN видит опцию stdio и не видит ограничение', async () => {
    const container = await renderSettings()
    expect(container.textContent).not.toContain('stdio servers can only be added by an administrator')
  })

  it('не-ADMIN видит пояснение, что stdio добавляет только администратор', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles: ['USER'] } as never })
    const container = await renderSettings()
    // Открыть форму добавления.
    const addButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Add'))!
    await act(async () => {
      addButton.click()
    })
    expect(container.textContent).toContain('stdio servers can only be added by an administrator')
  })

  it('права: не-автор без ADMIN не может редактировать чужую запись', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'bob', roles: ['USER'] } as never })
    const container = await renderSettings()
    const comRow = container.querySelector('[data-testid="mcp-registry-community"]')!
    const edit = comRow.querySelector('button[aria-label="Edit"]') as HTMLButtonElement
    const del = comRow.querySelector('button[aria-label="Delete"]') as HTMLButtonElement
    expect(edit.disabled).toBe(true)
    expect(del.disabled).toBe(true)
  })

  it('права: автор может редактировать свою запись', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles: ['USER'] } as never })
    const container = await renderSettings()
    const comRow = container.querySelector('[data-testid="mcp-registry-community"]')!
    const edit = comRow.querySelector('button[aria-label="Edit"]') as HTMLButtonElement
    expect(edit.disabled).toBe(false)
  })
})

describe('McpSettings — политика MCP (AD-071 §2.3)', () => {
  it('ADMIN видит карточку «MCP policy» и сохраняет выбранное значение', async () => {
    const container = await renderSettings()

    expect(mocks.getMcpPolicyInfo).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('MCP policy')
    // Текущее значение подтянуто с сервера и видно в триггере селекта.
    expect(container.textContent).toContain('auto')

    const saveButton = container.querySelector('[data-testid="mcp-policy-save"]') as HTMLButtonElement
    expect(saveButton).not.toBeNull()
    // Политика на дефолте: Save/Cancel disabled, Reset — серая и disabled.
    expect(saveButton.disabled).toBe(true)
    const resetButton = container.querySelector('[data-testid="mcp-policy-reset"]') as HTMLButtonElement
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

    expect(mocks.saveMcpPolicy).toHaveBeenCalledWith('available')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('использует шапку SettingsPage с заголовком «MCP Servers»', async () => {
    const container = await renderSettings()
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('MCP Servers')
    // Политика MCP описывается как относящаяся только к MCP-инструментам.
    expect(container.textContent).toContain('Applies to MCP tools only')
  })

  it('кнопка добавления вынесена в шапку (actions)', async () => {
    const container = await renderSettings()
    const header = container.querySelector('header')!
    const addButton = header.querySelector('[data-testid="mcp-admin-add"]') as HTMLButtonElement
    expect(addButton).not.toBeNull()
    expect(addButton.className).toContain('bg-primary')
  })

  it('все кнопки «Сохранить» — единый вид', async () => {
    const container = await renderSettings()
    const saveButtons = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Save',
    )
    expect(saveButtons.length).toBeGreaterThanOrEqual(3)
    for (const btn of saveButtons) {
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

  it('в блоках доступности, политики и сети есть Cancel', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="mcp-availability-cancel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-policy-cancel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-network-cancel"]')).not.toBeNull()
  })

  it('порядок блоков: реестр → доступность → политика → сеть', async () => {
    const container = await renderSettings()
    const registry = container.querySelector('[data-testid="mcp-registry-list"]')!
    const availability = container.querySelector('[data-testid="mcp-availability-save"]')!
    const policy = container.querySelector('[data-testid="mcp-policy-save"]')!
    const network = container.querySelector('[data-testid="mcp-network-policy"]')!
    expect(registry.compareDocumentPosition(availability) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(availability.compareDocumentPosition(policy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(policy.compareDocumentPosition(network) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('Cancel в блоке доступности откатывает черновик', async () => {
    const container = await renderSettings()
    const cancel = container.querySelector('[data-testid="mcp-availability-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    const card = cancel.closest('section')!
    const toggles = card.querySelectorAll('[role="switch"]')
    expect(toggles.length).toBeGreaterThan(0)
    const firstToggle = toggles[0] as HTMLButtonElement
    const before = firstToggle.getAttribute('aria-checked')
    await act(async () => {
      firstToggle.click()
    })
    expect((toggles[0] as HTMLButtonElement).getAttribute('aria-checked')).not.toBe(before)

    await act(async () => {
      cancel.click()
    })
    expect((toggles[0] as HTMLButtonElement).getAttribute('aria-checked')).toBe(before)
  })
})

describe('McpSettings — сетевая политика (AD-071 §2.3.1 / AD-072)', () => {
  it('ADMIN видит секцию и сохраняет allow-режим со списком', async () => {
    mocks.getMcpNetworkPolicyInfo.mockResolvedValue({
      policy: { mode: 'allow', list: ['10.0.0.0/8'] },
      isOverridden: true,
      defaults: { mode: 'deny', list: [] },
    })
    const container = await renderSettings()
    const section = container.querySelector('[data-testid="mcp-network-policy"]')
    expect(section).not.toBeNull()

    // Нативный select заменён на Kit SelectField.
    expect(section!.querySelector('select')).toBeNull()
    expect(section!.querySelector('[aria-label="Mode"]')).not.toBeNull()

    const saveButton = section!.querySelector('[data-testid="mcp-network-save"]') as HTMLButtonElement
    expect(saveButton).not.toBeNull()
    // Без изменений Save неактивен (dirty).
    expect(saveButton.disabled).toBe(true)

    // Добавляем адрес в список — появляется несохранённая правка.
    const input = section!.querySelector('input[placeholder="10.0.0.0/8"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '192.168.0.0/16')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addButton = [...section!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement
    await act(async () => {
      addButton.click()
    })
    expect(saveButton.disabled).toBe(false)

    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.saveMcpNetworkPolicy).toHaveBeenCalledWith({
      mode: 'allow',
      list: ['10.0.0.0/8', '192.168.0.0/16'],
    })
  })

  it('не-ADMIN не видит секцию сетевой политики', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles: ['USER'] } as never })
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="mcp-network-policy"]')).toBeNull()
  })

  it('Reset сетевой политики серый/неактивен на серверном дефолте и активен при изменениях', async () => {
    // Серверный дефолт — deny приватных диапазонов с непустым списком.
    const serverDefault = {
      mode: 'deny' as const,
      list: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    }
    mocks.getMcpNetworkPolicyInfo.mockResolvedValue({
      policy: { mode: serverDefault.mode, list: [...serverDefault.list] },
      isOverridden: false,
      defaults: serverDefault,
    })
    const container = await renderSettings()
    const section = container.querySelector('[data-testid="mcp-network-policy"]')!
    const resetButton = section.querySelector('[data-testid="mcp-network-reset"]') as HTMLButtonElement
    const saveButton = section.querySelector('[data-testid="mcp-network-save"]') as HTMLButtonElement

    // Текущее значение равно серверному дефолту (непустой список) → Reset серый.
    expect(section.textContent).toContain('10.0.0.0/8')
    expect(resetButton.disabled).toBe(true)
    expect(resetButton.className).toContain('border-muted-foreground')
    expect(saveButton.disabled).toBe(true)

    const trigger = section.querySelector('[aria-label="Mode"]') as HTMLElement
    await selectOption(trigger, 'allow')

    expect(resetButton.disabled).toBe(false)
    expect(resetButton.className).toContain('border-primary')
    expect(saveButton.disabled).toBe(false)
  })
})

describe('McpSettings — reset через API (AD-072)', () => {
  it('Reset доступности серый/неактивен на серверном дефолте и активен при изменениях', async () => {
    const container = await renderSettings()
    const resetButton = () =>
      container.querySelector('[data-testid="mcp-availability-reset"]') as HTMLButtonElement

    expect(resetButton().disabled).toBe(true)
    expect(resetButton().className).toContain('border-muted-foreground')

    const card = container.querySelector('[data-testid="mcp-availability-save"]')!.closest('section')!
    const firstToggle = () => card.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      firstToggle().click()
    })

    expect(resetButton().disabled).toBe(false)
    expect(resetButton().className).toContain('border-primary')

    // Возврат тумблера к дефолту гасит Reset: сравнение по эффективным значениям.
    await act(async () => {
      firstToggle().click()
    })
    expect(resetButton().disabled).toBe(true)
    expect(resetButton().className).toContain('border-muted-foreground')
  })

  it('Reset в блоках доступности, политики и сети вызывает reset-API', async () => {
    // Доступность, политика и сеть отличаются от дефолта — Reset цветные и активны.
    mocks.getMcpToolSettings.mockResolvedValue({
      servers: { sys: { default: { plan: true, act: true }, tools: {} } },
    })
    mocks.getMcpPolicyInfo.mockResolvedValue({ policy: 'available', isOverridden: true, defaults: 'auto' })
    mocks.getMcpNetworkPolicyInfo.mockResolvedValue({
      policy: { mode: 'allow', list: ['10.0.0.0/8'] },
      isOverridden: true,
      defaults: { mode: 'deny', list: [] },
    })
    const container = await renderSettings()

    const availabilityReset = container.querySelector('[data-testid="mcp-availability-reset"]') as HTMLButtonElement
    const policyReset = container.querySelector('[data-testid="mcp-policy-reset"]') as HTMLButtonElement
    const networkReset = container.querySelector('[data-testid="mcp-network-reset"]') as HTMLButtonElement
    expect(availabilityReset).not.toBeNull()
    expect(policyReset).not.toBeNull()
    expect(networkReset).not.toBeNull()

    await act(async () => { availabilityReset.click() })
    await act(async () => {})
    await act(async () => { policyReset.click() })
    await act(async () => {})
    await act(async () => { networkReset.click() })
    await act(async () => {})

    expect(mocks.resetMcpSettings).toHaveBeenCalledTimes(1)
    expect(mocks.resetMcpPolicy).toHaveBeenCalledTimes(1)
    expect(mocks.resetMcpNetworkPolicy).toHaveBeenCalledTimes(1)
  })
})

describe('McpSettings — каркас SettingsPanel (AD-072)', () => {
  it('один вертикальный скролл, центрирование, без pr-2 и grid без grid-cols-1', async () => {
    const container = await renderSettings()
    expect(container.querySelector('.overflow-y-auto')).not.toBeNull()
    expect(container.querySelector('.max-w-3xl')).not.toBeNull()
    expect(container.innerHTML).not.toContain('pr-2')

    for (const el of container.querySelectorAll('[class*="grid"]')) {
      expect(el.className).toContain('grid-cols-1')
    }
  })

  it('счётчик серверов — в meta шапки панели, а не в шапке секции', async () => {
    const container = await renderSettings()

    const meta = container.querySelector('[data-testid="settings-header-meta"]')
    expect(meta).not.toBeNull()
    // Мок-реестр: sys + community → 2 сервера.
    expect(meta!.textContent).toContain('2 servers')

    // Счётчик встречается ровно один раз — только в meta панели, а не в шапке секции.
    const matches = container.textContent?.match(/2 servers/g) ?? []
    expect(matches).toHaveLength(1)
  })
})
