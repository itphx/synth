import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getLlmGatewaySettings: vi.fn(),
  saveLlmGatewaySettings: vi.fn(),
  getGatewayPatterns: vi.fn(),
  saveGatewayPatterns: vi.fn(),
  resetGatewayPatterns: vi.fn(),
  getSecuritySettings: vi.fn(),
  saveSecuritySettings: vi.fn(),
  getProtectedPaths: vi.fn(),
  saveProtectedPaths: vi.fn(),
  resetProtectedPaths: vi.fn(),
  // Политики инструментов в «Безопасности» быть не должно — проверяем, что не дёргается.
  getToolsPolicy: vi.fn(),
  saveToolsPolicy: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SecuritySettings } from './SecuritySettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SecuritySettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getLlmGatewaySettings.mockResolvedValue({ enabled: false, inputMode: 'obfuscate', logPayloads: false })
  mocks.getGatewayPatterns.mockResolvedValue({ patterns: [], isOverridden: false })
  mocks.getSecuritySettings.mockResolvedValue({ protectedPaths: { enabled: true } })
  mocks.getProtectedPaths.mockResolvedValue({
    policy: { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] },
    isOverridden: false,
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

describe('SecuritySettings — без политики инструментов (AD-071 §2.3 перенесена во «Встроенные инструменты»)', () => {
  it('карточка «Политика инструментов» не рендерится и API политики не вызывается', async () => {
    const container = await renderSettings()

    expect(container.textContent).not.toContain('Tools policy')
    expect(container.textContent).not.toContain('Global policy')
    expect(mocks.getToolsPolicy).not.toHaveBeenCalled()
    expect(mocks.saveToolsPolicy).not.toHaveBeenCalled()
  })

  it('шлюз безопасности и защищённые пути остаются на месте', async () => {
    const container = await renderSettings()

    expect(container.textContent).toContain('Security gateway')
    expect(container.textContent).toContain('Protected paths')
  })
})
