import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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

const mocks = vi.hoisted(() => ({
  getOAuthCredentials: vi.fn(),
  getOAuthCredential: vi.fn(),
  createOAuthCredential: vi.fn(),
  refreshOAuthCredential: vi.fn(),
  deleteOAuthCredential: vi.fn(),
  bindOAuthCredential: vi.fn(),
  notify: vi.fn(),
}))

// Реестр MCP-серверов — источник выбора коннектора для привязки (ADR-105 Ф3).
const mcpStore = vi.hoisted(() => ({
  registry: [] as Array<{ id: string; name: string }>,
  fetchRegistry: vi.fn(async () => {}),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))
vi.mock('@/stores/mcpStore', () => ({
  useMcpStore: (selector: (s: typeof mcpStore) => unknown) => selector(mcpStore),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CredentialsSettings, parseScopesInput } from './CredentialsSettings'
import type { ExternalCredentialMeta } from '@itphx/synth-shared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const ACTIVE: ExternalCredentialMeta = {
  id: 'extc_1',
  provider: 'github',
  connectorId: 'mcp_1',
  clientId: 'client-abc',
  scopes: ['repo', 'read:user'],
  owner: { kind: 'user', id: 'u1' },
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  createdBy: 'u1',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: '2026-10-10T12:00:00.000Z',
  secretMask: 'mask:0123456789abcdef',
  hasRefreshToken: true,
}

const FAILED: ExternalCredentialMeta = {
  ...ACTIVE,
  id: 'extc_2',
  provider: 'gitlab',
  clientId: 'client-def',
  scopes: ['api'],
  status: 'error',
  expiresAt: undefined,
  lastUsedAt: undefined,
  secretMask: 'mask:fedcba9876543210',
  hasRefreshToken: false,
}

const REVOKED: ExternalCredentialMeta = {
  ...ACTIVE,
  id: 'extc_3',
  provider: 'bitbucket',
  status: 'revoked',
  secretMask: 'mask:0000000000000000',
}

const clickTestId = async (container: HTMLElement, testId: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
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
        <TooltipProvider>
          <CredentialsSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mcpStore.registry = []
  mocks.getOAuthCredentials.mockResolvedValue({
    credentials: [ACTIVE, FAILED, REVOKED],
    count: 3,
  })
  mocks.refreshOAuthCredential.mockResolvedValue({ credential: ACTIVE })
  mocks.deleteOAuthCredential.mockResolvedValue({
    credential: { ...ACTIVE, status: 'revoked' },
    providerRevoked: true,
  })
  mocks.bindOAuthCredential.mockResolvedValue({
    credentialId: 'extc_1',
    connectorId: 'mcp_1',
    bound: true,
  })
  vi.mocked(confirm).mockResolvedValue(true)
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

describe('CredentialsSettings — раздел «Доступы» (ADR-105 Ф4)', () => {
  it('загружает доступы и рендерит заголовок/описание/счётчик', async () => {
    const container = await renderSettings()

    expect(mocks.getOAuthCredentials).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Accesses')
    expect(container.textContent).toContain('External accesses to OAuth connectors')
    expect(container.querySelector('[data-testid="settings-header-meta"]')!.textContent).toContain('3 accesses')
  })

  it('показывает провайдера, clientId, scope, статус, срок и маску секрета', async () => {
    const container = await renderSettings()

    const item = container.querySelector('[data-testid="credentials-item-extc_1"]')!
    expect(item.textContent).toContain('github')
    expect(item.textContent).toContain('client-abc')
    expect(item.textContent).toContain('repo')
    expect(item.textContent).toContain('read:user')
    expect(item.textContent).toContain('mask:0123456789abcdef')
    expect(item.textContent).toContain('Last used')
    // Статус «active» — бейдж.
    expect(container.querySelector('[data-testid="credentials-status-active"]')!.textContent).toContain(
      'active',
    )
  })

  it('токен не отображается: в DOM нет ни access-, ни refresh-токена', async () => {
    // Даже если сервер-ответ содержал бы секретные поля, UI их не рендерит.
    const leaked = {
      ...ACTIVE,
      accessToken: 'ya29.super-secret-access-token',
      refreshToken: 'ghr_super-secret-refresh-token',
      secretEnc: 'enc:v1:iv:tag:ciphertext',
    } as unknown as ExternalCredentialMeta
    mocks.getOAuthCredentials.mockResolvedValue({ credentials: [leaked], count: 1 })

    const container = await renderSettings()
    const html = container.innerHTML

    expect(html).not.toContain('ya29.super-secret-access-token')
    expect(html).not.toContain('ghr_super-secret-refresh-token')
    expect(html).not.toContain('enc:v1:iv:tag:ciphertext')
    // Показывается только маска.
    expect(container.textContent).toContain('mask:0123456789abcdef')
  })

  it('статус error даёт кнопку переавторизации, refresh дёргает API', async () => {
    const container = await renderSettings()

    const refresh = container.querySelector('[data-testid="credentials-refresh-extc_2"]')
    expect(refresh, 'кнопка переавторизации для статуса error').toBeTruthy()

    await clickTestId(container, 'credentials-refresh-extc_2')
    await act(async () => {})

    expect(mocks.refreshOAuthCredential).toHaveBeenCalledWith('extc_2')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('отзыв доступа идёт через ConfirmDialog и вызывает DELETE', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'credentials-revoke-extc_1')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    const options = vi.mocked(confirm).mock.calls[0][0]
    expect(options.title).toBe(enDict['credentials.revokeTitle'])
    expect(options.variant).toBe('danger')
    expect(mocks.deleteOAuthCredential).toHaveBeenCalledWith('extc_1')
  })

  it('отказ в подтверждении отменяет отзыв', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    const container = await renderSettings()

    await clickTestId(container, 'credentials-revoke-extc_1')
    await act(async () => {})

    expect(mocks.deleteOAuthCredential).not.toHaveBeenCalled()
  })

  it('кнопка привязки скрыта, когда реестр MCP пуст', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="credentials-bind-extc_1"]')).toBeNull()
  })

  it('привязка к коннектору выбирает сервер из реестра и зовёт bind', async () => {
    mcpStore.registry = [{ id: 'mcp_1', name: 'GitHub MCP' }]
    const container = await renderSettings()

    const bindButton = container.querySelector('[data-testid="credentials-bind-extc_1"]')
    expect(bindButton, 'кнопка привязки доступна при непустом реестре').toBeTruthy()

    await clickTestId(container, 'credentials-bind-extc_1')
    await act(async () => {})

    const select = container.querySelector(
      '[data-testid="credentials-bind-select-extc_1"]',
    ) as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.textContent).toContain('GitHub MCP')

    await act(async () => {
      select.value = 'mcp_1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await clickTestId(container, 'credentials-bind-submit-extc_1')
    await act(async () => {})

    expect(mocks.bindOAuthCredential).toHaveBeenCalledWith('extc_1', 'mcp_1')
  })

  it('ошибка 403 при загрузке показывается понятным текстом', async () => {
    mocks.getOAuthCredentials.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' }),
    )
    const container = await renderSettings()

    const alert = container.querySelector('[data-testid="credentials-load-error"]')!
    expect(alert.textContent).toContain(enDict['credentials.errors.forbidden'])
  })

  it('форма выдачи: без провайдера запрос не уходит', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'credentials-add')
    await clickTestId(container, 'credentials-create-save')
    await act(async () => {})

    expect(mocks.createOAuthCredential).not.toHaveBeenCalled()
    const form = container.querySelector('[data-testid="credentials-form"]')!
    expect(form.textContent).toContain(enDict['credentials.form.providerRequired'])
  })

  it('PKCE: показывается ссылка авторизации, затем код подтверждает выдачу', async () => {
    mocks.createOAuthCredential
      .mockResolvedValueOnce({
        flow: 'started',
        state: 'st_1',
        authorizationUrl: 'https://provider.example/authorize?client_id=abc',
      })
      .mockResolvedValueOnce({ flow: 'completed', credential: ACTIVE })

    const container = await renderSettings()

    await clickTestId(container, 'credentials-add')
    const provider = container.querySelector('[data-testid="credentials-provider"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(provider, 'github')
      provider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickTestId(container, 'credentials-create-save')
    await act(async () => {})

    const link = container.querySelector('[data-testid="credentials-authorization-url"]')!
    expect(link.textContent).toContain('https://provider.example/authorize')
    // Секрет в ссылке авторизации — обычный PKCE- challenge, не токен.
    expect(container.textContent).not.toContain('access_token')

    const code = container.querySelector('[data-testid="credentials-code"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(code, 'auth-code-1')
      code.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickTestId(container, 'credentials-code-submit')
    await act(async () => {})

    expect(mocks.createOAuthCredential).toHaveBeenCalledTimes(2)
    expect(mocks.createOAuthCredential).toHaveBeenLastCalledWith({
      provider: 'github',
      flow: 'authorize',
      code: 'auth-code-1',
      state: 'st_1',
    })
    expect(mocks.getOAuthCredentials).toHaveBeenCalledTimes(2)
  })

  it('device flow: показываются код провайдера и адрес подтверждения', async () => {
    mocks.createOAuthCredential.mockResolvedValueOnce({
      flow: 'started',
      state: 'st_dev',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://provider.example/device',
    })

    const container = await renderSettings()

    await clickTestId(container, 'credentials-add')
    const provider = container.querySelector('[data-testid="credentials-provider"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(provider, 'github')
      provider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickTestId(container, 'credentials-create-save')
    await act(async () => {})

    const device = container.querySelector('[data-testid="credentials-device"]')!
    expect(device.textContent).toContain('WDJB-MJHT')
    const uri = container.querySelector('[data-testid="credentials-device-uri"]')!
    expect(uri.textContent).toContain('https://provider.example/device')
  })

  it('parseScopesInput разбирает список scope через запятую и пробелы', () => {
    expect(parseScopesInput('repo, read:user  admin')).toEqual(['repo', 'read:user', 'admin'])
    expect(parseScopesInput('  ')).toEqual([])
  })

  it('секция помечена для мобильных touch-таргетов ≥40px', async () => {
    // Маркер `credentials-panel` — якорь правил `styles/index.css`: кнопки,
    // поля и нативный select раздела «Доступы» ≥40px в мобильных зонах.
    const container = await renderSettings()

    const section = container.querySelector('[data-settings-section="credentials-list"]')
    expect(section?.className).toContain('credentials-panel')
  })

  it('ru-словарь содержит ключи раздела', () => {
    expect(ruDict['settings.category.credentials']).toBe('Доступы')
    expect(ruDict['credentials.title']).toBe('Доступы')
  })
})
