import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/client', () => ({
  api: { getStatus: vi.fn() },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { api } from '@/lib/api/client'
import { notifyMessage } from '@/hooks/useNotification'
import { useAuthStore } from '@/stores/authStore'
import { useHybridStore } from '@/stores/hybridStore'
import { useTransportStore } from '@/stores/transportStore'
import {
  ConnectionStatus,
  CONNECTION_BANNER_DELAY_MS,
  CONNECTION_PROBE_INTERVAL_MS,
} from './ConnectionStatus'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []
const getStatusMock = vi.mocked(api.getStatus)

async function renderStatus(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<ConnectionStatus />)
  })
  await act(async () => {})
  return host
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function banner(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[data-testid="connection-banner"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  useAuthStore.setState({
    authPhase: 'authenticated',
    isAuthenticated: true,
    isLoading: false,
  })
  useTransportStore.setState({
    phase: 'reconnecting',
    phaseSince: 0,
    hasEverConnected: true,
    connected: false,
    versionMismatch: false,
  })
  useHybridStore.setState({ enabled: false, connected: false })
  getStatusMock.mockRejectedValue(new TypeError('Failed to fetch'))
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
  vi.useRealTimers()
  vi.clearAllTimers()
})

describe('ConnectionStatus: баннер после 15 с разрыва', () => {
  it('баннера нет, пока обрыв короче 15 с', async () => {
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS - 1)
    expect(banner(host)).toBeNull()
  })

  it('баннер появляется через 15 с непрерывного разрыва', async () => {
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    expect(banner(host)).toBeTruthy()
    expect(host.textContent).toContain('connection.banner.title')
    expect(host.querySelector('[data-testid="connection-banner-retry"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="connection-banner-reload"]')).toBeTruthy()
  })

  it('баннер исчезает сам при возврате в online', async () => {
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    expect(banner(host)).toBeTruthy()

    await act(async () => {
      useTransportStore.setState({ phase: 'online', phaseSince: Date.now() })
    })

    expect(banner(host)).toBeNull()
  })

  it('залипший первый connecting ≥ 15 с тоже показывает баннер', async () => {
    await act(async () => {
      useTransportStore.setState({ phase: 'connecting', phaseSince: 0 })
    })
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    expect(banner(host)).toBeTruthy()
    expect(banner(host)!.getAttribute('data-phase')).toBe('connecting')
  })

  it('гибрид offline: баннер показывается и содержит кнопки', async () => {
    await act(async () => {
      useHybridStore.setState({ enabled: true, connected: false })
    })
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)

    // Наш баннер перекрывает inline-баннер гибрида, зато даёт действия.
    expect(banner(host)).toBeTruthy()
    expect(host.querySelector('[data-testid="connection-banner-retry"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="connection-banner-reload"]')).toBeTruthy()
  })

  it('versionMismatch: баннер «нет связи» не показывается (есть error-тост)', async () => {
    await act(async () => {
      useTransportStore.setState({ versionMismatch: true })
    })
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    expect(banner(host)).toBeNull()
  })

  it('разрыв короче 15 с не показывает баннер (сворачивание PWA)', async () => {
    const host = await renderStatus()
    await advance(5_000)
    await act(async () => {
      useTransportStore.setState({ phase: 'online', phaseSince: Date.now() })
    })
    await advance(20_000)
    expect(banner(host)).toBeNull()
  })

  it('не активно для гостя/непроверенной сессии', async () => {
    await act(async () => {
      useAuthStore.setState({ authPhase: 'guest', isAuthenticated: false })
    })
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    expect(banner(host)).toBeNull()
  })
})

describe('ConnectionStatus: probe сессии и отсутствие тостов о связи', () => {
  it('probe authenticated=false → sessionExpired и гость', async () => {
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    // Probe запускается сразу при появлении баннера.
    getStatusMock.mockResolvedValue({
      authenticated: false,
      debug_mode: false,
      oidc_enabled: true,
      deployment: 'managed',
      user: null,
    })
    await advance(CONNECTION_PROBE_INTERVAL_MS)
    await act(async () => {})

    expect(notifyMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'connection.sessionExpired', type: 'error' }),
    )
    expect(useAuthStore.getState().authPhase).toBe('guest')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(banner(host)).toBeNull()
  })

  it('сеть/таймаут probe → остаёмся в разрыве, тостов нет', async () => {
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    await advance(CONNECTION_PROBE_INTERVAL_MS)

    expect(notifyMessage).not.toHaveBeenCalled()
    expect(banner(host)).toBeTruthy()
    expect(useAuthStore.getState().authPhase).toBe('authenticated')
  })

  it('probe authenticated=true → остаёмся reconnecting, без тостов', async () => {
    getStatusMock.mockResolvedValue({
      authenticated: true,
      debug_mode: false,
      oidc_enabled: true,
      deployment: 'managed',
      user: { id: 'u1', username: 'dev', email: null, roles: ['USER'] },
    })
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)
    await act(async () => {})

    expect(notifyMessage).not.toHaveBeenCalled()
    expect(useTransportStore.getState().phase).toBe('reconnecting')
    expect(banner(host)).toBeTruthy()
  })

  it('«Повторить» перезапускает транспорт', async () => {
    const restart = vi.spyOn(useTransportStore.getState(), 'restart').mockImplementation(() => {})
    const host = await renderStatus()
    await advance(CONNECTION_BANNER_DELAY_MS)

    const retry = host.querySelector('[data-testid="connection-banner-retry"]') as HTMLButtonElement
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(restart).toHaveBeenCalledTimes(1)
    restart.mockRestore()
  })
})
