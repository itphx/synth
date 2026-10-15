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
  getServiceKeys: vi.fn(),
  getServiceKeyScopes: vi.fn(),
  getServiceKey: vi.fn(),
  createServiceKey: vi.fn(),
  updateServiceKey: vi.fn(),
  deleteServiceKey: vi.fn(),
  revokeServiceKey: vi.fn(),
  notify: vi.fn(),
}))

// Проектная проекция: список проектов инстанса (ADR-014) для мульти-селекта.
const projectsStore = vi.hoisted(() => ({
  projects: [
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Beta' },
  ],
  loadProjects: vi.fn(async () => {}),
}))

// Роли текущего пользователя (управление service-key — ADMIN).
const authStore = vi.hoisted(() => ({
  user: { id: 'u1', roles: ['ADMIN'] } as { id: string; roles: string[] } | null,
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (s: typeof projectsStore) => unknown) => selector(projectsStore),
}))
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: typeof authStore) => unknown) => selector(authStore),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServiceKeysSettings } from './ServiceKeysSettings'
import { CATEGORIES, resolveActiveSettingsPage } from './SettingsModal'
import type { ServiceApiKey, ServiceApiKeyCreated } from '@itphx/synth-shared'
import { GlobalRole } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

const KEY_ACTIVE: ServiceApiKey = {
  id: 'svk_1',
  label: 'Alpha key',
  description: 'for alpha',
  roles: [GlobalRole.USER],
  scopes: ['events:ingest'],
  allowedProjects: ['p1'],
  rateLimitPerMinute: 30,
  expiresAt: FUTURE,
  createdBy: 'admin',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: '2026-10-10T12:00:00.000Z',
  prefix: 'synth_svc_ab…',
}

const KEY_EXPIRED: ServiceApiKey = {
  id: 'svk_2',
  label: 'Expired key',
  roles: [GlobalRole.LEAD],
  scopes: ['events:*'],
  expiresAt: PAST,
  createdBy: 'admin',
  createdAt: '2026-09-01T10:00:00.000Z',
  prefix: 'synth_svc_cd…',
}

const KEY_REVOKED: ServiceApiKey = {
  id: 'svk_3',
  label: 'Revoked key',
  roles: [],
  scopes: ['sessions:read'],
  revokedAt: '2026-10-05T10:00:00.000Z',
  createdBy: 'admin',
  createdAt: '2026-09-15T10:00:00.000Z',
  prefix: 'synth_svc_ef…',
}

