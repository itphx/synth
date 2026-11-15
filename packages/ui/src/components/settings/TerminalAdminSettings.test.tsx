/**
 * `TerminalAdminSettings` — админ-раздел «Терминалы» (PROP-132).
 *
 * Контракт:
 * - тумблеры `terminal.enabled` / `terminal.autoRestore` сохраняются через
 *   `PUT /api/v2/settings/terminal`;
 * - значение, зафиксированное env (`SYNTH_TERMINAL_ENABLED`), блокирует
 *   правку из UI: контролы недоступны, а серверный `409` показывается
 *   понятным уведомлением;
 * - рядом — справочный блок о поведении терминалов на инстансе.
 */

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
  update: vi.fn(),
  reset: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/terminalSettings', () => ({
  terminalSettingsApi: {
    getTerminalSettings: mocks.get,
    updateTerminalSettings: mocks.update,
    resetTerminalSettings: mocks.reset,
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import type { TerminalSettings } from '@/lib/api/terminalSettings'
import { TerminalAdminSettings } from './TerminalAdminSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Снимок настроек терминалов (ответ `GET /api/v2/settings/terminal`). */
const SETTINGS: TerminalSettings = {
  enabled: true,
  autoRestore: false,
  source: 'default',
  defaults: { enabled: true, autoRestore: false },
  envLocked: false,
  restartRequired: false,
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

/** Кнопка по подписи (у `SettingsActions` в этом разделе нет `data-testid`). */
function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
  return buttons.find((btn) => btn.textContent?.trim() === text) ?? null
}

/** Тумблер внутри блока (по `data-testid` обёртки). */
function toggleIn(container: HTMLElement, wrapperTestId: string): HTMLButtonElement | null {
  return byTestId(container, wrapperTestId)?.querySelector('[role="switch"]') ?? null
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
        <TerminalAdminSettings />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue({ ...SETTINGS })
  mocks.update.mockResolvedValue({ ...SETTINGS })
  mocks.reset.mockResolvedValue({ ...SETTINGS })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('TerminalAdminSettings — runtime-настройки', () => {
  it('загружает настройки и показывает источник и дефолты', async () => {
    const container = await renderSettings()

    expect(mocks.get).toHaveBeenCalled()
    expect(byTestId(container, 'terminal-settings-source-badge')?.textContent).toBe('default')
    expect(byTestId(container, 'terminal-settings-env-badge')).toBeNull()
    expect(container.textContent).toContain('true')
    expect(container.textContent).toContain('false')
  })

  it('переключение тумблера сохраняется через updateTerminalSettings', async () => {
    const container = await renderSettings()

    const enabled = toggleIn(container, 'terminal-settings-enabled-toggle') as HTMLButtonElement
    const autoRestore = toggleIn(container, 'terminal-settings-auto-restore-toggle') as HTMLButtonElement
    expect(enabled.getAttribute('aria-checked')).toBe('true')
    expect(autoRestore.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      autoRestore.click()
    })
    await flush()
    expect(autoRestore.getAttribute('aria-checked')).toBe('true')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith({ enabled: true, autoRestore: true })
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal settings saved' }),
    )
  })

  it('выключение мастер-тумблера уходит в настройки', async () => {
    const container = await renderSettings()

    const enabled = toggleIn(container, 'terminal-settings-enabled-toggle') as HTMLButtonElement
    await act(async () => {
      enabled.click()
    })
    await flush()

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledWith({ enabled: false, autoRestore: false })
  })
})

describe('TerminalAdminSettings — фиксация через ENV', () => {
  it('env-значение: баннер, бейдж и недоступные контролы', async () => {
    mocks.get.mockResolvedValue({
      ...SETTINGS,
      source: 'env',
      envLocked: true,
    })
    const container = await renderSettings()

    expect(byTestId(container, 'terminal-settings-env-badge')).not.toBeNull()
    expect(byTestId(container, 'terminal-settings-env-banner')).not.toBeNull()
    expect(byTestId(container, 'terminal-settings-source-badge')?.textContent).toBe('set via ENV')

    const enabled = toggleIn(container, 'terminal-settings-enabled-toggle') as HTMLButtonElement
    // ToggleField при `disabled` не пропускает клики (pointer-events-none + noop-обработчик).
    expect(enabled.parentElement?.className).toContain('pointer-events-none')
    await act(async () => {
      enabled.click()
    })
    expect(enabled.getAttribute('aria-checked')).toBe('true')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('409 при сохранении — понятное уведомление и блок ошибки', async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error('terminal.enabled is fixed by SYNTH_TERMINAL_ENABLED'), {
        status: 409,
      }),
    )
    const container = await renderSettings()

    const autoRestore = toggleIn(container, 'terminal-settings-auto-restore-toggle') as HTMLButtonElement
    await act(async () => {
      autoRestore.click()
    })
    await flush()

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        text: 'The value is fixed by an environment variable',
      }),
    )
    expect(byTestId(container, 'terminal-settings-action-error')?.textContent).toContain(
      'environment variable',
    )
  })

  it('409 при сохранении — успешный тост не показывается', async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error('terminal.enabled is fixed by SYNTH_TERMINAL_ENABLED'), {
        status: 409,
      }),
    )
    const container = await renderSettings()

    const autoRestore = toggleIn(container, 'terminal-settings-auto-restore-toggle') as HTMLButtonElement
    await act(async () => {
      autoRestore.click()
    })
    await flush()

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal settings saved' }),
    )
    // Значение, зафиксированное env, — контролы блокируются.
    expect(byTestId(container, 'terminal-settings-env-banner')).not.toBeNull()
  })

  it('ошибка, отличная от 409, — текст ошибки без env-блокировки', async () => {
    mocks.update.mockRejectedValue(new Error('network is down'))
    const container = await renderSettings()

    const autoRestore = toggleIn(container, 'terminal-settings-auto-restore-toggle') as HTMLButtonElement
    await act(async () => {
      autoRestore.click()
    })
    await flush()

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(byTestId(container, 'terminal-settings-action-error')?.textContent).toContain(
      'network is down',
    )
    expect(byTestId(container, 'terminal-settings-env-banner')).toBeNull()
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal settings saved' }),
    )
  })

  it('409 при сбросе — то же уведомление об env-фиксации', async () => {
    mocks.get.mockResolvedValue({ ...SETTINGS, source: 'runtime', autoRestore: true })
    mocks.reset.mockRejectedValue(
      Object.assign(new Error('terminal.enabled is fixed by SYNTH_TERMINAL_ENABLED'), {
        status: 409,
      }),
    )
    const container = await renderSettings()

    const reset = buttonByText(container, 'Reset') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    await act(async () => {
      reset.click()
    })
    await flush()

    expect(mocks.reset).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        text: 'The value is fixed by an environment variable',
      }),
    )
    expect(byTestId(container, 'terminal-settings-action-error')?.textContent).toContain(
      'environment variable',
    )
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal settings reset to defaults' }),
    )
  })
})

describe('TerminalAdminSettings — справочный блок', () => {
  it('показывает правила жизни терминалов на инстансе', async () => {
    const container = await renderSettings()

    const reference = container.querySelector(
      '[data-settings-section="terminals-reference"]',
    ) as HTMLElement | null
    expect(reference, 'справочный блок не найден').not.toBeNull()
    expect(reference?.textContent).toContain('Idle lifetime')
    expect(reference?.textContent).toContain('2 days')
    expect(reference?.textContent).toContain('Limits')
    expect(reference?.textContent).toContain('8 per project, 32 per instance')
    expect(reference?.textContent).toContain('Command audit')
    expect(reference?.textContent).toContain('Shell')
  })
})
