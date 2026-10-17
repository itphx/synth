import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getProxyStatus: vi.fn(),
  checkProxy: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProxyStatusSection } from './ProxyStatusSection'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const STATUS = {
  enabled: true,
  source: 'env' as const,
  url: 'http://proxy.local:3128',
  noProxy: ['localhost', '.corp.local'],
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProxyStatus.mockResolvedValue(STATUS)
  mocks.checkProxy.mockResolvedValue({
    reachable: true,
    latencyMs: 12,
    authChallenge: 'Basic',
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

describe('ProxyStatusSection — статус egress-прокси (ADR-099 D1)', () => {
  it('загружает и рендерит статус: enabled/source/url/noProxy/timeout/restart', async () => {
    const container = await renderSection()

    expect(mocks.getProxyStatus).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'proxy-status-enabled')!.textContent).toBe('Enabled')
    expect(byTestId(container, 'proxy-status-source')!.textContent).toBe('environment variables')
    expect(byTestId(container, 'proxy-status-url')!.textContent).toBe('http://proxy.local:3128')
    expect(byTestId(container, 'proxy-status-no-proxy')!.textContent).toContain('localhost')
    expect(byTestId(container, 'proxy-status-no-proxy')!.textContent).toContain('.corp.local')
    expect(byTestId(container, 'proxy-status-timeout')!.textContent).toBe('5000 ms')
    expect(byTestId(container, 'proxy-status-restart')!.textContent).toContain(
      'Changes require an instance restart',
    )
  })

  it('не содержит Save/полей ввода (read-only) и не показывает креды', async () => {
    mocks.getProxyStatus.mockResolvedValue({
      ...STATUS,
      url: 'http://proxy.local:3128',
      source: 'config',
    })
    const container = await renderSection()

    expect(container.querySelector('input')).toBeNull()
    expect(byTestId(container, 'proxy-status-section')!.querySelectorAll('button')).toHaveLength(1)
    expect(container.textContent).not.toContain('password')
    expect(container.textContent).not.toContain('user:')
    expect(byTestId(container, 'proxy-status-source')!.textContent).toBe('config file')
  })

  it('выключенный прокси и fallbackDirect — предупреждение', async () => {
    mocks.getProxyStatus.mockResolvedValue({
      ...STATUS,
      enabled: false,
      source: 'none',
      url: undefined,
      noProxy: [],
      fallbackDirect: true,
    })
    const container = await renderSection()

    expect(byTestId(container, 'proxy-status-enabled')!.textContent).toBe('Disabled')
    expect(byTestId(container, 'proxy-status-source')!.textContent).toBe('not configured')
    expect(byTestId(container, 'proxy-status-url')!.textContent).toBe('—')
    expect(byTestId(container, 'proxy-status-fallback')!.textContent).toBe('Enabled')
    expect(container.textContent).toContain('Security policy is weakened')
  })

  it('«Проверить соединение»: success показывает reachable/latency/authChallenge', async () => {
    const container = await renderSection()
    await act(async () => {
      ;(byTestId(container, 'proxy-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.checkProxy).toHaveBeenCalledTimes(1)
    const result = byTestId(container, 'proxy-check-result')!
    expect(result.textContent).toContain('Proxy reachable')
    expect(result.textContent).toContain('12 ms')
    expect(result.textContent).toContain('Authentication challenge: Basic')
    expect(result.className).toContain('bg-status-success')
  })

  it('«Проверить соединение»: failure показывает unreachable и ошибку', async () => {
    mocks.checkProxy.mockResolvedValue({
      reachable: false,
      latencyMs: 0,
      error: 'ECONNREFUSED',
      authChallenge: 'none',
    })
    const container = await renderSection()
    await act(async () => {
      ;(byTestId(container, 'proxy-check-button') as HTMLButtonElement).click()
    })
    await act(async () => {})

    const result = byTestId(container, 'proxy-check-result')!
    expect(result.textContent).toContain('Proxy unreachable')
    expect(result.textContent).toContain('ECONNREFUSED')
    expect(result.className).toContain('bg-destructive')
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

  it('ошибка загрузки статуса — inline-сообщение и error-тост', async () => {
    mocks.getProxyStatus.mockRejectedValue(new Error('boom'))
    const container = await renderSection()

    expect(byTestId(container, 'proxy-status-error')!.textContent).toContain('boom')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', category: 'error' }),
    )
  })
})