const CREATED: ServiceApiKeyCreated = {
  ...KEY_ACTIVE,
  id: 'svk_new',
  label: 'New key',
  allowedProjects: ['p1'],
  scopes: ['events:ingest'],
  key: 'synth_svc_secret_value',
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
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
          <ServiceKeysSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  authStore.user = { id: 'u1', roles: ['ADMIN'] }
  mocks.getServiceKeys.mockResolvedValue({ keys: [KEY_ACTIVE, KEY_EXPIRED, KEY_REVOKED] })
  // ADR-052: каталог scope'ов/ролей с сервера (по умолчанию — с новыми scopes).
  mocks.getServiceKeyScopes.mockResolvedValue({
    scopes: ['events:ingest', 'events:watch', 'addons:install', 'users:read'],
    families: ['events', 'sessions'],
    roles: ['ADMIN', 'USER', 'LEAD', 'AUDITOR'],
  })
  mocks.createServiceKey.mockResolvedValue(CREATED)
  mocks.updateServiceKey.mockImplementation(async (id: string, patch: unknown) => ({
    ...KEY_ACTIVE,
    id,
    ...(patch as object),
  }))
  mocks.deleteServiceKey.mockResolvedValue(undefined)
  mocks.revokeServiceKey.mockResolvedValue({ ...KEY_ACTIVE, revokedAt: '2026-10-13T00:00:00.000Z' })
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

describe('ServiceKeysSettings — админ-секция «Сервисные ключи» (ADR-052)', () => {
  it('загружает ключи и рендерит заголовок/описание/счётчик', async () => {
    const container = await renderSettings()

    expect(mocks.getServiceKeys).toHaveBeenCalledTimes(1)
    const header = container.querySelector('header')!
    expect(header.textContent).toContain('Service keys')
    expect(container.textContent).toContain('Instance-scoped API keys for external services')
    expect(container.querySelector('[data-testid="settings-header-meta"]')!.textContent).toContain('3 keys')
  })

  it('показывает метаданные ключей (label/prefix/роли/scopes/проекты/статусы)', async () => {
    const container = await renderSettings()

    const item = container.querySelector('[data-testid="service-keys-item-svk_1"]')!
    expect(item.textContent).toContain('Alpha key')
    expect(item.textContent).toContain('synth_svc_ab…')
    expect(item.textContent).toContain('USER')
    expect(item.textContent).toContain('events:ingest')
    expect(item.textContent).toContain('Alpha')
    expect(item.textContent).toContain('30')

    // Статусы: активен / истёк / отозван.
    expect(container.querySelector('[data-testid="service-keys-item-svk_1"]')!.textContent).toContain('Active')
    expect(container.querySelector('[data-testid="service-keys-item-svk_2"]')!.textContent).toContain('Expired')
    expect(container.querySelector('[data-testid="service-keys-item-svk_3"]')!.textContent).toContain('Revoked')

    // lastUsedAt активного ключа.
    expect(item.textContent).toContain('Last used')
  })

  it('требует метку при создании (без запроса к API)', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-add')
    await clickTestId(container, 'service-keys-save')
    await act(async () => {})

    expect(mocks.createServiceKey).not.toHaveBeenCalled()
    const form = container.querySelector('[data-testid="service-keys-form"]')!
    expect(form.textContent).toContain('Label is required')
  })

  it('конфликт метки (409) показывается под полем метки', async () => {
    mocks.createServiceKey.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { status: 409, code: 'CONFLICT' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-add')
    const label = container.querySelector('[data-testid="service-keys-label"]') as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'Duplicate')
    })
    await clickTestId(container, 'service-keys-scope-events-ingest')
    await clickTestId(container, 'service-keys-save')
    await act(async () => {})

    expect(mocks.createServiceKey).toHaveBeenCalledTimes(1)
    const form = container.querySelector('[data-testid="service-keys-form"]')!
    expect(form.textContent).toContain(enDict['errors.conflict.serviceKeyLabel'])
  })

  it('создаёт ключ с мульти-селектами scopes/roles/projects и лимитом', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-add')
    const label = container.querySelector('[data-testid="service-keys-label"]') as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'New key')
    })

    // Мульти-селекты: scope + роль + проект.
    await clickTestId(container, 'service-keys-scope-events-ingest')
    await clickTestId(container, 'service-keys-role-ADMIN')
    await clickTestId(container, 'service-keys-project-p1')

    // aria-pressed отражает выбор.
    expect(
      container.querySelector('[data-testid="service-keys-scope-events-ingest"]')!.getAttribute('aria-pressed'),
    ).toBe('true')

    const rate = container.querySelector('[data-testid="service-keys-rate"]') as HTMLInputElement
    await act(async () => {
      setInputValue(rate, '30')
    })

    await clickTestId(container, 'service-keys-save')
    await act(async () => {})

    expect(mocks.createServiceKey).toHaveBeenCalledTimes(1)
    expect(mocks.createServiceKey).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'New key',
        scopes: ['events:ingest'],
        roles: ['ADMIN'],
        allowedProjects: ['p1'],
        rateLimitPerMinute: 30,
      }),
    )
  })

  it('после создания показывает секрет один раз с curl и копированием', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-add')
    const label = container.querySelector('[data-testid="service-keys-label"]') as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'New key')
    })
    await clickTestId(container, 'service-keys-scope-events-ingest')
    await clickTestId(container, 'service-keys-save')
    await act(async () => {})

    const secret = container.querySelector('[data-testid="service-keys-secret"]')!
    expect(secret.textContent).toContain('synth_svc_secret_value')
    // Секрет по умолчанию не показывается; block появляется только после создания.
    const curl = container.querySelector('[data-testid="service-keys-curl"]')!
    expect(curl.textContent).toContain('/api/v2/projects')
    expect(curl.textContent).toContain('synth_svc_secret_value')

    // Закрытие блока убирает секрет (второй раз недоступен).
    await clickTestId(container, 'service-keys-secret-close')
    expect(container.querySelector('[data-testid="service-keys-secret"]')).toBeNull()
  })

  it('требует хотя бы один scope', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-add')
    const label = container.querySelector('[data-testid="service-keys-label"]') as HTMLInputElement
    await act(async () => {
      setInputValue(label, 'New key')
    })
    await clickTestId(container, 'service-keys-save')
    await act(async () => {})

    expect(mocks.createServiceKey).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="service-keys-form"]')!.textContent).toContain(
      enDict['serviceKeys.scopesRequired'],
    )
  })

  it('отзыв ключа подтверждается и вызывает API', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-revoke-svk_1')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.revokeServiceKey).toHaveBeenCalledWith('svk_1')
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('удаление ключа подтверждается и вызывает API', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-delete-svk_1')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteServiceKey).toHaveBeenCalledWith('svk_1')
  })

  it('редактирование шлёт PATCH с обновлёнными scopes/ролями', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'service-keys-edit-svk_1')
    // Снимем events:ingest, добавим events:watch.
    await clickTestId(container, 'service-keys-edit-scope-svk_1-events-ingest')
    await clickTestId(container, 'service-keys-edit-scope-svk_1-events-watch')
    await clickTestId(container, 'service-keys-edit-role-svk_1-LEAD')
    await clickTestId(container, 'service-keys-edit-save-svk_1')
    await act(async () => {})

    expect(mocks.updateServiceKey).toHaveBeenCalledTimes(1)
    expect(mocks.updateServiceKey).toHaveBeenCalledWith(
      'svk_1',
      expect.objectContaining({
        label: 'Alpha key',
        scopes: ['events:watch'],
      }),
    )
  })

  it('не-ADMIN видит read-only сообщение без кнопок мутаций', async () => {
    authStore.user = { id: 'u2', roles: ['USER'] }
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="service-keys-readonly"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="service-keys-edit-svk_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="service-keys-delete-svk_1"]')).toBeNull()
    // Список всё же доступен для просмотра.
    expect(container.querySelector('[data-testid="service-keys-item-svk_1"]')).not.toBeNull()
  })

  it('показывает ошибку загрузки', async () => {
    mocks.getServiceKeys.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
  })

  // ADR-052: каталог scope'ов/ролей — серверная сущность (не в бандле) + фоллбек.
  it('каталог scope/ролей берётся с сервера; неизвестные роли отбрасываются', async () => {
    mocks.getServiceKeyScopes.mockResolvedValue({
      scopes: ['addons:install', 'users:read'],
      families: ['events'],
      roles: ['ADMIN', 'ROOT'],
    })
    const container = await renderSettings()
    await clickTestId(container, 'service-keys-add')

    expect(mocks.getServiceKeyScopes).toHaveBeenCalledTimes(1)
    // Новые scopes видны в чипах (из ответа сервера, а не из shared-констант).
    expect(container.querySelector('[data-testid="service-keys-scope-addons-install"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-scope-users-read"]')).not.toBeNull()
    // Wildcard-семейство → чип `<family>:*` (testid `events-all`).
    expect(container.querySelector('[data-testid="service-keys-scope-events-all"]')).not.toBeNull()
    // Роли — из ответа сервера; неизвестная ROOT отброшена.
    expect(container.querySelector('[data-testid="service-keys-role-ADMIN"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-role-ROOT"]')).toBeNull()
  })

  it('серверный каталог — источник истины (нет scope в ответе → нет чипа)', async () => {
    mocks.getServiceKeyScopes.mockResolvedValue({ scopes: ['events:ingest'], families: [], roles: ['ADMIN'] })
    const container = await renderSettings()
    await clickTestId(container, 'service-keys-add')

    expect(container.querySelector('[data-testid="service-keys-scope-events-ingest"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-scope-addons-install"]')).toBeNull()
  })

  it('при ошибке каталога — фоллбек на shared-константы (чипы не пусты, форма работает)', async () => {
    mocks.getServiceKeyScopes.mockRejectedValueOnce(new Error('no endpoint'))
    const container = await renderSettings()
    await clickTestId(container, 'service-keys-add')

    expect(container.querySelector('[data-testid="service-keys-scope-addons-install"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-scope-events-ingest"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-scope-events-all"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-keys-role-ADMIN"]')).not.toBeNull()
  })
})

