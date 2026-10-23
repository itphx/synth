import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
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
  listPlugins: vi.fn(),
  getPlugin: vi.fn(),
  installPlugin: vi.fn(),
  approvePlugin: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  removePlugin: vi.fn(),
  updatePlugin: vi.fn(),
  rollbackPlugin: vi.fn(),
  getPluginsSettings: vi.fn(),
  updatePluginsSettings: vi.fn(),
  resetPluginsSettings: vi.fn(),
  restartInstance: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PluginsSettings, buildInstallInput, inferInstallSource, shortHash } from './PluginsSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PLUGIN = {
  name: 'demo-plugin',
  version: '1.2.3',
  source: 'npm',
  trustLevel: 'trusted' as const,
  scanVerdict: 'safe' as const,
  contentHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  installedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
  active: false,
  serverPolicy: 'allowed' as const,
}

const MANAGED_PLUGIN = {
  ...PLUGIN,
  name: 'image-plugin',
  version: '2.0.0',
  source: 'deploy',
  trustLevel: 'trusted' as const,
  active: true,
  mode: 'inline' as const,
}

const POLICY_DEFAULTS = {
  enabled: true,
  executionEnabled: false,
  runtimeInstall: 'deny' as const,
  trustFloor: 'trusted' as const,
  scan: 'enabled' as const,
  promptBlockMaxChars: 4000,
  llmFilterTimeoutMs: 1000,
}

const SETTINGS = {
  plugins: {},
  defaults: POLICY_DEFAULTS,
  isOverridden: false,
  restartRequired: true,
  running: POLICY_DEFAULTS,
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
  await flush()
}

