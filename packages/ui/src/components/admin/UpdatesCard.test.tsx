import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  confirm: vi.fn(async () => true),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { synthApi } from '@/lib/api/synthApi'
import {
  updatesApi,
  type UpdateCheckResult,
  type UpdateDoneEvent,
  type UpdatesSettings,
} from '@/lib/api/updates'
import type { RestartStatus } from '@/lib/api/synthApi'
import { UpdatesCard } from './UpdatesCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SETTINGS: UpdatesSettings = {
  check: false,
  source: 'default',
  envLocked: false,
  channel: 'auto',
  intervalHours: 24,
  stableRegistry: 'https://registry.npmjs.org',
  betaRegistry: 'https://git.itphx.ru/api/packages/itphx/npm/',
  restartRequired: false,
}

const CHECK_UPDATE: UpdateCheckResult = {
  currentVersion: '0.19.0',
  latestVersion: '0.20.0',
  channel: 'stable',
  prerelease: false,
  registry: 'https://registry.npmjs.org',
  hasUpdate: true,
  checkedAt: '2026-11-11T10:00:00.000Z',
}

const CHECK_CURRENT: UpdateCheckResult = {
  ...CHECK_UPDATE,
  latestVersion: '0.19.0',
  hasUpdate: false,
}

const RESTART_SUPPORTED: RestartStatus = {
  supported: true,
  mode: 'supervisor',
  startedAt: '2026-11-11T09:00:00.000Z',
  version: '0.19.0',
}

const RESTART_DISABLED: RestartStatus = {
  supported: false,
  mode: 'disabled',
  reason: 'restart mode is disabled',
  startedAt: '2026-11-11T09:00:00.000Z',
  version: '0.19.0',
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

async function renderCard(onReload: () => void = () => undefined): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <UpdatesCard onReload={onReload} pollIntervalMs={1} restartTimeoutMs={200} />
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
  return container
}

async function clickElement(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
  await flush()
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await clickElement(el as HTMLElement)
}

/** Клик по самому тумблеру (обёртка `data-testid` клика не перехватывает). */
async function clickSwitch(container: HTMLElement, wrapperTestId: string): Promise<void> {
  const sw = byTestId(container, wrapperTestId)?.querySelector('[role="switch"]')
  expect(sw, `тумблер ${wrapperTestId}`).toBeTruthy()
  await clickElement(sw as HTMLElement)
}

let getSettings: MockInstance
let putSettings: MockInstance
let handleCheckUpdates: MockInstance
let applyUpdates: MockInstance
let getRestart: MockInstance
let getHealth: MockInstance

