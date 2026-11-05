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

// Сборка бандла с известным build id: серверный build сравнивается с ним.
vi.mock('@/lib/build-info', () => ({ BUILD_ID: 'local-build' }))

// Связь: перезагрузка при обновлении допускается только при `online`
// (на экране входа транспорта нет — authPhase !== 'authenticated').
// Настоящие zustand-сторы (минимальные): компонент читает фазы через хуки,
// а тестам нужен `setState`, меняющий состояние с уведомлением подписчиков.
const connection = vi.hoisted(() => ({
  transport: null as unknown as { setState: (patch: { phase: string }) => void },
  auth: null as unknown as { setState: (patch: { authPhase: string }) => void },
}))
vi.mock('@/stores/transportStore', async () => {
  const { create } = await import('zustand')
  const store = create<{ phase: string }>()(() => ({ phase: 'online' }))
  connection.transport = store
  return { useTransportStore: store }
})
vi.mock('@/stores/authStore', async () => {
  const { create } = await import('zustand')
  const store = create<{ authPhase: string }>()(() => ({ authPhase: 'authenticated' }))
  connection.auth = store
  return { useAuthStore: store }
})

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
let cacheKeys: string[]
let cachesMock: { keys: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }
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
  connection.transport.setState({ phase: 'online' })
  connection.auth.setState({ authPhase: 'authenticated' })
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
  cacheKeys = []
  cachesMock = {
    keys: vi.fn(async () => [...cacheKeys]),
    delete: vi.fn(async (key: string) => {
      cacheKeys = cacheKeys.filter((item) => item !== key)
      return true
    }),
  }
  vi.stubGlobal('caches', cachesMock)
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
  vi.unstubAllGlobals()
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

  it('расхождение build id — чистит кэши, обновляет SW и перезагружает', async () => {
    cacheKeys = ['synth-shell-0.13.3', 'synth-shell-0.13.3-old']
    container.controller = {}
    const registration = new MockRegistration(null)
    container.registration = registration
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, build: 'server-build' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(cachesMock.keys).toHaveBeenCalled()
    expect(cachesMock.delete).toHaveBeenCalledWith('synth-shell-0.13.3')
    expect(cachesMock.delete).toHaveBeenCalledWith('synth-shell-0.13.3-old')
    expect(registration.update).toHaveBeenCalled()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('pwa.updateAvailable')
    expect(readAutoReload()).toEqual({ key: 'build:server-build', count: 1 })
  })

  it('совпадающий build id — не трогает кэши и не перезагружает', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, build: 'local-build' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(cachesMock.keys).not.toHaveBeenCalled()
    expect(cachesMock.delete).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('пустой build id на сервере — фоллбек на сравнение версии', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9', build: '' })

    await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(cachesMock.keys).not.toHaveBeenCalled()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(readAutoReload()).toEqual({ key: 'ver:9.9.9', count: 1 })
  })

  it('после 2 авто-попыток на тот же build id показывает аварийный баннер', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    seedAutoReload('build:server-build', 2)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, build: 'server-build' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(cachesMock.keys).not.toHaveBeenCalled()
    expect(host.textContent).toContain('pwa.updateAvailable')
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

  it('связь потеряна (phase !== online) — не перезагружает при расхождении версий', async () => {
    connection.transport.setState({ phase: 'reconnecting' })
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()

    expect(reloadSpy).not.toHaveBeenCalled()
    // Авто-попытка не израсходована — применится после восстановления связи.
    expect(readAutoReload()).toBeNull()
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('отложенное обновление применяется при восстановлении связи (phase → online)', async () => {
    connection.transport.setState({ phase: 'reconnecting' })
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(readAutoReload()).toBeNull()

    await act(async () => {
      connection.transport.setState({ phase: 'online' })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(readAutoReload()).toEqual({ key: 'ver:9.9.9', count: 1 })
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('authPhase=unreachable — не перезагружает при расхождении версий и не тратит авто-попытку', async () => {
    connection.auth.setState({ authPhase: 'unreachable' })
    connection.transport.setState({ phase: 'connecting' })
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reloadSpy).not.toHaveBeenCalled()
    // Авто-попытка отложена: счётчик в sessionStorage не появился.
    expect(readAutoReload()).toBeNull()
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('authPhase=checking — перезагрузка откладывается (не тратит авто-попытку)', async () => {
    connection.auth.setState({ authPhase: 'checking' })
    connection.transport.setState({ phase: 'connecting' })
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockResolvedValue({ ...HEALTH_OK, version: '9.9.9' })

    const host = await mountPrompt()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(reloadSpy).not.toHaveBeenCalled()
    expect(readAutoReload()).toBeNull()
    expect(host.textContent).not.toContain('pwa.updateAvailable')
  })

  it('health недоступен — не перезагружает и не показывает баннер', async () => {
    container.controller = {}
    container.registration = new MockRegistration(null)
    getHealthMock.mockRejectedValue(new Error('network'))

    const host = await mountPrompt()

    expect(reloadSpy).not.toHaveBeenCalled()
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