/** Ввод в контролируемое поле: React слушает нативный `input`. */
async function typeInto(container: HTMLElement, testId: string, value: string): Promise<void> {
  const el = byTestId(container, testId) as HTMLInputElement | null
  expect(el, `поле ${testId}`).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function renderSettings(roles: string[] = ['ADMIN']): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  useAuthStore.setState({
    user: {
      id: 'user',
      username: 'user',
      email: null,
      roles,
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <PluginsSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listPlugins.mockResolvedValue([])
  mocks.getPluginsSettings.mockResolvedValue(SETTINGS)
  mocks.enablePlugin.mockResolvedValue({ activation: { outcome: 'activated' } })
  mocks.disablePlugin.mockResolvedValue({ deactivation: { outcome: 'deactivated' } })
  mocks.removePlugin.mockResolvedValue(undefined)
  mocks.approvePlugin.mockResolvedValue({
    outcome: 'installed',
    name: 'quarantined-plugin',
    version: '0.1.0',
  })
  mocks.updatePlugin.mockResolvedValue({
    outcome: 'unchanged',
    name: 'demo-plugin',
    version: '1.2.3',
    contentHash: PLUGIN.contentHash,
  })
  mocks.rollbackPlugin.mockResolvedValue({
    outcome: 'rolled_back',
    name: 'demo-plugin',
    version: '1.2.2',
    previousVersion: '1.2.3',
  })
  mocks.installPlugin.mockResolvedValue({
    outcome: 'installed',
    name: 'demo-plugin',
    version: '1.2.3',
  })
  mocks.confirm.mockResolvedValue(true)
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('PluginsSettings — вспомогательные функции', () => {
  it('короткий хеш обрезается до 12 символов', () => {
    expect(shortHash('abcdef0123456789')).toBe('abcdef012345…')
    expect(shortHash('abc')).toBe('abc')
  })

  it('вид источника выводится по строке ввода', () => {
    expect(inferInstallSource('https://example.com/p.tgz')).toBe('url')
    expect(inferInstallSource('/tmp/plugin')).toBe('dir')
    expect(inferInstallSource('/tmp/plugin.tgz')).toBe('archive')
    expect(inferInstallSource('@scope/plugin')).toBe('npm')
    expect(inferInstallSource('plugin-name')).toBe('npm')
  })

  it('тело установки собирается по виду источника', () => {
    expect(buildInstallInput('/tmp/plugin', 'community')).toEqual({
      source: 'dir',
      path: '/tmp/plugin',
      trustLevel: 'community',
    })
    expect(buildInstallInput('plugin-name', 'trusted')).toEqual({
      source: 'npm',
      name: 'plugin-name',
      trustLevel: 'trusted',
    })
    expect(buildInstallInput('https://example.com/p.tgz', 'verified', 'AB'.repeat(32))).toEqual({
      source: 'url',
      url: 'https://example.com/p.tgz',
      sha256: 'ab'.repeat(32),
      trustLevel: 'verified',
    })
  })
})

describe('PluginsSettings — список плагинов', () => {
  it('показывает имя, версию, доверие, вердикт скана, активность и хеш', async () => {
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings()

    expect(mocks.listPlugins).toHaveBeenCalled()
    expect(byTestId(container, 'plugins-empty')).toBeNull()

    const item = byTestId(container, 'plugins-item-demo-plugin')
    expect(item).toBeTruthy()
    const text = item?.textContent ?? ''
    expect(text).toContain('demo-plugin')
    expect(text).toContain('1.2.3')
    expect(text).toContain('npm')

    expect(byTestId(container, 'plugins-trust-demo-plugin')?.textContent).toBe('trusted')
    expect(byTestId(container, 'plugins-scan-demo-plugin')?.textContent).toBe('safe')
    expect(byTestId(container, 'plugins-active-demo-plugin')?.textContent).toBe('disabled')
    expect(text).toContain('abcdef012345')
  })

  it('пустой реестр — пустое состояние', async () => {
    const container = await renderSettings()

    expect(byTestId(container, 'plugins-list')).toBeNull()
    expect(byTestId(container, 'plugins-empty')).toBeTruthy()
  })

  it('серверная политика гибрида: бейдж статуса, подсказка только для unverified', async () => {
    mocks.listPlugins.mockResolvedValue([
      { ...PLUGIN, serverPolicy: 'allowed' },
      { ...PLUGIN, name: 'denied-plugin', serverPolicy: 'denied' },
      { ...PLUGIN, name: 'unverified-plugin', serverPolicy: 'unverified' },
    ])
    const container = await renderSettings()

    expect(byTestId(container, 'plugins-server-policy-demo-plugin')?.textContent).toBe(
      'allowed by the server',
    )
    expect(byTestId(container, 'plugins-server-policy-denied-plugin')?.textContent).toBe(
      'denied by the server',
    )
    expect(byTestId(container, 'plugins-server-policy-unverified-plugin')?.textContent).toBe(
      'not verified by the server',
    )
    // Пояснение про cooperative-режим — только там, где сервер не подтвердил.
    expect(byTestId(container, 'plugins-server-policy-hint-unverified-plugin')).toBeTruthy()
    expect(byTestId(container, 'plugins-server-policy-hint-demo-plugin')).toBeNull()
  })

  it('управляемый плагин помечен и не получает кнопку снятия', async () => {
    mocks.listPlugins.mockResolvedValue([MANAGED_PLUGIN])
    const container = await renderSettings()

    expect(byTestId(container, 'plugins-managed-image-plugin')?.textContent).toBe('managed')
    expect(byTestId(container, 'plugins-managed-hint-image-plugin')).toBeTruthy()
    expect(byTestId(container, 'plugins-remove-image-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-update-image-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-disable-image-plugin')).toBeTruthy()
    expect(byTestId(container, 'plugins-active-image-plugin')?.textContent).toBe('active')
    expect(byTestId(container, 'plugins-mode-image-plugin')?.textContent).toBe('inline')
  })
})

describe('PluginsSettings — действия', () => {
  it('«Включить» вызывает enable и обновляет список', async () => {
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings()

    await clickTestId(container, 'plugins-enable-demo-plugin')

    expect(mocks.enablePlugin).toHaveBeenCalledWith('demo-plugin')
    expect(mocks.listPlugins.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('«Выключить» вызывает disable для активного плагина', async () => {
    mocks.listPlugins.mockResolvedValue([MANAGED_PLUGIN])
    const container = await renderSettings()

    await clickTestId(container, 'plugins-disable-image-plugin')

    expect(mocks.disablePlugin).toHaveBeenCalledWith('image-plugin')
  })

  it('«Удалить» идёт через confirm() и вызывает API', async () => {
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings()

    await clickTestId(container, 'plugins-remove-demo-plugin')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.removePlugin).toHaveBeenCalledWith('demo-plugin')
  })

  it('отказ в подтверждении не вызывает удаление', async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings()

    await clickTestId(container, 'plugins-remove-demo-plugin')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.removePlugin).not.toHaveBeenCalled()
  })

  it('«Обновить» вызывает update и обновляет список', async () => {
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings()

    await clickTestId(container, 'plugins-update-demo-plugin')

    expect(mocks.updatePlugin).toHaveBeenCalledWith({ name: 'demo-plugin' })
    expect(mocks.listPlugins.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('PluginsSettings — установка', () => {
  it('не-ADMIN не видит мутаций (установка, включение, удаление, сохранение)', async () => {
    mocks.listPlugins.mockResolvedValue([PLUGIN])
    const container = await renderSettings(['USER'])

    // Список доступен на чтение.
    expect(byTestId(container, 'plugins-item-demo-plugin')).toBeTruthy()

    expect(byTestId(container, 'plugins-install-submit')).toBeNull()
    expect(byTestId(container, 'plugins-enable-demo-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-disable-demo-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-remove-demo-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-update-demo-plugin')).toBeNull()
    expect(byTestId(container, 'plugins-policy-save')).toBeNull()
  })

  it('ошибка установки показывается текстом из ответа (403 LOCAL_INSTALL_DISABLED)', async () => {
    mocks.installPlugin.mockRejectedValue(
      Object.assign(
        new Error('Установка из локального каталога недоступна в этом режиме инстанса'),
        { status: 403, code: 'LOCAL_INSTALL_DISABLED' },
      ),
    )
    const container = await renderSettings()

    await typeInto(container, 'plugins-install-ref', '/tmp/plugin')
    await clickTestId(container, 'plugins-install-submit')

    expect(mocks.installPlugin).toHaveBeenCalled()
    expect(byTestId(container, 'plugins-install-error')?.textContent).toContain(
      'Установка из локального каталога недоступна',
    )
  })

  it('установка вызывает API с выведенным источником и доверием', async () => {
    const container = await renderSettings()

    await typeInto(container, 'plugins-install-ref', 'plugin-name')
    await clickTestId(container, 'plugins-install-submit')

    expect(mocks.installPlugin).toHaveBeenCalledWith({
      source: 'npm',
      name: 'plugin-name',
      trustLevel: 'community',
    })
    expect(mocks.listPlugins.mock.calls.length).toBeGreaterThan(1)
  })

  it('202 (approval_required) показывает карточку карантина с подтверждением', async () => {
    mocks.installPlugin.mockResolvedValue({
      outcome: 'approval_required',
      name: 'quarantined-plugin',
      version: '0.1.0',
      reason: 'plugin.approval_required',
    })
    const container = await renderSettings()

    await typeInto(container, 'plugins-install-ref', '/tmp/quarantined')
    await clickTestId(container, 'plugins-install-submit')

    expect(byTestId(container, 'plugins-pending-quarantined-plugin')).toBeTruthy()

    await clickTestId(container, 'plugins-approve-quarantined-plugin')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.approvePlugin).toHaveBeenCalledWith('quarantined-plugin')
  })
})

describe('PluginsSettings — политика слоя', () => {
  it('показывает restartRequired и значения политики', async () => {
    const container = await renderSettings()

    expect(mocks.getPluginsSettings).toHaveBeenCalled()
    expect(byTestId(container, 'plugins-restart')).toBeTruthy()

    const promptBlock = byTestId(container, 'plugins-policy-prompt-block') as HTMLInputElement
    expect(promptBlock.value).toBe('4000')
    const filterTimeout = byTestId(
      container,
      'plugins-policy-llm-filter-timeout',
    ) as HTMLInputElement
    expect(filterTimeout.value).toBe('1000')
  })

  it('ошибка загрузки политики показывается в секции', async () => {
    mocks.getPluginsSettings.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    )
    const container = await renderSettings()

    expect(byTestId(container, 'plugins-settings-error')?.textContent).toBe(
      'Administrator rights are required to view this section.',
    )
  })

  it('сброс политики идёт через confirm() и DELETE', async () => {
    mocks.getPluginsSettings.mockResolvedValue({ ...SETTINGS, isOverridden: true })
    mocks.resetPluginsSettings.mockResolvedValue(SETTINGS)
    const container = await renderSettings()

    await clickTestId(container, 'plugins-policy-reset')

    expect(mocks.confirm).toHaveBeenCalled()
    expect(mocks.resetPluginsSettings).toHaveBeenCalled()
  })
})
