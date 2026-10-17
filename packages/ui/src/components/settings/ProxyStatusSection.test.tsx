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
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProxyStatusSection } from './ProxyStatusSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SAVED = {
  enabled: true,
  source: 'config' as const,
  url: 'http://proxy.local:3128',
  httpProxy: 'http://proxy.local:3128',
  noProxy: ['localhost'],
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
}

const RUNNING = {
  enabled: false,
  source: 'none' as const,
  noProxy: [],
  fallbackDirect: false,
  connectTimeoutMs: 10_000,
  restartRequired: true as const,
}

const DEFAULTS = {
  enabled: true,
  source: 'config' as const,
  url: 'http://config-proxy:3128',
  noProxy: ['localhost'],
  fallbackDirect: false,
  connectTimeoutMs: 10_000,
  restartRequired: true as const,
}

function makeInfo(over: Record<string, unknown> = {}) {
  return {
    ...SAVED,
    fromEnv: false,
    auth: { type: 'basic' as const, username: 'svc' },
    tls: { caFile: '/etc/ca.pem', rejectUnauthorized: true },
    saved: SAVED,
    running: RUNNING,
    isOverridden: false,
    defaults: DEFAULTS,
    password: { source: 'none' as const, set: false, removable: false },
    restartRequired: true,
    ...over,
  }
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSection(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProxyStatusSection />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

/** Тумблеры формы по порядку: enabled, fromEnv, fallbackDirect, rejectUnauthorized. */
const switches = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="proxy-status-section"] button[role="switch"]')] as HTMLButtonElement[]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProxy.mockResolvedValue(makeInfo())
  mocks.saveProxy.mockImplementation(async (input: Record<string, unknown>) => ({
    saved: { ...SAVED, enabled: input.enabled as boolean },
    running: RUNNING,
    restartRequired: true,
  }))
  mocks.resetProxy.mockResolvedValue({
    status: 'restored',
    saved: DEFAULTS,
    defaults: DEFAULTS,
    running: RUNNING,
    restartRequired: true,
  })
  mocks.setProxyPassword.mockResolvedValue({ source: 'file', set: true, removable: true })
  mocks.clearProxyPassword.mockResolvedValue({ source: 'none', set: false, removable: false })
  mocks.checkProxy.mockResolvedValue({
    reachable: true,
    latencyMs: 12,
    authChallenge: 'Basic',
    usingSaved: true,
  })
  mocks.confirm.mockResolvedValue(true)
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

describe('ProxyStatusSection — статус (running vs saved)', () => {
  it('показывает running и saved: enabled/source/redacted URL + restart-плашку', async () => {
    const container = await renderSection()

    expect(mocks.getProxy).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'proxy-status-running-enabled')!.textContent).toBe('Disabled')
    expect(byTestId(container, 'proxy-status-running-source')!.textContent).toBe('not configured')
    expect(byTestId(container, 'proxy-status-saved-enabled')!.textContent).toBe('Enabled')
    expect(byTestId(container, 'proxy-status-saved-source')!.textContent).toBe('config file')
    expect(byTestId(container, 'proxy-status-saved-url')!.textContent).toBe(
      'http://proxy.local:3128',
    )
    expect(byTestId(container, 'proxy-status-overridden')!.textContent).toBe('From config/env')
    expect(byTestId(container, 'proxy-status-restart')!.textContent).toContain(
      'Changes take effect after an instance restart',
    )
  })

  it('isOverridden и отсутствие restartRequired скрывают соответствующие плашки', async () => {
    mocks.getProxy.mockResolvedValue(makeInfo({ isOverridden: true, restartRequired: false }))
    const container = await renderSection()

    expect(byTestId(container, 'proxy-status-overridden')!.textContent).toBe('Overrides config')
    expect(byTestId(container, 'proxy-status-restart')).toBeNull()
  })

  it('ошибка загрузки — inline-сообщение и error-тост', async () => {
    mocks.getProxy.mockRejectedValue(new Error('boom'))
    const container = await renderSection()

    expect(byTestId(container, 'proxy-status-error')!.textContent).toContain('boom')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })
})

