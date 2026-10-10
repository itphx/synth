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
  getDecisionSettings: vi.fn(),
  updateDecisionSettings: vi.fn(),
  resetDecisionSettings: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DecisionSettings } from './DecisionSettings'
import { CATEGORIES } from './SettingsModal'
import type { DecisionSettings as DecisionSettingsData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const DEFAULTS: DecisionSettingsData = {
  enabled: false,
  mode: 'auto',
  provider: '',
  model: '',
  escalationModel: '',
  timeoutMs: 10000,
  confidenceThreshold: 0.6,
  remoteEndpoint: '',
}

const OVERRIDDEN: DecisionSettingsData = {
  enabled: true,
  mode: 'remote',
  provider: 'routerai-decision',
  model: 'clef-flash',
  escalationModel: 'clef',
  timeoutMs: 5000,
  confidenceThreshold: 0.75,
  remoteEndpoint: 'https://routerai.ru/api/v1',
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const clickTestId = async (container: HTMLElement, testId: string) => {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const listId = trigger.getAttribute('aria-controls')
  const scope = listId ? document.getElementById(listId) ?? document.body : document.body
  const allOptions = [...scope.querySelectorAll('[role="option"]')]
  const option = allOptions.find((o) => o.textContent?.trim().startsWith(label)) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
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
          <DecisionSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getDecisionSettings.mockResolvedValue({
    decision: OVERRIDDEN,
    defaults: DEFAULTS,
    isOverridden: true,
  })
  mocks.updateDecisionSettings.mockImplementation(async (decision: DecisionSettingsData) => ({ decision }))
  mocks.resetDecisionSettings.mockResolvedValue({
    decision: DEFAULTS,
    defaults: DEFAULTS,
    isOverridden: false,
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

describe('DecisionSettings — админ-раздел «Decision-модели» (AD-084)', () => {
  it('загружает настройки и рендерит заголовок/описание', async () => {
    const container = await renderSettings()

    expect(mocks.getDecisionSettings).toHaveBeenCalledTimes(1)
    const header = container.querySelector('header')!
    expect(header.textContent).toContain('Decision models')
    expect(container.textContent).toContain('Runtime settings for the decision layer')
  })

  it('показывает значения из API (provider/model/timeout/threshold)', async () => {
    const container = await renderSettings()

    expect((container.querySelector('[data-testid="decision-config-provider"]') as HTMLInputElement).value).toBe(
      'routerai-decision',
    )
    expect((container.querySelector('[data-testid="decision-config-model"]') as HTMLInputElement).value).toBe(
      'clef-flash',
    )
    expect((container.querySelector('[data-testid="decision-config-timeout"]') as HTMLInputElement).value).toBe(
      '5000',
    )
    expect((container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement).value).toBe(
      '0.75',
    )
    expect(
      (container.querySelector('[data-testid="decision-config-remote-endpoint"]') as HTMLInputElement).value,
    ).toBe('https://routerai.ru/api/v1')

    // Мастер-выключатель отражает enabled из API.
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('у полей есть иконка-подсказка (tooltip) с текстом', async () => {
    const container = await renderSettings()

    const tooltips = container.querySelectorAll('[data-testid="settings-field-tooltip"]')
    expect(tooltips.length).toBeGreaterThan(0)
    expect(tooltips[0].getAttribute('aria-label')).toBeTruthy()
  })

  it('сохраняет изменённые параметры через updateDecisionSettings', async () => {
    const container = await renderSettings()

    // До правок Save/Cancel заблокированы.
    expect((container.querySelector('[data-testid="decision-config-save"]') as HTMLButtonElement).disabled).toBe(true)

    const timeout = container.querySelector('[data-testid="decision-config-timeout"]') as HTMLInputElement
    await act(async () => {
      setInputValue(timeout, '8000')
    })

    const save = container.querySelector('[data-testid="decision-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.updateDecisionSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateDecisionSettings).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 8000, enabled: true, mode: 'remote', provider: 'routerai-decision' }),
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', category: 'system' }),
    )
  })

  it('тумблер enabled становится частью черновика', async () => {
    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await clickTestId(container, 'decision-config-save')
    await act(async () => {})

    expect(mocks.updateDecisionSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it('переключение транспорта (mode) попадает в сохранение', async () => {
    const container = await renderSettings()

    const trigger = container.querySelector('[data-testid="decision-config-mode"]') as HTMLElement
    await selectOption(trigger, 'Local (Ollama)')

    await clickTestId(container, 'decision-config-save')
    await act(async () => {})

    expect(mocks.updateDecisionSettings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'local' }),
    )
  })

  it('Cancel откатывает черновик к сохранённым значениям', async () => {
    const container = await renderSettings()

    const timeout = container.querySelector('[data-testid="decision-config-timeout"]') as HTMLInputElement
    await act(async () => {
      setInputValue(timeout, '9999')
    })
    expect(timeout.value).toBe('9999')

    await clickTestId(container, 'decision-config-cancel')
    expect((container.querySelector('[data-testid="decision-config-timeout"]') as HTMLInputElement).value).toBe('5000')
  })

  it('Reset вызывает resetDecisionSettings и подставляет дефолты', async () => {
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="decision-config-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    // Значения отличаются от дефолта — Reset активен и цветной.
    expect(reset.disabled).toBe(false)

    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(mocks.resetDecisionSettings).toHaveBeenCalledTimes(1)
    expect((container.querySelector('[data-testid="decision-config-timeout"]') as HTMLInputElement).value).toBe(
      '10000',
    )
    expect((container.querySelector('[data-testid="decision-config-provider"]') as HTMLInputElement).value).toBe('')
  })

  it('Reset серый/неактивен, когда значения равны серверному дефолту', async () => {
    mocks.getDecisionSettings.mockResolvedValue({
      decision: DEFAULTS,
      defaults: DEFAULTS,
      isOverridden: false,
    })
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="decision-config-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    expect(reset.className).toContain('border-muted-foreground')
  })

  it('показывает ошибку загрузки', async () => {
    mocks.getDecisionSettings.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
  })
})

describe('DecisionSettings — права доступа (ADMIN) и i18n (AD-084)', () => {
  it('категория «Decision-модели» — только ADMIN', () => {
    const config = CATEGORIES.find((cat) => cat.id === 'decisionConfig')!
    expect(config).toBeDefined()
    expect(config.roles).toEqual(['ADMIN'])
  })

  it('ADMIN видит админ-раздел, USER — нет', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map((c) => c.id)

    expect(visibleFor(['ADMIN'])).toContain('decisionConfig')
    expect(visibleFor(['LEAD'])).not.toContain('decisionConfig')
    expect(visibleFor(['USER'])).not.toContain('decisionConfig')
  })

  it('ключи «Decision-модели» есть в ru и en словарях', () => {
    expect(enDict['settings.category.decision']).toBeTruthy()
    expect(ruDict['settings.category.decision']).toBeTruthy()
    expect(enDict['decisionConfig.title']).toBeTruthy()
    expect(ruDict['decisionConfig.title']).toBeTruthy()
    expect(enDict['decisionConfig.confidenceThreshold']).toBeTruthy()
    expect(ruDict['decisionConfig.confidenceThreshold']).toBeTruthy()
  })
})
