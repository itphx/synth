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
  getWebhookSubscriptions: vi.fn(),
  getWebhookSubscription: vi.fn(),
  createWebhookSubscription: vi.fn(),
  updateWebhookSubscription: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
  regenerateWebhookSecret: vi.fn(),
  testWebhookSubscription: vi.fn(),
  getWebhookDeliveries: vi.fn(),
  notify: vi.fn(),
}))

// Роли текущего пользователя (управление webhooks — ADMIN).
const authStore = vi.hoisted(() => ({
  user: { id: 'u1', roles: ['ADMIN'] } as { id: string; roles: string[] } | null,
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
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
import { WebhooksSettings, buildWebhookSignatureExample, isHttpsUrl } from './WebhooksSettings'
import { CATEGORIES, resolveActiveSettingsPage } from './SettingsModal'
import type {
  WebhookDelivery,
  WebhookSubscription,
  WebhookSubscriptionCreated,
} from '@itphx/synth-shared'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SUB_ACTIVE: WebhookSubscription = {
  id: 'whk_1',
  label: 'Alpha hook',
  description: 'for alpha',
  url: 'https://example.com/hooks/alpha',
  events: ['session.*', 'message.added'],
  enabled: true,
  secretPrefix: 'whsec_ab…',
  createdBy: 'admin',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastDeliveryAt: '2026-10-10T12:00:00.000Z',
  lastStatus: 'ok',
}

const SUB_DISABLED: WebhookSubscription = {
  id: 'whk_2',
  label: 'Beta hook',
  url: 'https://example.com/hooks/beta',
  events: [],
  enabled: false,
  secretPrefix: 'whsec_cd…',
  createdBy: 'admin',
  createdAt: '2026-09-01T10:00:00.000Z',
  disabledAt: '2026-09-05T10:00:00.000Z',
}

const CREATED: WebhookSubscriptionCreated = {
  ...SUB_ACTIVE,
  id: 'whk_new',
  label: 'New hook',
  events: ['session.*'],
  secret: 'whsec_secret_value',
}

const DELIVERY_OK: WebhookDelivery = {
  id: 'whd_1',
  subscriptionId: 'whk_1',
  eventType: 'webhook.test',
  status: 'ok',
  attempts: 1,
  responseStatus: 200,
  createdAt: '2026-10-10T12:00:00.000Z',
  completedAt: '2026-10-10T12:00:01.000Z',
}

const DELIVERY_FAIL: WebhookDelivery = {
  id: 'whd_2',
  subscriptionId: 'whk_1',
  eventType: 'message.added',
  status: 'failed',
  attempts: 3,
  responseStatus: 500,
  error: 'boom',
  createdAt: '2026-10-09T12:00:00.000Z',
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
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

const setFieldValue = async (container: HTMLElement, testId: string, value: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null
  expect(el, `поле ${testId}`).toBeTruthy()
  await act(async () => {
    setInputValue(el!, value)
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
          <WebhooksSettings />
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
  mocks.getWebhookSubscriptions.mockResolvedValue({ subscriptions: [SUB_ACTIVE, SUB_DISABLED] })
  mocks.createWebhookSubscription.mockResolvedValue(CREATED)
  mocks.updateWebhookSubscription.mockImplementation(async (id: string, patch: unknown) => ({
    ...SUB_ACTIVE,
    id,
    ...(patch as object),
  }))
  mocks.deleteWebhookSubscription.mockResolvedValue(undefined)
  mocks.regenerateWebhookSecret.mockResolvedValue({ ...SUB_ACTIVE, secret: 'whsec_rotated_value' })
  mocks.testWebhookSubscription.mockResolvedValue(DELIVERY_OK)
  mocks.getWebhookDeliveries.mockResolvedValue({ deliveries: [DELIVERY_OK, DELIVERY_FAIL] })
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

describe('WebhooksSettings — админ-секция «Webhooks» (AD-052 этап II)', () => {
  it('загружает подписки и рендерит заголовок/описание/счётчик', async () => {
    const container = await renderSettings()

    expect(mocks.getWebhookSubscriptions).toHaveBeenCalledTimes(1)
    expect(container.querySelector('header')!.textContent).toContain('Webhooks')
    expect(container.textContent).toContain('Outgoing event subscriptions')
    expect(container.querySelector('[data-testid="settings-header-meta"]')!.textContent).toContain(
      '2 subscriptions',
    )
  })

  it('показывает метаданные подписок (label/url/события/статусы)', async () => {
    const container = await renderSettings()

    const active = container.querySelector('[data-testid="webhooks-item-whk_1"]')!
    expect(active.textContent).toContain('Alpha hook')
    expect(active.textContent).toContain('https://example.com/hooks/alpha')
    expect(active.textContent).toContain('session.*')
    expect(active.textContent).toContain('message.added')
    expect(active.textContent).toContain('Enabled')
    expect(active.textContent).toContain('OK')
    expect(active.textContent).toContain('Last delivery')

    const disabled = container.querySelector('[data-testid="webhooks-item-whk_2"]')!
    expect(disabled.textContent).toContain('Beta hook')
    expect(disabled.textContent).toContain('Disabled')
    // Пустой список событий означает набор по умолчанию.
    expect(disabled.textContent).toContain('default set')
  })

  it('требует метку при создании (без запроса к API)', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})

    expect(mocks.createWebhookSubscription).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="webhooks-form"]')!.textContent).toContain(
      'Label is required',
    )
  })

  it('валидирует URL (пустой и не-https)', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await setFieldValue(container, 'webhooks-label', 'New hook')
    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})
    expect(mocks.createWebhookSubscription).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="webhooks-form"]')!.textContent).toContain(
      enDict['webhooks.urlRequired'],
    )

    await setFieldValue(container, 'webhooks-url', 'ftp://example.com')
    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})
    expect(mocks.createWebhookSubscription).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="webhooks-form"]')!.textContent).toContain(
      enDict['webhooks.urlInvalid'],
    )
  })

  it('конфликт метки (409) показывается под полем метки', async () => {
    mocks.createWebhookSubscription.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { status: 409, code: 'CONFLICT' }),
    )
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await setFieldValue(container, 'webhooks-label', 'Duplicate')
    await setFieldValue(container, 'webhooks-url', 'https://example.com/hooks')
    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})

    expect(mocks.createWebhookSubscription).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="webhooks-form"]')!.textContent).toContain(
      enDict['errors.conflict.webhookLabel'],
    )
  })

  it('создаёт подписку с выбранными событиями', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await setFieldValue(container, 'webhooks-label', 'New hook')
    await setFieldValue(container, 'webhooks-description', 'desc')
    await setFieldValue(container, 'webhooks-url', 'https://example.com/hooks')
    // Дефолтный паттерн `session.*` → testId `webhooks-event-session.all`.
    await clickTestId(container, 'webhooks-event-session.all')

    expect(
      container.querySelector('[data-testid="webhooks-event-session.all"]')!.getAttribute('aria-pressed'),
    ).toBe('true')

    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})

    expect(mocks.createWebhookSubscription).toHaveBeenCalledTimes(1)
    expect(mocks.createWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'New hook',
        url: 'https://example.com/hooks',
        events: ['session.*'],
      }),
    )
  })

  it('добавляет собственный паттерн и отклоняет некорректный', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await setFieldValue(container, 'webhooks-event-pattern-input', 'nope')
    await clickTestId(container, 'webhooks-event-pattern-add')
    await act(async () => {})
    expect(container.querySelector('[data-testid="webhooks-form"]')!.textContent).toContain(
      enDict['webhooks.form.patternInvalid'],
    )

    await setFieldValue(container, 'webhooks-event-pattern-input', 'message.*')
    await clickTestId(container, 'webhooks-event-pattern-add')
    await act(async () => {})

    const chip = container.querySelector('[data-testid="webhooks-event-message.all"]')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('aria-pressed')).toBe('true')
  })

  it('после создания один раз показывает signing-секрет и пример подписи', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-add')
    await setFieldValue(container, 'webhooks-label', 'New hook')
    await setFieldValue(container, 'webhooks-url', 'https://example.com/hooks')
    await clickTestId(container, 'webhooks-create-save')
    await act(async () => {})

    const secret = container.querySelector('[data-testid="webhooks-secret"]')!
    expect(secret.textContent).toContain('whsec_secret_value')

    const signature = container.querySelector('[data-testid="webhooks-signature"]')!
    expect(signature.textContent).toContain('X-Synth-Signature')
    expect(signature.textContent).toContain('whsec_secret_value')

    await clickTestId(container, 'webhooks-secret-close')
    expect(container.querySelector('[data-testid="webhooks-secret"]')).toBeNull()
  })

  it('перегенерация секрета подтверждается и показывает новый секрет', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-regenerate-whk_1')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.regenerateWebhookSecret).toHaveBeenCalledWith('whk_1')
    expect(container.querySelector('[data-testid="webhooks-secret"]')!.textContent).toContain(
      'whsec_rotated_value',
    )
  })

  it('тест доставки вызывает API и уведомляет', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-test-whk_1')
    await act(async () => {})

    expect(mocks.testWebhookSubscription).toHaveBeenCalledWith('whk_1')
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
  })

  it('тумблер включения шлёт PATCH enabled=false', async () => {
    const container = await renderSettings()

    const toggle = container
      .querySelector('[data-testid="webhooks-toggle-whk_1"]')!
      .querySelector('button') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })

    expect(mocks.updateWebhookSubscription).toHaveBeenCalledWith('whk_1', { enabled: false })
  })

  it('удаление подтверждается и вызывает API', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-delete-whk_1')
    await act(async () => {})

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteWebhookSubscription).toHaveBeenCalledWith('whk_1')
  })

  it('редактирование шлёт PATCH с обновлённой меткой', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-edit-whk_1')
    await setFieldValue(container, 'webhooks-edit-label-whk_1', 'Alpha hook 2')
    await clickTestId(container, 'webhooks-edit-save-whk_1')
    await act(async () => {})

    expect(mocks.updateWebhookSubscription).toHaveBeenCalledTimes(1)
    expect(mocks.updateWebhookSubscription).toHaveBeenCalledWith(
      'whk_1',
      expect.objectContaining({ label: 'Alpha hook 2', url: 'https://example.com/hooks/alpha' }),
    )
  })

  it('журнал доставок показывает статус/попытки/HTTP/ошибку', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'webhooks-deliveries-toggle-whk_1')
    await act(async () => {})

    expect(mocks.getWebhookDeliveries).toHaveBeenCalledWith('whk_1')
    const panel = container.querySelector('[data-testid="webhooks-deliveries-whk_1"]')!
    expect(panel.textContent).toContain('webhook.test')
    expect(panel.textContent).toContain('1 attempt')
    expect(panel.textContent).toContain('HTTP: 200')
    expect(panel.textContent).toContain('3 attempts')
    expect(panel.textContent).toContain('boom')

    // Повторный клик скрывает журнал.
    await clickTestId(container, 'webhooks-deliveries-toggle-whk_1')
    expect(container.querySelector('[data-testid="webhooks-deliveries-whk_1"]')).toBeNull()
  })

  it('не-ADMIN видит read-only сообщение без кнопок мутаций', async () => {
    authStore.user = { id: 'u2', roles: ['USER'] }
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="webhooks-readonly"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="webhooks-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="webhooks-edit-whk_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="webhooks-delete-whk_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="webhooks-toggle-whk_1"]')).toBeNull()
    // Список всё же доступен для просмотра.
    expect(container.querySelector('[data-testid="webhooks-item-whk_1"]')).not.toBeNull()
  })

  it('показывает ошибку загрузки', async () => {
    mocks.getWebhookSubscriptions.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
  })
})

