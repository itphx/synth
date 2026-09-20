import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getMcpRegistry: vi.fn(),
  addMcpRegistryEntry: vi.fn(),
  updateMcpRegistryEntry: vi.fn(),
  deleteMcpRegistryEntry: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { McpUserSettings } from './McpUserSettings'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ENTRY_SYS = {
  schemaVersion: 1, id: 'e-sys', name: 'sys',
  config: { type: 'http', url: 'http://sys/mcp' },
  origin: 'instance', author: null, trust: 'builtin', enabledByDefault: true,
  createdAt: '', updatedAt: '',
}
const ENTRY_OWN = {
  schemaVersion: 1, id: 'e-own', name: 'mine',
  config: { type: 'http', url: 'http://mine/mcp', description: 'My server' },
  origin: 'user', author: { userId: 'u1', username: 'alice' }, trust: 'community', enabledByDefault: false,
  createdAt: '', updatedAt: '',
}
const ENTRY_OTHER = {
  schemaVersion: 1, id: 'e-other', name: 'other',
  config: { type: 'http', url: 'http://other/mcp' },
  origin: 'user', author: { userId: 'u2', username: 'bob' }, trust: 'community', enabledByDefault: false,
  createdAt: '', updatedAt: '',
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
        <McpUserSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getMcpRegistry.mockResolvedValue({ entries: [ENTRY_SYS, ENTRY_OWN, ENTRY_OTHER] })
  mocks.addMcpRegistryEntry.mockResolvedValue(ENTRY_OWN)
  mocks.updateMcpRegistryEntry.mockResolvedValue(ENTRY_OWN)
  mocks.deleteMcpRegistryEntry.mockResolvedValue({ success: true })

  useMcpStore.setState({ registry: null, loading: false, error: null })
  useAuthStore.setState({ user: { id: 'u1', username: 'alice', roles: ['USER'] } as never })
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

describe('McpUserSettings — пользовательская часть MCP (AD-071 §2.5)', () => {
  it('показывает только собственные серверы (system и чужие скрыты)', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="mcp-user-mine"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-user-sys"]')).toBeNull()
    expect(container.querySelector('[data-testid="mcp-user-other"]')).toBeNull()
  })

  it('форма добавления — только HTTP/SSE (без stdio)', async () => {
    const container = await renderSettings()
    const addButton = container.querySelector('[data-testid="mcp-user-add"]') as HTMLButtonElement
    await act(async () => {
      addButton.click()
    })
    // Триггер типа подключения присутствует, подсказка явно ограничивает HTTP/SSE.
    expect(container.querySelector('[aria-label="Connection Type"]')).not.toBeNull()
    expect(container.textContent).toContain('Only HTTP/SSE servers can be added here')
    expect(container.textContent).not.toContain('stdio (process)')
  })

  it('сохранение нового сервера вызывает addMcpRegistryEntry', async () => {
    const container = await renderSettings()
    const addButton = container.querySelector('[data-testid="mcp-user-add"]') as HTMLButtonElement
    await act(async () => {
      addButton.click()
    })

    const nameInput = container.querySelector('input[placeholder="my-server"]') as HTMLInputElement
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      valueSetter.call(nameInput, 'new-one')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
    await act(async () => {
      saveButton.click()
    })
    await act(async () => {})

    expect(mocks.addMcpRegistryEntry).toHaveBeenCalledWith({ name: 'new-one', config: { type: 'http' } })
  })

  it('использует sticky-шапку SettingsPage с заголовком «MCP Servers»', async () => {
    const container = await renderSettings()
    const header = container.querySelector('header.sticky')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('MCP Servers')
  })

  it('кнопка сохранения формы — единый вид', async () => {
    const container = await renderSettings()
    const addButton = container.querySelector('[data-testid="mcp-user-add"]') as HTMLButtonElement
    await act(async () => {
      addButton.click()
    })
    const saveButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement
    expect(saveButton).not.toBeNull()
    expect(saveButton.className).toContain('bg-interactive-accent')
    expect(saveButton.className).toContain('text-interactive-accent-foreground')
    expect(saveButton.className).toContain('text-sm')
    expect(saveButton.className).toContain('font-medium')
    expect(saveButton.className).toContain('rounded-lg')
    expect(saveButton.className).toContain('active:scale-[0.96]')
    expect(saveButton.className).toContain('transition-[transform,opacity]')
    expect(saveButton.className).toContain('focus-visible:ring-2')
  })
})
