import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getProxy: vi.fn(),
  saveProxy: vi.fn(),
  resetProxy: vi.fn(),
  setProxyPassword: vi.fn(),
  clearProxyPassword: vi.fn(),
  checkProxy: vi.fn(),
  getTls: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { CATEGORIES, resolveActiveSettingsPage } from './SettingsModal'
import { NetworkSettings } from './NetworkSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const STATUS = {
  enabled: true,
  source: 'config' as const,
  url: 'http://proxy.local:3128',
  noProxy: [],
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
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
        <NetworkSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProxy.mockResolvedValue({
    ...STATUS,
    saved: STATUS,
    running: STATUS,
    isOverridden: false,
    defaults: STATUS,
    password: { source: 'none', set: false, removable: false },
  })
  mocks.getTls.mockResolvedValue({
    status: {
      ca: { source: 'runtime', count: 0, subjects: [] },
      rejectUnauthorized: true,
      mappings: [],
      params: {},
    },
    ca: { source: 'runtime', count: 0, subjects: [] },
    rejectUnauthorized: true,
    mappings: [],
    params: {},
    saved: null,
    running: null,
    defaults: {
      ca: { source: 'none', count: 0, subjects: [] },
      rejectUnauthorized: true,
      mappings: [],
      params: {},
    },
    restartRequired: false,
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
  document.body.innerHTML = ''
})

describe('NetworkSettings — админ-раздел «Сеть»', () => {
  it('рендерит панель «Network»: «Прокси», затем «Доверенные CA (TLS)»', async () => {
    const container = await renderSettings()

    const header = container.querySelector('header')!
    expect(header.textContent).toContain('Network')
    expect(container.textContent).toContain('egress proxy and trusted CAs')

    const proxy = container.querySelector('[data-testid="proxy-status-section"]')!
    const tls = container.querySelector('[data-testid="tls-section"]')!
    expect(proxy).not.toBeNull()
    expect(tls).not.toBeNull()
    expect(container.textContent).toContain('Proxy')
    expect(container.textContent).toContain('Trusted CAs (TLS)')
    expect(
      proxy.compareDocumentPosition(tls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(mocks.getTls).toHaveBeenCalledTimes(1)
  })

  it('категория «network» доступна только ADMIN и стоит сразу после «security»', () => {
    const network = CATEGORIES.find((cat) => cat.id === 'network')
    expect(network).toBeDefined()
    expect(network!.roles).toEqual(['ADMIN'])
    expect(network!.labelKey).toBe('settings.category.network')

    const securityIndex = CATEGORIES.findIndex((cat) => cat.id === 'security')
    expect(CATEGORIES[securityIndex + 1]?.id).toBe('network')
  })

  it('не-ADMIN не видит раздел; сохранённая страница network сбрасывается', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r)))

    expect(visibleFor(['ADMIN']).some((cat) => cat.id === 'network')).toBe(true)
    expect(visibleFor(['USER']).some((cat) => cat.id === 'network')).toBe(false)
    expect(visibleFor(['LEAD']).some((cat) => cat.id === 'network')).toBe(false)

    const visible = visibleFor(['USER'])
    expect(resolveActiveSettingsPage(visible, 'network')).toBe(visible[0].id)
  })

  it('ключи «Сеть» есть в ru/en словарях', () => {
    expect(enDict['settings.category.network']).toBe('Network')
    expect(ruDict['settings.category.network']).toBe('Сеть')
    expect(enDict['network.title']).toBeTruthy()
    expect(ruDict['network.title']).toBeTruthy()
    expect(enDict['network.description']).toBeTruthy()
    expect(ruDict['network.description']).toBeTruthy()
  })
})