beforeEach(() => {
  vi.clearAllMocks()
  mocks.confirm.mockResolvedValue(true)
  getSettings = vi
    .spyOn(updatesApi, 'getUpdatesSettings')
    .mockResolvedValue(SETTINGS)
  putSettings = vi
    .spyOn(updatesApi, 'putUpdatesSettings')
    .mockResolvedValue({ ...SETTINGS, check: true, source: 'runtime' })
  handleCheckUpdates = vi
    .spyOn(updatesApi, 'checkUpdates')
    .mockResolvedValue(CHECK_UPDATE)
  applyUpdates = vi
    .spyOn(updatesApi, 'applyUpdate')
    .mockImplementation(async (_input, onEvent) => {
      onEvent({ type: 'start', message: 'npm install -g @itphx/synth@0.20.0' })
      onEvent({ type: 'progress', data: 'added 1 package' })
      onEvent({ type: 'stderr', data: 'npm warn deprecated' })
      onEvent({
        type: 'done',
        version: '0.20.0',
        restartScheduled: false,
        message: 'installed',
      } satisfies UpdateDoneEvent)
    })
  getRestart = vi.spyOn(synthApi, 'getRestartStatus').mockResolvedValue(RESTART_SUPPORTED)
  getHealth = vi.spyOn(synthApi, 'getHealth').mockResolvedValue({
    status: 'ok',
    version: '0.19.0',
    time: '2026-11-11T10:00:00.000Z',
    startedAt: '2026-11-11T09:00:00.000Z',
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
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('UpdatesCard (ADR-133)', () => {
  it('показывает текущую версию, канал и выключенную автопроверку', async () => {
    const container = await renderCard()

    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'updates-current')?.textContent).toContain('Current version')
    // Канал установленной версии — badge (в тестовой сборке версия стабильная).
    expect(byTestId(container, 'updates-channel-badge')?.textContent).toBe('stable')

    const toggle = byTestId(container, 'updates-auto-check-toggle')?.querySelector('[role="switch"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-checked')).toBe('false')
    expect(toggle!.hasAttribute('disabled')).toBe(false)
  })

  it('тумблер автопроверки сохраняет значение через PUT и показывает тост', async () => {
    const container = await renderCard()

    await clickSwitch(container, 'updates-auto-check-toggle')

    expect(putSettings).toHaveBeenCalledWith({ check: true })
    const toggle = byTestId(container, 'updates-auto-check-toggle')?.querySelector('[role="switch"]')
    expect(toggle!.getAttribute('aria-checked')).toBe('true')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Update settings saved', type: 'success' }),
    )
  })

  it('при envLocked тумблер заблокирован и показана подсказка', async () => {
    getSettings.mockResolvedValue({ ...SETTINGS, envLocked: true, source: 'env', check: true })
    const container = await renderCard()

    const toggle = byTestId(container, 'updates-auto-check-toggle')?.querySelector('[role="switch"]')
    expect(toggle!.hasAttribute('disabled')).toBe(true)
    expect(toggle!.getAttribute('aria-checked')).toBe('true')
    expect(byTestId(container, 'updates-env-locked')?.textContent).toContain(
      'Set by an environment variable',
    )
    expect(putSettings).not.toHaveBeenCalled()
  })

  it('«Проверить» всегда форсирует проверку и показывает доступную версию', async () => {
    const container = await renderCard()

    await click(container, 'updates-check')

    expect(handleCheckUpdates).toHaveBeenCalledWith({ channel: 'auto', force: true })
    expect(byTestId(container, 'updates-check-summary')?.textContent).toBe(
      'Version 0.20.0 is available',
    )
    // Кнопка «Обновить» появляется только при hasUpdate.
    expect(byTestId(container, 'updates-apply')).not.toBeNull()
  })

  it('«Обновить» отправляет версию/канал/рестарт и обрабатывает done', async () => {
    const container = await renderCard()

    await click(container, 'updates-check')
    await click(container, 'updates-apply')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(applyUpdates).toHaveBeenCalledTimes(1)
    const [input, , signal] = applyUpdates.mock.calls[0]!
    expect(input).toEqual({ version: '0.20.0', channel: 'stable', restart: true })
    expect(signal).toBeInstanceOf(AbortSignal)

    expect(byTestId(container, 'updates-done')?.textContent).toContain(
      'Update installed. Restart the instance',
    )
    expect(byTestId(container, 'updates-done')?.textContent).toContain('Installed version: 0.20.0')
    // Без restartScheduled оверлея нет, перезагрузка не запрашивается.
    expect(byTestId(container, 'updates-restart-overlay')).toBeNull()
  })

  it('409 UPDATE_UNSUPPORTED — причина показана, кнопка недоступна', async () => {
    applyUpdates.mockRejectedValue(
      Object.assign(new Error('instance is managed by Kubernetes'), {
        status: 409,
        code: 'UPDATE_UNSUPPORTED',
      }),
    )
    const container = await renderCard()

    await click(container, 'updates-check')
    await click(container, 'updates-apply')

    expect(byTestId(container, 'updates-unsupported')?.textContent).toContain(
      'instance is managed by Kubernetes',
    )
    const apply = byTestId(container, 'updates-apply') as HTMLButtonElement
    expect(apply.hasAttribute('disabled')).toBe(true)
  })

  it('не показывает «Обновить», если установлена последняя версия', async () => {
    handleCheckUpdates.mockResolvedValue(CHECK_CURRENT)
    const container = await renderCard()

    await click(container, 'updates-check')

    expect(byTestId(container, 'updates-check-summary')?.textContent).toBe(
      'The latest version is installed',
    )
    expect(byTestId(container, 'updates-apply')).toBeNull()
  })

  it('после установки с рестартом ждёт новый startedAt и перезагружает страницу', async () => {
    applyUpdates.mockImplementation(async (_input, onEvent) => {
      onEvent({ type: 'done', version: '0.20.0', restartScheduled: true, message: 'installed' })
    })
    const onReload = vi.fn()
    const container = await renderCard(onReload)

    await click(container, 'updates-check')
    // Baseline (до установки) — старый старт, дальше — новый процесс.
    getHealth.mockResolvedValueOnce({
      status: 'ok',
      version: '0.19.0',
      time: '2026-11-11T10:00:00.000Z',
      startedAt: '2026-11-11T09:00:00.000Z',
    })
    getHealth.mockResolvedValue({
      status: 'ok',
      version: '0.20.0',
      time: '2026-11-11T10:05:00.000Z',
      startedAt: '2026-11-11T10:05:00.000Z',
    })

    await click(container, 'updates-apply')
    expect(byTestId(container, 'updates-restart-overlay')).not.toBeNull()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    await flush()

    expect(getHealth).toHaveBeenCalled()
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('перезапуск недоступен — чекбокс рестарта заблокирован с причиной', async () => {
    getRestart.mockResolvedValue(RESTART_DISABLED)
    const container = await renderCard()

    await click(container, 'updates-check')

    const checkbox = byTestId(container, 'updates-restart-after') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.hasAttribute('disabled')).toBe(true)
    expect(byTestId(container, 'updates-restart-option')?.textContent).toContain(
      'Restart is unavailable: restart mode is disabled',
    )
  })
})
