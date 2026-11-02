import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared/version'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getHealth: vi.fn() },
}))

import { PwaUpdatePrompt } from './PwaUpdatePrompt'
import { synthApi } from '@/lib/api/synthApi'

const getHealthMock = vi.mocked(synthApi.getHealth)

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HEALTH_OK = { status: 'healthy', version: SYNTH_VERSION, time: '2024-01-01T00:00:00.000Z' }
const AUTO_RELOAD_STORAGE_KEY = 'synth.pwa.autoReload'

class MockWaitingWorker extends EventTarget {
  postMessage = vi.fn()
}

class MockRegistration extends EventTarget {
  waiting: MockWaitingWorker | null
  installing: (EventTarget & { state: string }) | null = null
  update = vi.fn(async () => this)

  constructor(waiting: MockWaitingWorker | null) {
    super()
    this.waiting = waiting
  }
}

class MockServiceWorkerContainer extends EventTarget {
  controller: object | null = null
  registration: MockRegistration | null = null
  register = vi.fn(
    async (_url: string, _options?: RegistrationOptions) => this.registration!,
  )
  getRegistration = vi.fn(async () => this.registration ?? undefined)
}

let container: MockServiceWorkerContainer
let reloadSpy: ReturnType<typeof vi.fn>
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

function seedAutoReload(key: string, count: number): void {
  window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, JSON.stringify({ key, count }))
}

function readAutoReload(): { key: string; count: number } | null {
  const raw = window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as { key: string; count: number }) : null
}

beforeEach(() => {
  vi.stubEnv('PROD', true)
  getHealthMock.mockReset()
  getHealthMock.mockResolvedValue(HEALTH_OK)
  reloadSpy = vi.fn()
  // jsdom не даёт навигацию — подменяем getter window.location, чтобы проверить reload.
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    reload: reloadSpy,
  } as unknown as Location)
  window.sessionStorage.clear()
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
  vi.clearAllTimers()
  vi.useRealTimers()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('PwaUpdatePrompt', () => {
  it('регистрирует SW по стабильному URL /sw.js без ?v=', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)

    await mountPrompt()

    expect(container.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' })
    expect(String(container.register.mock.calls[0]?.[0])).not.toContain('?v=')
  })

  it('обнаружив ожидающий SW, сам отправляет SKIP_WAITING и перезагружает', async () => {
    vi.useFakeTimers()
    const worker = new MockWaitingWorker()
    container.controller = {}
    container.registration = new MockRegistration(worker)

    const host = await mountPrompt()

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    // Баннера нет — обновление применяется без вопроса.
    expect(host.textContent).not.toContain('pwa.updateAvailable')
    expect(reloadSpy).not.toHaveBeenCalled()

    // Страховка: controllerchange не пришёл — перезагружаемся сами.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('расхождение версий — перезагружает без клика и без баннера', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('pwa.updateAvailable')
    // Ключ версии и первая авто-попытка зафиксированы в sessionStorage.
    expect(readAutoReload()).toEqual({ key: 'ver:9.9.9', count: 1 })
  })

  it('смена ключа обновления сбрасывает счётчик авто-попыток', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('ver:9.9.8', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    await mountPrompt()

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(readAutoReload()).toEqual({ key: 'ver:9.9.9', count: 1 })
  })

  it('после 2 авто-попыток на ту же версию показывает аварийный баннер', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('ver:9.9.9', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain('pwa.updateAvailable')
    expect(host.textContent).toContain('pwa.updateLater')
    expect(host.textContent).toContain('pwa.updateNow')
  })

  it('не показывает баннер, когда версия сервера совпадает', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)

    const host = await mountPrompt()

    expect(host.textContent).not.toContain('pwa.updateAvailable')
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('проверяет версию раз в 30 минут', async () => {
    vi.useFakeTimers()
    container.controller = {}
    container.registration = new MockRegistration(null)

    await mountPrompt()
    expect(getHealthMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    })

    expect(getHealthMock).toHaveBeenCalledTimes(2)
  })

  it('проверяет версию при действии после простоя > 1 часа', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
    container.controller = {}
    container.registration = new MockRegistration(null)

    await mountPrompt()
    expect(getHealthMock).toHaveBeenCalledTimes(1)

    // Простой: сдвигаем системное время, не запуская интервал.
    vi.setSystemTime(new Date('2024-01-01T01:01:00.000Z'))
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'))
    })

    expect(getHealthMock).toHaveBeenCalledTimes(2)
  })

  it('в аварийном баннере «Позже» скрывает его', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('ver:9.9.9', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    expect(host.textContent).toContain('pwa.updateAvailable')

    await act(async () => {
      findButton(host, 'pwa.updateLater').click()
    })

    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('в аварийном баннере «Обновить» отправляет SKIP_WAITING, если воркер ждёт', async () => {
    vi.useFakeTimers()
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('ver:9.9.9', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    expect(host.textContent).toContain('pwa.updateAvailable')

    // К моменту клика воркер появился.
    const worker = new MockWaitingWorker()
    container.getRegistration.mockResolvedValueOnce(new MockRegistration(worker))

    await act(async () => {
      findButton(host, 'pwa.updateNow').click()
    })

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('в аварийном баннере «Обновить» без ожидающего SW перезагружает страницу', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('ver:9.9.9', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    expect(host.textContent).toContain('pwa.updateAvailable')

    await act(async () => {
      findButton(host, 'pwa.updateNow').click()
    })

    expect(reloadSpy).toHaveBeenCalled()
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('не обновляется при первой установке без controller', async () => {
    container.controller = null
    container.registration = new MockRegistration(new MockWaitingWorker())

    const host = await mountPrompt()

    expect(host.textContent).not.toContain('pwa.updateAvailable')
    expect(reloadSpy).not.toHaveBeenCalled()
  })
})
