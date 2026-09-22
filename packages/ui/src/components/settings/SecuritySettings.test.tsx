import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getLlmGatewaySettingsInfo: vi.fn(),
  saveLlmGatewaySettings: vi.fn(),
  resetLlmGatewaySettings: vi.fn(),
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
  mocks.getLlmGatewaySettingsInfo.mockResolvedValue({
    settings: { enabled: false, inputMode: 'obfuscate', logPayloads: false },
    isOverridden: false,
    defaults: {
      enabled: false,
      inputMode: 'obfuscate',
      logPayloads: false,
      rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    },
  })
  mocks.resetLlmGatewaySettings.mockResolvedValue({
    enabled: false,
    inputMode: 'obfuscate',
    logPayloads: false,
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
  })
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

describe('SecuritySettings — миграция на Settings UI Kit (AD-072)', () => {
  it('каркас — SettingsPanel с единственным scroll-контейнером и без pr-2', async () => {
    const container = await renderSettings()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
  })

  it('числовые поля — NumberField (w-full sm:w-24), без legacy w-20', async () => {
    const container = await renderSettings()

    const numbers = container.querySelectorAll('input[type="number"]')
    // rateLimit user/provider + askTimeoutSec
    expect(numbers.length).toBeGreaterThanOrEqual(3)
    numbers.forEach((input) => {
      expect(input.classList.contains('sm:w-24')).toBe(true)
      expect(input.classList.contains('w-20')).toBe(false)
    })
    expect(container.innerHTML).not.toContain('w-20')
  })

  it('Save/Cancel/Reset шлюза гаснут на дефолте и активируются при изменениях; Reset дёргает API', async () => {
    const container = await renderSettings()

    const save = () =>
      container.querySelector('[data-testid="security-gateway-save"]') as HTMLButtonElement
    const cancel = () =>
      container.querySelector('[data-testid="security-gateway-cancel"]') as HTMLButtonElement
    const reset = () =>
      container.querySelector('[data-testid="security-gateway-reset"]') as HTMLButtonElement
    expect(save()).not.toBeNull()

    // Сервер вернул дефолтные настройки → Save/Cancel неактивны, Reset серый и disabled.
    expect(save().disabled).toBe(true)
    expect(cancel().disabled).toBe(true)
    expect(reset().disabled).toBe(true)
    expect(reset().className).toContain('border-muted-foreground')

    // Меняем настройку шлюза — появляется dirty: Save/Cancel активны, Reset цветная.
    const gatewayToggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      gatewayToggle.click()
    })
    expect(save().disabled).toBe(false)
    expect(cancel().disabled).toBe(false)
    expect(reset().disabled).toBe(false)
    expect(reset().className).toContain('border-primary')

    await act(async () => {
      reset().click()
    })

    expect(mocks.resetLlmGatewaySettings).toHaveBeenCalledTimes(1)
    // Reset вернул дефолт в черновик → Save/Cancel снова неактивны.
    expect(save().disabled).toBe(true)
    expect(cancel().disabled).toBe(true)
  })

  it('Reset паттернов и защищённых путей серый на дефолте и цветной при override', async () => {
    const container = await renderSettings()
    const patternsReset = () =>
      container.querySelector('[data-testid="security-patterns-reset"]') as HTMLButtonElement
    const protectedReset = () =>
      container.querySelector('[data-testid="security-protected-reset"]') as HTMLButtonElement

    // isOverridden=false → настройки базовые → Reset серые и disabled.
    expect(patternsReset().disabled).toBe(true)
    expect(patternsReset().className).toContain('border-muted-foreground')
    expect(protectedReset().disabled).toBe(true)
    expect(protectedReset().className).toContain('border-muted-foreground')

    // Сервер сообщает об override → Reset цветные и активные.
    mocks.getGatewayPatterns.mockResolvedValue({
      patterns: [{ type: 'api_key', regex: 'sk-\\w+' }],
      isOverridden: true,
    })
    mocks.getProtectedPaths.mockResolvedValue({
      policy: { deniedPaths: ['/etc'], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] },
      isOverridden: true,
    })
    const overridden = await renderSettings()
    const patternsReset2 =
      overridden.querySelector('[data-testid="security-patterns-reset"]') as HTMLButtonElement
    const protectedReset2 =
      overridden.querySelector('[data-testid="security-protected-reset"]') as HTMLButtonElement

    expect(patternsReset2.disabled).toBe(false)
    expect(patternsReset2.className).toContain('border-primary')
    expect(protectedReset2.disabled).toBe(false)
    expect(protectedReset2.className).toContain('border-primary')
  })

  it('списки защищённых путей рендерятся через ListField', async () => {
    const container = await renderSettings()

    for (const label of [
      'Denied paths (exact match)',
      'Denied directory prefixes',
      'Paths requiring confirmation (ask)',
      'Denied command prefixes (shell only)',
    ]) {
      expect(container.textContent).toContain(label)
    }
    // Каждый ListField даёт минимум одно текстовое поле ввода.
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(4)
  })
})