describe('WebhooksSettings — утилиты, права (ADMIN) и i18n (AD-052)', () => {
  it('isHttpsUrl принимает только https-адреса', () => {
    expect(isHttpsUrl('https://example.com/hooks')).toBe(true)
    expect(isHttpsUrl('http://example.com')).toBe(false)
    expect(isHttpsUrl('not-a-url')).toBe(false)
    expect(isHttpsUrl('')).toBe(false)
  })

  it('buildWebhookSignatureExample описывает формат заголовка и секрет', () => {
    const snippet = buildWebhookSignatureExample('whsec_x')
    expect(snippet).toContain('X-Synth-Signature')
    expect(snippet).toContain('createHmac')
    expect(snippet).toContain('whsec_x')
    expect(buildWebhookSignatureExample('')).toContain('<secret>')
  })

  it('категория «Webhooks» — только ADMIN', () => {
    const config = CATEGORIES.find((cat) => cat.id === 'webhooks')!
    expect(config).toBeDefined()
    expect(config.roles).toEqual(['ADMIN'])
  })

  it('ADMIN видит раздел, USER/LEAD — нет', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map(
        (c) => c.id,
      )

    expect(visibleFor(['ADMIN'])).toContain('webhooks')
    expect(visibleFor(['LEAD'])).not.toContain('webhooks')
    expect(visibleFor(['USER'])).not.toContain('webhooks')
  })

  it('resolveActiveSettingsPage не оставляет недоступный раздел активным', () => {
    const visible = CATEGORIES.filter(
      (cat) => !cat.roles || cat.roles.some((r) => ['USER'].includes(r)),
    )
    expect(visible.some((cat) => cat.id === 'webhooks')).toBe(false)
    expect(resolveActiveSettingsPage(visible, 'webhooks')).toBe(visible[0].id)
  })

  it('ключи «Webhooks» есть в ru и en словарях', () => {
    expect(enDict['settings.category.webhooks']).toBeTruthy()
    expect(ruDict['settings.category.webhooks']).toBeTruthy()
    expect(enDict['webhooks.title']).toBeTruthy()
    expect(ruDict['webhooks.title']).toBeTruthy()
    expect(enDict['webhooks.form.events']).toBeTruthy()
    expect(ruDict['webhooks.form.events']).toBeTruthy()
    expect(enDict['webhooks.form.url']).toBeTruthy()
    expect(ruDict['webhooks.form.url']).toBeTruthy()
    expect(enDict['webhooks.status.failed']).toBeTruthy()
    expect(ruDict['webhooks.status.failed']).toBeTruthy()
    expect(enDict['errors.conflict.webhookLabel']).toBeTruthy()
    expect(ruDict['errors.conflict.webhookLabel']).toBeTruthy()
    expect(enDict['webhooks.deliveries.title']).toBeTruthy()
    expect(ruDict['webhooks.deliveries.title']).toBeTruthy()
  })
})
