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

// Панели настроек не рендерим — тест про навигацию и поиск.
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
vi.mock('./MemorySettings', () => ({ MemorySettings: () => <div>memory-page</div> }))
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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderModal(): Promise<HTMLElement> {
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
  return container
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
  useAuthStore.setState({ user: { roles: ['ADMIN'] } as never })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

describe('SettingsModal — группы и роли', () => {
  it('ADMIN видит админские группы в порядке «Обзор → AI → Интеграции → Эксплуатация»', async () => {
    await renderModal()

    const text = navText()
    expect(text).toContain('Overview')
    expect(text).toContain('AI & models')
    expect(text).toContain('Integrations')
    expect(text).toContain('Operations')

    expect(text.indexOf('Overview')).toBeLessThan(text.indexOf('AI & models'))
    expect(text.indexOf('AI & models')).toBeLessThan(text.indexOf('Integrations'))
    expect(text.indexOf('Integrations')).toBeLessThan(text.indexOf('Operations'))
  })

  it('USER видит личные категории без админских групп', async () => {
    useAuthStore.setState({ user: { roles: ['USER'] } as never })
    await renderModal()

    const text = navText()
    expect(text).toContain('Appearance')
    expect(text).toContain('Skills')
    expect(text).not.toContain('Overview')
    expect(text).not.toContain('AI & models')
    expect(text).not.toContain('Integrations')
    expect(text).not.toContain('Operations')
    expect(text).not.toContain('Providers')
  })
})

describe('SettingsModal — режим «Расширенные»', () => {
  it('по умолчанию скрывает advanced-категории, тумблер их показывает', async () => {
    await renderModal()

    expect(navText()).not.toContain('Decision models')
    expect(navText()).not.toContain('Metrics')
    expect(navText()).not.toContain('Debug')
    expect(navText()).not.toContain('System appearance')

    const toggle = document.querySelector(
      '[data-testid="settings-advanced-toggle"]',
    ) as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(navText()).toContain('Decision models')
    expect(navText()).toContain('Metrics')
    expect(navText()).toContain('Debug')
    expect(navText()).toContain('System appearance')
  })

  it('скрытая активная страница заменяется первой доступной и возвращается после включения', async () => {
    useUIStore.setState({ settingsPage: 'metrics' })
    await renderModal()

    const firstActive = document.querySelector('button[aria-current="page"]')
    expect(firstActive?.textContent).toContain('Profile')

    const toggle = document.querySelector(
      '[data-testid="settings-advanced-toggle"]',
    ) as HTMLButtonElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const activeAfterToggle = document.querySelector('button[aria-current="page"]')
    expect(activeAfterToggle?.textContent).toContain('Metrics')
  })
})

describe('SettingsModal — поиск', () => {
  it('находит категорию и секцию, клик по секции меняет страницу и ставит фокус', async () => {
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'proxy')
    })

    expect(document.querySelector('[data-testid="settings-search-results"]')).not.toBeNull()
    expect(
      document.querySelector('[data-testid="settings-search-category-network"]'),
    ).not.toBeNull()
    const entry = document.querySelector(
      '[data-testid="settings-search-entry-network.proxy"]',
    ) as HTMLButtonElement
    expect(entry).not.toBeNull()
    expect(entry.textContent).toContain('Section:')
    expect(entry.textContent).toContain('Network')

    await act(async () => {
      entry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('network')
    expect(useUIStore.getState().settingsFocus).toMatchObject({
      categoryId: 'network',
      sectionId: 'network-proxy',
    })
    expect(useUIStore.getState().settingsFocus?.nonce).toBe(1)
    expect((document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement).value).toBe('')
  })

  it('клик по категории в результатах меняет settingsPage', async () => {
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'routing')
    })

    const category = document.querySelector(
      '[data-testid="settings-search-category-routing"]',
    ) as HTMLButtonElement
    expect(category).not.toBeNull()

    await act(async () => {
      category.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('routing')
  })

  it('пустой результат показывает подсказку, а не пустой список', async () => {
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'zzzz-no-such-setting')
    })

    expect(document.querySelector('[data-testid="settings-search-results"]')?.textContent).toContain(
      'Nothing found',
    )
  })

  it('находит скрытую advanced-категорию и при выборе включает режим «Расширенные»', async () => {
    await renderModal()

    // До поиска advanced-категория скрыта из сайдбара.
    expect(navText()).not.toContain('Debug')

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'debug')
    })

    const category = document.querySelector(
      '[data-testid="settings-search-category-debug"]',
    ) as HTMLButtonElement
    expect(category).not.toBeNull()

    await act(async () => {
      category.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('debug')
    expect(useUIStore.getState().settingsShowAdvanced).toBe(true)
  })

  it('находит скрытую advanced-секцию и при выборе включает режим «Расширенные»', async () => {
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'webhooks')
    })

    const entry = document.querySelector(
      '[data-testid="settings-search-entry-webhooks.list"]',
    ) as HTMLButtonElement
    expect(entry).not.toBeNull()

    await act(async () => {
      entry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().settingsPage).toBe('webhooks')
    expect(useUIStore.getState().settingsShowAdvanced).toBe(true)
  })

  it('не показывает в поиске категории, недоступные роли', async () => {
    useAuthStore.setState({ user: { roles: ['USER'] } as never })
    await renderModal()

    const input = document.querySelector('[data-testid="settings-search-input"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(input, 'debug')
    })

    expect(document.querySelector('[data-testid="settings-search-category-debug"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-search-results"]')?.textContent).toContain(
      'Nothing found',
    )
  })

  it('обычные кнопки сайдбара получают title с полной подписью', async () => {
    await renderModal()

    const appearance = [...document.querySelectorAll('nav button')].find(
      (button) => button.getAttribute('aria-current') === 'page',
    )
    expect(appearance?.getAttribute('title')).toBe('Appearance')
  })
})
