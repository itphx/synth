/**
 * `TerminalAdminSettings` — админ-раздел «Терминалы» (PROP-132).
 *
 * Контракт:
 * - общие параметры (`terminal.enabled` / `terminal.autoRestore`) и параметры
 *   выполнения (`idleMinutes`, `maxPerProject`, `maxPerInstance`, `shell`,
 *   `auditInput`) сохраняются одним PUT `PUT /api/v2/settings/terminal`;
 * - поле, зафиксированное env (`envLockedFields`), блокирует правку из UI:
 *   контрол недоступен, у поля бейдж «ENV», а в баннере — список полей;
 * - серверный `409` показывается понятным уведомлением, успешный тост при этом
 *   не показывается;
 * - невалидное значение (вне границ) блокирует Save и подсвечивается полем.
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

vi.mock('@/lib/api/terminalSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminalSettings')>()
  return {
    ...actual,
    terminalSettingsApi: {
      getTerminalSettings: mocks.get,
      updateTerminalSettings: mocks.update,
      resetTerminalSettings: mocks.reset,
    },
  }
})

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
  idleMinutes: 2880,
  maxPerProject: 8,
  maxPerInstance: 32,
  shell: 'bash',
  auditInput: true,
  source: 'default',
  sources: {
    enabled: 'default',
    autoRestore: 'default',
    idleMinutes: 'default',
    maxPerProject: 'default',
    maxPerInstance: 'default',
    shell: 'default',
    auditInput: 'default',
  },
  defaults: {
    enabled: true,
    autoRestore: false,
    idleMinutes: 2880,
    maxPerProject: 8,
    maxPerInstance: 32,
    shell: 'bash',
    auditInput: true,
  },
  envLocked: false,
  envLockedFields: [],
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

/** Значение поля по `id`. */
function inputById(container: HTMLElement, id: string): HTMLInputElement {
  const input = container.querySelector(`#${id}`) as HTMLInputElement | null
  if (!input) throw new Error(`поле #${id} не найдено`)
  return input
}

/** Ввод значения в контролируемое поле (как в `MultimodalSettings.test.tsx`). */
async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
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
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, autoRestore: true }),
    )
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

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })
})

describe('TerminalAdminSettings — карточка «Параметры выполнения»', () => {
  it('карточка на месте со всеми полями', async () => {
    const container = await renderSettings()

    const limits = byTestId(container, 'terminal-settings-limits')
    expect(limits, 'карточка «Параметры выполнения» не найдена').not.toBeNull()
    expect(limits?.textContent).toContain('Execution parameters')

    // Секция с id `terminals-limits` (поиск по настройкам идёт по нему).
    const section = container.querySelector('[data-settings-section="terminals-limits"]')
    expect(section, 'секция terminals-limits не найдена').not.toBeNull()

    expect(inputById(container, 'terminal-settings-idle').value).toBe('2880')
    expect(inputById(container, 'terminal-settings-max-per-project').value).toBe('8')
    expect(inputById(container, 'terminal-settings-max-per-instance').value).toBe('32')
    expect(inputById(container, 'terminal-settings-shell').value).toBe('bash')
    expect(toggleIn(container, 'terminal-settings-audit-toggle')?.getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('старый справочный блок удалён', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-settings-section="terminals-reference"]')).toBeNull()
    expect(container.textContent).not.toContain('How terminals behave')
  })

  it('правка простоя, лимитов и оболочки уходит в PUT', async () => {
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-idle'), '1440')
    await setInputValue(inputById(container, 'terminal-settings-max-per-project'), '12')
    await setInputValue(inputById(container, 'terminal-settings-max-per-instance'), '40')
    await setInputValue(inputById(container, 'terminal-settings-shell'), '/bin/zsh')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith({
      enabled: true,
      autoRestore: false,
      idleMinutes: 1440,
      maxPerProject: 12,
      maxPerInstance: 40,
      shell: '/bin/zsh',
      auditInput: true,
    })
  })

  it('пустая оболочка уходит как null', async () => {
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-shell'), '')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ shell: null }))
  })

  it('невалидное значение блокирует Save и показывает ошибку', async () => {
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-idle'), '5')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(container.textContent).toContain('Value is out of range')

    await act(async () => {
      save.click()
    })
    await flush()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('невалидная оболочка блокирует Save', async () => {
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-shell'), 'zsh -l')

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

describe('TerminalAdminSettings — фиксация через ENV', () => {
  it('env-поле: контрол выключен, бейдж «ENV», остальные активны', async () => {
    mocks.get.mockResolvedValue({
      ...SETTINGS,
      envLocked: true,
      envLockedFields: ['shell'],
    })
    const container = await renderSettings()

    const shell = inputById(container, 'terminal-settings-shell')
    expect(shell.disabled).toBe(true)
    expect(byTestId(container, 'terminal-settings-shell-env-badge')?.textContent).toBe('ENV')

    // Остальные поля не зафиксированы — доступны.
    expect(inputById(container, 'terminal-settings-idle').disabled).toBe(false)
    expect(inputById(container, 'terminal-settings-max-per-project').disabled).toBe(false)
    expect(byTestId(container, 'terminal-settings-idle-env-badge')).toBeNull()

    // Баннер перечисляет зафиксированные поля.
    const banner = byTestId(container, 'terminal-settings-env-banner')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('Default shell')

    // Зафиксированное поле не уходит в PUT.
    await setInputValue(inputById(container, 'terminal-settings-idle'), '1440')
    const save = buttonByText(container, 'Save') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    await flush()

    expect(mocks.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ shell: expect.anything() }),
    )
  })

  it('все поля зафиксированы env — Save недоступен', async () => {
    mocks.get.mockResolvedValue({
      ...SETTINGS,
      envLocked: true,
      envLockedFields: [
        'enabled',
        'autoRestore',
        'idleMinutes',
        'maxPerProject',
        'maxPerInstance',
        'shell',
        'auditInput',
      ],
    })
    const container = await renderSettings()

    const save = buttonByText(container, 'Save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('409 при сохранении — баннер, warning-тост и без успешного тоста', async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error('terminal.shell is fixed by SYNTH_TERMINAL_SHELL'), {
        status: 409,
        code: 'ENV_LOCKED',
        fields: ['shell'],
      }),
    )
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-max-per-project'), '12')

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
    expect(byTestId(container, 'terminal-settings-env-banner')).not.toBeNull()
    expect(byTestId(container, 'terminal-settings-action-error')?.textContent).toContain(
      'environment variable',
    )
    expect(mocks.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal settings saved' }),
    )
  })

  it('ошибка, отличная от 409, — текст ошибки без env-блокировки', async () => {
    mocks.update.mockRejectedValue(new Error('network is down'))
    const container = await renderSettings()

    await setInputValue(inputById(container, 'terminal-settings-max-per-project'), '12')

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
