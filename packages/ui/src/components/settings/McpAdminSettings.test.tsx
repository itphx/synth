import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getMcpRegistry: vi.fn(),
  getMcpToolSettings: vi.fn(),
  getMcpNetworkPolicy: vi.fn(),
  getMcpPolicy: vi.fn(),
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
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { McpAdminSettings } from './McpAdminSettings'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ENTRY_SYS = {
  schemaVersion: 1,
  id: 'e-sys',
  name: 'sys',
  config: { type: 'http', url: 'http://sys/mcp' },
  origin: 'instance',
  author: null,
  trust: 'builtin',
  enabledByDefault: true,
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
        <McpAdminSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getMcpRegistry.mockResolvedValue({ entries: [ENTRY_SYS] })
  mocks.getMcpToolSettings.mockResolvedValue({ servers: {} })
  mocks.getMcpNetworkPolicy.mockResolvedValue({ mode: 'deny', list: [] })
  mocks.saveMcpToolSettings.mockResolvedValue({ servers: {} })
  mocks.saveMcpNetworkPolicy.mockImplementation(async (p: unknown) => p)
  mocks.getMcpPolicy.mockResolvedValue('auto')
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

describe('McpAdminSettings — только MCP (AD-071 §2.5/§2.6)', () => {
  it('рендерит реестр MCP, но не секцию встроенных инструментов', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="mcp-registry-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tools-disabled-groups"]')).toBeNull()
    expect(container.querySelector('[data-testid="tools-disabled-tools"]')).toBeNull()
  })

  it('содержит политику MCP и шапку', async () => {
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="mcp-policy-save"]')).not.toBeNull()
    expect(container.textContent).toContain('MCP policy')
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    expect(header!.textContent).toContain('MCP Servers')
  })

  it('кнопка добавления вынесена в шапку (actions)', async () => {
    const container = await renderSettings()
    const header = container.querySelector('header')!
    expect(header.querySelector('[data-testid="mcp-admin-add"]')).not.toBeNull()
  })

  it('каркас: SettingsActions для доступности и reset-кнопки, без pr-2', async () => {
    const container = await renderSettings()
    expect(container.querySelector('.max-w-3xl')).not.toBeNull()
    expect(container.innerHTML).not.toContain('pr-2')
    expect(container.querySelector('[data-testid="mcp-availability-save"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-availability-cancel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-availability-reset"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="mcp-policy-reset"]')).not.toBeNull()
  })
})
