import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

// Панели настроек не рендерим — тест про видимость раздела в списке.
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => <div>appearance-page</div> }))
vi.mock('./ProfileSettings', () => ({ ProfileSettings: () => <div>profile-page</div> }))
vi.mock('./NotificationSettings', () => ({ NotificationSettings: () => <div>notifications-page</div> }))
vi.mock('./ChatSettings', () => ({ ChatSettings: () => <div>chat-page</div> }))
vi.mock('./RoutingSettings', () => ({ RoutingSettings: () => <div>routing-page</div> }))
vi.mock('./SecuritySettings', () => ({ SecuritySettings: () => <div>security-page</div> }))
vi.mock('./NetworkSettings', () => ({ NetworkSettings: () => <div>network-page</div> }))
vi.mock('./McpUserSettings', () => ({ McpUserSettings: () => <div>mcp-page</div> }))
vi.mock('./McpAdminSettings', () => ({ McpAdminSettings: () => <div>mcp-admin-page</div> }))
vi.mock('./ToolsDisabledSettings', () => ({ ToolsDisabledSettings: () => <div>tools-page</div> }))
vi.mock('./SkillsUserSettings', () => ({ SkillsUserSettings: () => <div>skills-page</div> }))
vi.mock('./SkillsAdminSettings', () => ({ SkillsAdminSettings: () => <div>skills-admin-page</div> }))
vi.mock('./CommandsSettings', () => ({ CommandsSettings: () => <div>commands-page</div> }))
vi.mock('./EventsAdminSettings', () => ({ EventsAdminSettings: () => <div>events-page</div> }))
vi.mock('./EventsSettings', () => ({ EventsSettings: () => <div>events-config-page</div> }))
vi.mock('./DecisionSettings', () => ({ DecisionSettings: () => <div>decision-page</div> }))
vi.mock('./ServiceKeysSettings', () => ({ ServiceKeysSettings: () => <div>service-keys-page</div> }))
vi.mock('./WebhooksSettings', () => ({ WebhooksSettings: () => <div>webhooks-page</div> }))
vi.mock('./MaintenanceSettings', () => ({ MaintenanceSettings: () => <div>maintenance-page</div> }))
vi.mock('./ObservabilitySettings', () => ({ ObservabilitySettings: () => <div>metrics-page</div> }))
vi.mock('./MultimodalSettings', () => ({ MultimodalSettings: () => <div>attachments-page</div> }))
vi.mock('./MemorySettings', () => ({ MemorySettings: () => <div>memory-page</div> }))
vi.mock('../admin/ContextManagementSettings', () => ({
  ContextManagementSettings: () => <div>context-management-page</div>,
}))
vi.mock('../admin/AgentsLimitsSettings', () => ({
  AgentsLimitsSettings: () => <div>agents-limits-page</div>,
}))
vi.mock('../admin/DashboardPanel', () => ({ DashboardPanel: () => <div>dashboard-page</div> }))
vi.mock('../admin/SessionsPanel', () => ({ SessionsPanel: () => <div>sessions-page</div> }))
vi.mock('../admin/ProjectsPanel', () => ({ ProjectsPanel: () => <div>projects-page</div> }))
vi.mock('../admin/ProvidersPanel', () => ({ ProvidersPanel: () => <div>providers-page</div> }))
vi.mock('../admin/ModelsPanel', () => ({ ModelsPanel: () => <div>models-page</div> }))
vi.mock('../admin/AgentsPanel', () => ({ AgentsPanel: () => <div>agents-page</div> }))
vi.mock('../admin/ContextPanel', () => ({ ContextPanel: () => <div>context-page</div> }))
vi.mock('../admin/UsersPanel', () => ({ UsersPanel: () => <div>users-page</div> }))
vi.mock('../admin/DefaultsPanel', () => ({ DefaultsPanel: () => <div>defaults-page</div> }))
vi.mock('../admin/DebugPanel', () => ({ DebugPanel: () => <div>debug-page</div> }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SettingsModal } from './SettingsModal'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useHybridStore } from '@/stores/hybridStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderModal(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsModal />
      </I18nProvider>,
    )
  })
}

function navText(): string {
  return document.querySelector('nav')?.textContent ?? ''
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({
    isSettingsDialogOpen: true,
    settingsPage: 'appearance',
    settingsShowAdvanced: false,
    settingsFocus: null,
  })
  useAuthStore.setState({ user: { roles: ['ADMIN'] } as never, deployment: null })
  useHybridStore.setState({ enabled: false, connected: false, remoteDegraded: false })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

/**
 * `/api/v2/users*` смонтирован только в managed backend. В standalone раздел
 * «Пользователи» скрыт (иначе он падал бы с 404) — **кроме** режима с
 * подключённым гибридом: там локальный core проксирует `/api/v2/*` на
 * удалённый backend, и эндпоинт работает.
 */
describe('SettingsModal — раздел «Пользователи» и режим развёртывания', () => {
  it('в managed раздел «Пользователи» виден для ADMIN', async () => {
    useAuthStore.setState({ deployment: 'managed' })
    await renderModal()

    expect(navText()).toContain('Users')
  })

  it('в чистом standalone раздел не виден даже для ADMIN', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    await renderModal()

    expect(navText()).not.toContain('Users')
  })

  it('в standalone с подключённым гибридом раздел виден (эндпоинт проксируется)', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    useHybridStore.setState({ enabled: true, connected: true, remoteDegraded: false })
    await renderModal()

    expect(navText()).toContain('Users')
  })

  it('в standalone с деградировавшим гибридом раздел скрыт', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    useHybridStore.setState({ enabled: true, connected: true, remoteDegraded: true })
    await renderModal()

    expect(navText()).not.toContain('Users')
  })

  it('при неизвестном deployment раздел скрыт (fail-closed, без «мигания»)', async () => {
    useAuthStore.setState({ deployment: null })
    await renderModal()

    expect(navText()).not.toContain('Users')
  })

  it('в standalone раздел не находится и поиском — открыть его нельзя', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'users')
    })

    expect(document.querySelector('[data-testid="settings-search-category-users"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-search-entry-users.new"]')).toBeNull()
  })

  it('в standalone с гибридом раздел находится поиском и открывается', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    useHybridStore.setState({ enabled: true, connected: true, remoteDegraded: false })
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'users')
    })

    const category = document.querySelector(
      '[data-testid="settings-search-category-users"]',
    ) as HTMLButtonElement
    expect(category).not.toBeNull()

    await act(async () => {
      category.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('users')
    expect(document.body.textContent).toContain('users-page')
  })

  it('в managed раздел находится поиском и открывается', async () => {
    useAuthStore.setState({ deployment: 'managed' })
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'users')
    })

    const category = document.querySelector(
      '[data-testid="settings-search-category-users"]',
    ) as HTMLButtonElement
    expect(category).not.toBeNull()

    await act(async () => {
      category.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('users')
    expect(document.body.textContent).toContain('users-page')
  })

  it('в standalone сохранённый settingsPage=users не открывает раздел', async () => {
    useAuthStore.setState({ deployment: 'standalone' })
    useUIStore.setState({ settingsPage: 'users' })
    await renderModal()

    expect(document.body.textContent).not.toContain('users-page')
  })
})
