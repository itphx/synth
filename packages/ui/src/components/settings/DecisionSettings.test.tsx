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

// Провайдеры/модели: только `decision`/`systemone` — decision-протокол (AD-084).
const providersStore = vi.hoisted(() => ({
  providers: [
    { name: 'routerai-decision', type: 'decision', enabled: true },
    { name: 'ollama-systemone', type: 'systemone', enabled: true },
    { name: 'openai', type: 'openai', enabled: true },
    { name: 'disabled-decision', type: 'decision', enabled: false },
  ],
  models: [
    { name: 'clef-flash', provider: 'routerai-decision', enabled: true },
    { name: 'clef', provider: 'routerai-decision', enabled: true },
    { name: 'gpt-4o', provider: 'openai', enabled: true },
  ],
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/stores/providersStore', () => ({
  useProvidersStore: (selector: (s: typeof providersStore) => unknown) => selector(providersStore),
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
  provider: '',
  model: '',
  confidenceThreshold: 0.6,
}

const OVERRIDDEN: DecisionSettingsData = {
  enabled: true,
  provider: 'routerai-decision',
  model: 'clef-flash',
  confidenceThreshold: 0.75,
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

/** Открывает Base UI select и возвращает список опций (опции рендерятся в portal). */
async function openOptions(trigger: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    trigger.click()
  })
  const listId = trigger.getAttribute('aria-controls')
  const scope = listId ? document.getElementById(listId) ?? document.body : document.body
  return [...scope.querySelectorAll('[role="option"]')] as HTMLElement[]
}

/** Открывает Base UI select и кликает опцию по подписи. */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  const allOptions = await openOptions(trigger)
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

const providerTrigger = (container: HTMLElement) =>
  container.querySelector('[data-testid="decision-config-provider"]') as HTMLElement
const modelTrigger = (container: HTMLElement) =>
  container.querySelector('[data-testid="decision-config-model"]') as HTMLElement

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

  it('показывает значения из API (provider/model/threshold)', async () => {
    const container = await renderSettings()

    expect(providerTrigger(container).textContent).toContain('routerai-decision')
    expect(modelTrigger(container).textContent).toContain('clef-flash')
    expect(
      (container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement).value,
    ).toBe('0.75')

    // Мастер-выключатель отражает enabled из API.
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('провайдер-селект показывает только decision-провайдеры', async () => {
    const container = await renderSettings()

    const options = (await openOptions(providerTrigger(container))).map((o) => o.textContent?.trim())
    expect(options).toContain('routerai-decision')
    expect(options).toContain('ollama-systemone')
    expect(options).not.toContain('openai')
    expect(options).not.toContain('disabled-decision')
  })

  it('модели фильтруются по выбранному провайдеру', async () => {
    const container = await renderSettings()

    const options = (await openOptions(modelTrigger(container))).map((o) => o.textContent?.trim())
    expect(options).toContain('clef-flash')
    expect(options).toContain('clef')
    expect(options).not.toContain('gpt-4o')
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

    const confidence = container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement
    await act(async () => {
      setInputValue(confidence, '0.8')
    })

    const save = container.querySelector('[data-testid="decision-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.updateDecisionSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateDecisionSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceThreshold: 0.8,
        enabled: true,
        provider: 'routerai-decision',
        model: 'clef-flash',
      }),
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

  it('смена провайдера сбрасывает модель и попадает в сохранение', async () => {
    const container = await renderSettings()

    await selectOption(providerTrigger(container), 'ollama-systemone')
    expect(providerTrigger(container).textContent).toContain('ollama-systemone')

    await clickTestId(container, 'decision-config-save')
    await act(async () => {})

    expect(mocks.updateDecisionSettings).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ollama-systemone', model: '' }),
    )
  })

  it('Cancel откатывает черновик к сохранённым значениям', async () => {
    const container = await renderSettings()

    const confidence = container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement
    await act(async () => {
      setInputValue(confidence, '0.99')
    })
    expect(confidence.value).toBe('0.99')

    await clickTestId(container, 'decision-config-cancel')
    expect(
      (container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement).value,
    ).toBe('0.75')
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
    expect(
      (container.querySelector('[data-testid="decision-config-confidence"]') as HTMLInputElement).value,
    ).toBe('0.6')
    expect(providerTrigger(container).textContent ?? '').not.toContain('routerai-decision')
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
    expect(enDict['decisionConfig.providerModel']).toBeTruthy()
    expect(ruDict['decisionConfig.providerModel']).toBeTruthy()
    expect(enDict['decisionConfig.confidenceThreshold']).toBeTruthy()
    expect(ruDict['decisionConfig.confidenceThreshold']).toBeTruthy()
  })
})
