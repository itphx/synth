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
  get: vi.fn(),
  setEnabled: vi.fn(),
  reset: vi.fn(),
  status: vi.fn(),
  setToken: vi.fn(),
  deleteToken: vi.fn(),
  restartInstance: vi.fn(),
  notify: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn(async () => true) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ObservabilitySettings,
  SCRAPE_CONFIG,
  STATUS_POLL_INTERVAL_MS,
  formatUptime,
} from './ObservabilitySettings'
import type { MetricsSettingsInfo, MetricsStatus } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const INFO: MetricsSettingsInfo = {
  metrics: { enabled: false },
  defaults: { enabled: false },
  isOverridden: false,
  source: 'default',
  running: false,
  restartRequired: false,
  token: { configured: false, source: 'none' },
  endpoints: { metrics: '/metrics', ready: '/ready' },
}

const STATUS: MetricsStatus = {
  enabled: false,
  running: false,
  source: 'default',
  restartRequired: false,
  ready: true,
  storage: 'ok',
  storageBackend: 'file',
  version: '1.2.3',
  uptimeSec: 3600,
  exposition: { series: 12, bytes: 2048, droppedSeries: 3 },
  token: { configured: false, source: 'none' },
  endpoints: { metrics: '/metrics', ready: '/ready' },
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
  await flush()
}

/** Устанавливает значение контролируемого input так, чтобы React увидел `onChange`. */
async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
          <ObservabilitySettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue(INFO)
  mocks.status.mockResolvedValue(STATUS)
  mocks.setEnabled.mockResolvedValue({ ...INFO, metrics: { enabled: true } })
  mocks.reset.mockResolvedValue(INFO)
  mocks.setToken.mockResolvedValue({
    token: { configured: true, source: 'file' },
  })
  mocks.deleteToken.mockResolvedValue({
    token: { configured: false, source: 'none' },
  })
  mocks.restartInstance.mockResolvedValue({
    status: 'restarting',
    restartId: 'rst_test',
    mode: 'process',
    startedAt: '2026-10-19T00:00:00.000Z',
  })
  mocks.writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mocks.writeText },
    configurable: true,
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const entry = roots.pop()!
    await act(async () => {
      entry.root.unmount()
    })
    entry.container.remove()
  }
})