describe('ServiceKeysSettings — права доступа (ADMIN) и i18n (ADR-052)', () => {
  it('категория «Сервисные ключи» — только ADMIN', () => {
    const config = CATEGORIES.find((cat) => cat.id === 'serviceKeys')!
    expect(config).toBeDefined()
    expect(config.roles).toEqual(['ADMIN'])
  })

  it('ADMIN видит раздел, USER/LEAD — нет', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map((c) => c.id)

    expect(visibleFor(['ADMIN'])).toContain('serviceKeys')
    expect(visibleFor(['LEAD'])).not.toContain('serviceKeys')
    expect(visibleFor(['USER'])).not.toContain('serviceKeys')
  })

  it('resolveActiveSettingsPage не оставляет недоступный раздел активным', () => {
    const visible = CATEGORIES.filter(
      (cat) => !cat.roles || cat.roles.some((r) => ['USER'].includes(r)),
    )
    expect(visible.some((cat) => cat.id === 'serviceKeys')).toBe(false)
    expect(resolveActiveSettingsPage(visible, 'serviceKeys')).toBe(visible[0].id)
  })

  it('ключи «Сервисные ключи» есть в ru и en словарях', () => {
    expect(enDict['settings.category.serviceKeys']).toBeTruthy()
    expect(ruDict['settings.category.serviceKeys']).toBeTruthy()
    expect(enDict['serviceKeys.title']).toBeTruthy()
    expect(ruDict['serviceKeys.title']).toBeTruthy()
    expect(enDict['serviceKeys.form.scopes']).toBeTruthy()
    expect(ruDict['serviceKeys.form.scopes']).toBeTruthy()
    expect(enDict['serviceKeys.form.allowedProjects']).toBeTruthy()
    expect(ruDict['serviceKeys.form.allowedProjects']).toBeTruthy()
    expect(enDict['serviceKeys.status.revoked']).toBeTruthy()
    expect(ruDict['serviceKeys.status.revoked']).toBeTruthy()
    expect(enDict['errors.conflict.serviceKeyLabel']).toBeTruthy()
    expect(ruDict['errors.conflict.serviceKeyLabel']).toBeTruthy()
    expect(enDict['serviceKeys.role.AUDITOR']).toBeTruthy()
    expect(ruDict['serviceKeys.role.AUDITOR']).toBeTruthy()
  })
})
