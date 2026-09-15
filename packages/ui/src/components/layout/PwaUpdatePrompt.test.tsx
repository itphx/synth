import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { PwaUpdatePrompt } from './PwaUpdatePrompt'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WaitingWorker = { postMessage: (message: unknown) => void }

class MockRegistration extends EventTarget {
  waiting: WaitingWorker | null
  installing: (EventTarget & { state: string }) | null = null
  update = vi.fn(async () => this)

  constructor(waiting: WaitingWorker | null) {
    super()
    this.waiting = waiting
  }
}

class MockServiceWorkerContainer extends EventTarget {
  controller: object | null = null
  registration: MockRegistration | null = null
  register = vi.fn(async () => this.registration!)
  getRegistration = vi.fn(async () => this.registration ?? undefined)
}

let container: MockServiceWorkerContainer
const mounted: { host: HTMLElement; root: Root }[] = []

async function mountPrompt(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(<PwaUpdatePrompt />)
  })
  return host
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

beforeEach(() => {
  vi.stubEnv('PROD', true)
  container = new MockServiceWorkerContainer()
  Object.defineProperty(navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  while (mounted.length > 0) {
    const { root, host } = mounted.pop()!
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

describe('PwaUpdatePrompt', () => {
  it('показывает баннер при ожидающем SW и активном controller', async () => {
    container.controller = {}
    container.registration = new MockRegistration({ postMessage: vi.fn() })

    const host = await mountPrompt()

    expect(host.textContent).toContain('pwa.updateAvailable')
    expect(host.textContent).toContain('pwa.updateNow')
  })

  it('по кнопке «Обновить» отправляет SKIP_WAITING', async () => {
    const worker = { postMessage: vi.fn() }
    container.controller = {}
    container.registration = new MockRegistration(worker)

    const host = await mountPrompt()
    await act(async () => {
      findButton(host, 'pwa.updateNow').click()
    })

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('«Позже» скрывает баннер', async () => {
    container.controller = {}
    container.registration = new MockRegistration({ postMessage: vi.fn() })

    const host = await mountPrompt()
    await act(async () => {
      findButton(host, 'pwa.updateLater').click()
    })

    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('не показывает баннер при первой установке без controller', async () => {
    container.controller = null
    container.registration = new MockRegistration({ postMessage: vi.fn() })

    const host = await mountPrompt()

    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })
})