describe('ProxyStatusSection — форма runtime-override', () => {
  it('префиллит поля из saved (url/http/noProxy/fromEnv/timeout/auth/tls)', async () => {
    const container = await renderSection()

    expect((byTestId(container, 'proxy-form-url') as HTMLInputElement).value).toBe(
      'http://proxy.local:3128',
    )
    expect((byTestId(container, 'proxy-form-auth-username') as HTMLInputElement).value).toBe('svc')
    expect((byTestId(container, 'proxy-form-tls-ca-file') as HTMLInputElement).value).toBe(
      '/etc/ca.pem',
    )
    expect((byTestId(container, 'proxy-form-timeout') as HTMLInputElement).value).toBe('5000')
    expect(container.textContent).toContain('localhost')

    const [enabled, fromEnv, fallbackDirect, rejectUnauthorized] = switches(container)
    expect(enabled.getAttribute('aria-checked')).toBe('true')
    expect(fromEnv.getAttribute('aria-checked')).toBe('false')
    expect(fallbackDirect.getAttribute('aria-checked')).toBe('false')
    expect(rejectUnauthorized.getAttribute('aria-checked')).toBe('true')

    // auth.type зафиксирован basic: select disabled.
    const authType = byTestId(container, 'proxy-form-auth-type') as HTMLButtonElement
    expect(authType).not.toBeNull()
    expect(authType.disabled).toBe(true)
  })

  it('Save/Cancel неактивны на дефолте, активируются при изменении', async () => {
    const container = await renderSection()
    const save = byTestId(container, 'proxy-save') as HTMLButtonElement
    const cancel = byTestId(container, 'proxy-cancel') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)

    const [enabled] = switches(container)
    await act(async () => {
      enabled.click()
    })

    expect(save.disabled).toBe(false)
    expect(cancel.disabled).toBe(false)
  })

  it('сохраняет изменённые значения через saveProxy и показывает success-тост', async () => {
    const container = await renderSection()

    await act(async () => {
      switches(container)[0].click()
    })
    await act(async () => {
      ;(byTestId(container, 'proxy-save') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.saveProxy).toHaveBeenCalledWith({
      enabled: false,
      url: 'http://proxy.local:3128',
      httpProxy: 'http://proxy.local:3128',
      noProxy: ['localhost'],
      fromEnv: false,
      fallbackDirect: false,
      connectTimeoutMs: 5000,
      auth: { type: 'basic', username: 'svc' },
      tls: { caFile: '/etc/ca.pem' },
    })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
    // После сохранения saved обновился → сохранять нечего.
    expect((byTestId(container, 'proxy-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('noProxy добавляется и уходит в saveProxy', async () => {
    const container = await renderSection()
    const input = container.querySelector('input[placeholder="10.0.0.0/8"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '192.168.0.0/16')
    })
    const add = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement
    await act(async () => {
      add.click()
    })
    await act(async () => {
      ;(byTestId(container, 'proxy-save') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.saveProxy).toHaveBeenCalledWith(
      expect.objectContaining({ noProxy: ['localhost', '192.168.0.0/16'] }),
    )
  })

  it('fallbackDirect показывает предупреждение и сохраняется', async () => {
    const container = await renderSection()
    expect(byTestId(container, 'proxy-form-fallback-warning')).toBeNull()

    await act(async () => {
      switches(container)[2].click()
    })
    expect(byTestId(container, 'proxy-form-fallback-warning')!.textContent).toContain(
      'Security policy is weakened',
    )

    await act(async () => {
      ;(byTestId(container, 'proxy-save') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.saveProxy).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackDirect: true }),
    )
  })

  it('ошибка 400 при сохранении — error-тост, правки сохраняются', async () => {
    mocks.saveProxy.mockRejectedValue(new Error('proxy.url: некорректный URL'))
    const container = await renderSection()

    await act(async () => {
      switches(container)[0].click()
    })
    await act(async () => {
      ;(byTestId(container, 'proxy-save') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('proxy.url: некорректный URL'),
      }),
    )
    expect((byTestId(container, 'proxy-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Reset вызывает resetProxy и возвращает config-дефолт', async () => {
    mocks.getProxy.mockResolvedValue(makeInfo({ isOverridden: true }))
    const container = await renderSection()

    await act(async () => {
      ;(byTestId(container, 'proxy-reset') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.resetProxy).toHaveBeenCalledTimes(1)
    expect((byTestId(container, 'proxy-form-url') as HTMLInputElement).value).toBe(
      'http://config-proxy:3128',
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })
})

describe('ProxyStatusSection — пароль (write-only)', () => {
  it('«Задать» отправляет пароль, очищает поле и не показывает значение', async () => {
    const container = await renderSection()
    const input = byTestId(container, 'proxy-password-input') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 's3cret-value')
    })
    await act(async () => {
      ;(byTestId(container, 'proxy-password-set') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.setProxyPassword).toHaveBeenCalledWith('s3cret-value')
    expect(input.value).toBe('')
    expect(container.textContent).not.toContain('s3cret-value')
    expect(byTestId(container, 'proxy-password-status')!.textContent).toBe(
      'secrets/proxy-password',
    )
  })

  it('«Сбросить» подтверждается и вызывает clearProxyPassword', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({ password: { source: 'file', set: true, removable: true } }),
    )
    const container = await renderSection()

    await act(async () => {
      ;(byTestId(container, 'proxy-password-clear') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.clearProxyPassword).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'proxy-password-status')!.textContent).toBe('not set')
  })

  it('пароль из env: поле и кнопки disabled + подсказка', async () => {
    mocks.getProxy.mockResolvedValue(
      makeInfo({ password: { source: 'env', set: true, removable: false } }),
    )
    const container = await renderSection()

    expect((byTestId(container, 'proxy-password-input') as HTMLInputElement).disabled).toBe(true)
    expect((byTestId(container, 'proxy-password-set') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'proxy-password-clear') as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId(container, 'proxy-password-env-hint')!.textContent).toContain(
      'SYNTH_PROXY_PASSWORD',
    )
  })

  it('409 при задании пароля — понятный текст про env', async () => {
    mocks.setProxyPassword.mockRejectedValue(
      Object.assign(new Error('conflict'), { status: 409 }),
    )
    const container = await renderSection()
    await act(async () => {
      setInputValue(byTestId(container, 'proxy-password-input') as HTMLInputElement, 'x')
    })
    await act(async () => {
      ;(byTestId(container, 'proxy-password-set') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(byTestId(container, 'proxy-password-error')!.textContent).toContain(
      'SYNTH_PROXY_PASSWORD',
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })
})

describe('ProxyStatusSection — проверка соединения', () => {
  it('проверяет saved-конфигурацию и показывает usingSaved/latency/authChallenge', async () => {
    const container = await renderSection()
    await act(async () => {
      ;(byTestId(container, 'proxy-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.checkProxy).toHaveBeenCalledWith()
    const result = byTestId(container, 'proxy-check-result')!
    expect(result.textContent).toContain('Proxy reachable')
    expect(result.textContent).toContain('saved configuration')
    expect(result.textContent).toContain('12 ms')
    expect(result.textContent).toContain('Authentication challenge: Basic')
  })

  it('недоступный прокси показывает ошибку', async () => {
    mocks.checkProxy.mockResolvedValue({
      reachable: false,
      error: 'ECONNREFUSED',
      usingSaved: true,
    })
    const container = await renderSection()
    await act(async () => {
      ;(byTestId(container, 'proxy-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const result = byTestId(container, 'proxy-check-result')!
    expect(result.textContent).toContain('Proxy unreachable')
    expect(result.textContent).toContain('ECONNREFUSED')
  })

  it('ошибка API проверки — inline-сообщение и error-тост', async () => {
    mocks.checkProxy.mockRejectedValue(new Error('HTTP 500'))
    const container = await renderSection()
    await act(async () => {
      ;(byTestId(container, 'proxy-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(byTestId(container, 'proxy-check-error')!.textContent).toContain('HTTP 500')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })
})