describe('ObservabilitySettings — статус и настройки', () => {
  it('загружает настройки и показывает состояние экспорта', async () => {
    const container = await renderSettings()

    expect(mocks.get).toHaveBeenCalled()
    expect(mocks.status).toHaveBeenCalled()

    expect(byTestId(container, 'observability-source-badge')?.textContent).toBe('default')
    expect(byTestId(container, 'observability-enabled-badge')?.textContent).toBe('disabled')
    expect(byTestId(container, 'observability-running-badge')?.textContent).toBe('not running')

    const state = byTestId(container, 'observability-status')?.textContent ?? ''
    expect(state).toContain('200 — ready')
    expect(state).toContain('ok')
    expect(state).toContain('file')
    expect(state).toContain('1.2.3')
    expect(state).toContain('1h 0m')
    expect(state).toContain('12')
    expect(state).toContain('2.0 KiB')
    expect(state).toContain('3')

    expect(byTestId(container, 'observability-token-status')?.textContent).toContain(
      'not configured',
    )
    // Токен не задан — удаление недоступно.
    expect((byTestId(container, 'observability-token-delete') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('переключает enabled, сохраняет и обновляет статус', async () => {
    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect((byTestId(container, 'observability-save') as HTMLButtonElement).disabled).toBe(false)

    const callsBefore = mocks.status.mock.calls.length
    await clickTestId(container, 'observability-save')

    expect(mocks.setEnabled).toHaveBeenCalledWith(true)
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.status.mock.calls.length).toBe(callsBefore + 1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Metrics settings saved' }),
    )
  })

  it('показывает баннер restartRequired и перезапускает инстанс', async () => {
    mocks.get.mockResolvedValue({ ...INFO, restartRequired: true })
    mocks.status.mockResolvedValue({ ...STATUS, restartRequired: true })
    const container = await renderSettings()

    expect(byTestId(container, 'observability-restart')).toBeTruthy()
    await clickTestId(container, 'observability-restart-button')

    expect(confirm).toHaveBeenCalled()
    expect(mocks.restartInstance).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Restart request sent' }),
    )
  })

  it('при source=env контролы экспорта и токена недоступны', async () => {
    mocks.get.mockResolvedValue({ ...INFO, source: 'env' })
    mocks.status.mockResolvedValue({
      ...STATUS,
      source: 'env',
      token: { configured: true, source: 'env' },
    })
    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    // ToggleField при `disabled` не пропускает клики (pointer-events-none + noop-обработчик).
    expect(toggle.parentElement?.className).toContain('pointer-events-none')
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    expect((byTestId(container, 'observability-save') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId(container, 'observability-reset') as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId(container, 'observability-env-locked')).toBeTruthy()
    expect((byTestId(container, 'observability-token-input') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((byTestId(container, 'observability-token-set') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((byTestId(container, 'observability-token-generate') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(byTestId(container, 'observability-token-env')).toBeTruthy()
  })

  it('задаёт и удаляет токен (write-only)', async () => {
    const container = await renderSettings()

    const input = byTestId(container, 'observability-token-input') as HTMLInputElement
    expect(input.type).toBe('password')
    await setInputValue(input, 'new-secret')

    await clickTestId(container, 'observability-token-set')
    expect(mocks.setToken).toHaveBeenCalledWith('new-secret')
    expect((byTestId(container, 'observability-token-input') as HTMLInputElement).value).toBe('')

    // После сохранения статус перечитан — токен «задан».
    mocks.status.mockResolvedValue({
      ...STATUS,
      token: { configured: true, source: 'file' },
    })
    mocks.get.mockResolvedValue({
      ...INFO,
      token: { configured: true, source: 'file' },
    })
    await clickTestId(container, 'observability-refresh')
    const del = byTestId(container, 'observability-token-delete') as HTMLButtonElement
    expect(del.disabled).toBe(false)

    await clickTestId(container, 'observability-token-delete')
    expect(confirm).toHaveBeenCalled()
    expect(mocks.deleteToken).toHaveBeenCalledTimes(1)
  })

  it('генерирует токен, показывает его и копирует', async () => {
    const container = await renderSettings()

    const field = byTestId(container, 'observability-token-input') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.type).toBe('password')

    const generate = byTestId(container, 'observability-token-generate') as HTMLButtonElement
    expect(generate.getAttribute('aria-label')).toBe('Generate')
    expect(generate.textContent).toBe('')

    await clickTestId(container, 'observability-token-generate')

    const input = byTestId(container, 'observability-token-input') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value.length).toBe(43)
    expect(input.value).toMatch(/^[A-Za-z0-9_-]+$/)
    const generated = input.value
    expect(mocks.writeText).toHaveBeenCalledWith(generated)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Token generated and copied' }),
    )

    // После сохранения значение снова скрыто и поле очищено.
    await clickTestId(container, 'observability-token-set')
    expect(mocks.setToken).toHaveBeenCalledWith(generated)
    const saved = byTestId(container, 'observability-token-input') as HTMLInputElement
    expect(saved.type).toBe('password')
    expect(saved.value).toBe('')
  })

  it('при недоступном clipboard предлагает скопировать токен вручную', async () => {
    mocks.writeText.mockRejectedValue(new Error('clipboard denied'))
    const container = await renderSettings()

    await clickTestId(container, 'observability-token-generate')

    const input = byTestId(container, 'observability-token-input') as HTMLInputElement
    expect(input.type).toBe('text')
    expect(input.value.length).toBe(43)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Token generated — copy it manually' }),
    )
  })

  it('пустой токен не отправляется', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'observability-token-set')
    expect(mocks.setToken).not.toHaveBeenCalled()
    expect(byTestId(container, 'observability-token-error')?.textContent).toBe('Enter a token')
  })

  it('409 при токене из env показывается понятной ошибкой', async () => {
    mocks.setToken.mockRejectedValue(
      Object.assign(new Error('token is configured via SYNTH_METRICS_TOKEN'), { status: 409 }),
    )
    const container = await renderSettings()

    const input = byTestId(container, 'observability-token-input') as HTMLInputElement
    await setInputValue(input, 'other-secret')
    await clickTestId(container, 'observability-token-set')

    expect(byTestId(container, 'observability-token-error')?.textContent).toContain(
      'SYNTH_METRICS_TOKEN',
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    )
  })

  it('копирует эндпоинты и пример scrape_config', async () => {
    const container = await renderSettings()

    await clickTestId(container, 'observability-copy-metrics')
    expect(mocks.writeText).toHaveBeenCalledWith('/metrics')

    await clickTestId(container, 'observability-copy-ready')
    expect(mocks.writeText).toHaveBeenCalledWith('/ready')

    await clickTestId(container, 'observability-copy-scrape')
    expect(mocks.writeText).toHaveBeenCalledWith(SCRAPE_CONFIG)

    expect(SCRAPE_CONFIG).toContain('job_name: synth')
    expect(SCRAPE_CONFIG).toContain('metrics_path: /metrics')
    expect(SCRAPE_CONFIG).toContain('synth-backend:5000')
    expect(SCRAPE_CONFIG).toContain('15s')

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Copied' }),
    )
  })

  it('ошибка сохранения — тост, черновик остаётся', async () => {
    mocks.setEnabled.mockRejectedValue(new Error('boom'))
    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await clickTestId(container, 'observability-save')

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: 'Failed to save settings: boom',
      }),
    )
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('ошибки загрузки показываются в секциях', async () => {
    mocks.get.mockRejectedValue(new Error('settings down'))
    mocks.status.mockRejectedValue(new Error('status down'))
    const container = await renderSettings()

    expect(byTestId(container, 'observability-info-error')?.textContent).toBe('settings down')
    expect(byTestId(container, 'observability-status-error')?.textContent).toBe('status down')
  })
})

describe('formatUptime', () => {
  it('переводит секунды в человекочитаемый вид', () => {
    expect(formatUptime(0)).toBe('0s')
    expect(formatUptime(45)).toBe('45s')
    expect(formatUptime(125)).toBe('2m 5s')
    expect(formatUptime(3600)).toBe('1h 0m')
    expect(formatUptime(90_061)).toBe('1d 1h')
    expect(formatUptime(-1)).toBe('—')
    expect(formatUptime(Number.NaN)).toBe('—')
  })

  it('период фонового опроса — 15 секунд', () => {
    expect(STATUS_POLL_INTERVAL_MS).toBe(15_000)
  })
})
