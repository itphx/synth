import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { useHybridStore } from '@/stores/hybridStore'
import { useTransportStore } from '@/stores/transportStore'
import { HybridOfflineBanner } from './HybridOfflineBanner'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: { host: HTMLElement; root: Root }[] = []

async function renderBanner(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<HybridOfflineBanner />)
  })
  return host
}

beforeEach(() => {
  useHybridStore.setState({ enabled: false, connected: false })
  useTransportStore.setState({ phase: 'online' })
})

afterEach(async () => {
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

describe('HybridOfflineBanner: один баннер с ConnectionStatus', () => {
  it('гибрид offline + связь online → баннер есть', async () => {
    useHybridStore.setState({ enabled: true, connected: false })
    useTransportStore.setState({ phase: 'online' })

    const host = await renderBanner()

    expect(host.querySelector('[role="status"]')).toBeTruthy()
    expect(host.textContent).toContain('hybrid.offlineBanner')
  })

  it('гибрид offline + phase reconnecting → баннера нет (рисует ConnectionStatus)', async () => {
    useHybridStore.setState({ enabled: true, connected: false })
    useTransportStore.setState({ phase: 'reconnecting' })

    const host = await renderBanner()

    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(host.textContent).not.toContain('hybrid.offlineBanner')
  })

  it('гибрид выключен → баннера нет', async () => {
    useHybridStore.setState({ enabled: false, connected: false })
    useTransportStore.setState({ phase: 'online' })

    const host = await renderBanner()

    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})
