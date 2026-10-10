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
  getEventsSettings: vi.fn(),
  updateEventsSettings: vi.fn(),
  resetEventsSettings: vi.fn(),
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
import { EventsSettings } from './EventsSettings'
import { CATEGORIES } from './SettingsModal'
import type { EventsSettings as EventsSettingsData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const DEFAULTS: EventsSettingsData = {
  enabled: true,
  defaultMode: 'bound',
  ephemeralTtl: '24h',
  journalRetentionDays: 30,
  allowedSources: ['telegram'],
  unknownAgentTemplate: 'drop',
  keyRateLimitPerMinute: 0,
  decisionRouting: false,
}

const OVERRIDDEN: EventsSettingsData = {
  enabled: false,
  defaultMode: 'ephemeral',
  ephemeralTtl: '15m',
  journalRetentionDays: 7,
  allowedSources: ['telegram', 'ci'],
  unknownAgentTemplate: 'default-agent',
  keyRateLimitPerMinute: 60,
  decisionRouting: false,
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
          <EventsSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getEventsSettings.mockResolvedValue({
    events: OVERRIDDEN,
    defaults: DEFAULTS,
    isOverridden: true,
  })
  mocks.updateEventsSettings.mockImplementation(async (events: EventsSettingsData) => ({ events }))
  mocks.resetEventsSettings.mockResolvedValue({
    events: DEFAULTS,
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

describe('EventsSettings — админ-раздел «Параметры событий» (AD-089)', () => {
  it('загружает настройки и рендерит заголовок/описание', async () => {
    const container = await renderSettings()

    expect(mocks.getEventsSettings).toHaveBeenCalledTimes(1)
    const header = container.querySelector('header')!
    expect(header.textContent).toContain('Event settings')
    expect(container.textContent).toContain('Runtime settings for external event handling')
  })

  it('показывает значения из API (enabled/mode/ttl/retention/key limit)', async () => {
    const container = await renderSettings()

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    expect((container.querySelector('[data-testid="events-config-ephemeral-ttl"]') as HTMLInputElement).value).toBe(
      '15m',
    )
    expect(
      (container.querySelector('[data-testid="events-config-journal-retention"]') as HTMLInputElement).value,
    ).toBe('7')
    expect((container.querySelector('[data-testid="events-config-key-rate"]') as HTMLInputElement).value).toBe(
      '60',
    )
  })

  it('у полей есть иконка-подсказка (tooltip) с текстом', async () => {
    const container = await renderSettings()

    const tooltips = container.querySelectorAll('[data-testid="settings-field-tooltip"]')
    expect(tooltips.length).toBeGreaterThan(0)
    expect(tooltips[0].getAttribute('aria-label')).toBeTruthy()
  })

  it('сохраняет изменённые параметры через updateEventsSettings', async () => {
    const container = await renderSettings()

    // До правок Save/Cancel заблокированы.
    expect((container.querySelector('[data-testid="events-config-save"]') as HTMLButtonElement).disabled).toBe(true)

    const rate = container.querySelector('[data-testid="events-config-key-rate"]') as HTMLInputElement
    await act(async () => {
      setInputValue(rate, '120')
    })

    const save = container.querySelector('[data-testid="events-config-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.updateEventsSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateEventsSettings).toHaveBeenCalledWith(
      expect.objectContaining({ keyRateLimitPerMinute: 120, enabled: false, defaultMode: 'ephemeral' }),
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
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await clickTestId(container, 'events-config-save')
    await act(async () => {})

    expect(mocks.updateEventsSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('тумблер decisionRouting (AD-084) становится частью черновика и сохраняется', async () => {
    const container = await renderSettings()

    const decisionToggle = container.querySelector(
      `[role="switch"][aria-label="${enDict['eventsConfig.decisionRouting']}"]`,
    ) as HTMLButtonElement
    expect(decisionToggle).not.toBeNull()
    expect(decisionToggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      decisionToggle.click()
    })
    expect(decisionToggle.getAttribute('aria-checked')).toBe('true')

    await clickTestId(container, 'events-config-save')
    await act(async () => {})

    expect(mocks.updateEventsSettings).toHaveBeenCalledWith(
      expect.objectContaining({ decisionRouting: true }),
    )
  })

  it('Cancel откатывает черновик к сохранённым значениям', async () => {
    const container = await renderSettings()

    const rate = container.querySelector('[data-testid="events-config-key-rate"]') as HTMLInputElement
    await act(async () => {
      setInputValue(rate, '999')
    })
    expect(rate.value).toBe('999')

    await clickTestId(container, 'events-config-cancel')
    expect((container.querySelector('[data-testid="events-config-key-rate"]') as HTMLInputElement).value).toBe('60')
  })

  it('Reset вызывает resetEventsSettings и подставляет дефолты', async () => {
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="events-config-reset"]') as HTMLButtonElement
    expect(reset).not.toBeNull()
    // Значения отличаются от дефолта — Reset активен и цветной.
    expect(reset.disabled).toBe(false)

    await act(async () => {
      reset.click()
    })
    await act(async () => {})

    expect(mocks.resetEventsSettings).toHaveBeenCalledTimes(1)
    expect((container.querySelector('[data-testid="events-config-key-rate"]') as HTMLInputElement).value).toBe('0')
    expect((container.querySelector('[data-testid="events-config-ephemeral-ttl"]') as HTMLInputElement).value).toBe(
      '24h',
    )
  })

  it('Reset серый/неактивен, когда значения равны серверному дефолту', async () => {
    mocks.getEventsSettings.mockResolvedValue({
      events: DEFAULTS,
      defaults: DEFAULTS,
      isOverridden: false,
    })
    const container = await renderSettings()

    const reset = container.querySelector('[data-testid="events-config-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    expect(reset.className).toContain('border-muted-foreground')
  })

  it('показывает ошибку загрузки', async () => {
    mocks.getEventsSettings.mockRejectedValueOnce(new Error('boom'))
    const container = await renderSettings()

    expect(container.querySelector('[role="alert"]')!.textContent).toContain('boom')
  })
})

describe('EventsSettings — права доступа (ADMIN) и i18n (AD-089)', () => {
  it('категория «Параметры событий» — только ADMIN, user-раздел «События» — без ролей', () => {
    const config = CATEGORIES.find((cat) => cat.id === 'eventsConfig')!
    expect(config).toBeDefined()
    expect(config.roles).toEqual(['ADMIN'])

    const userEvents = CATEGORIES.find((cat) => cat.id === 'eventsAdmin')!
    expect(userEvents.roles).toBeUndefined()
  })

  it('ADMIN видит админ-раздел, USER — нет', () => {
    const visibleFor = (roles: string[]) =>
      CATEGORIES.filter((cat) => !cat.roles || cat.roles.some((r) => roles.includes(r))).map((c) => c.id)

    expect(visibleFor(['ADMIN'])).toContain('eventsConfig')
    expect(visibleFor(['LEAD'])).not.toContain('eventsConfig')
    expect(visibleFor(['USER'])).not.toContain('eventsConfig')
    // Пользовательский раздел виден всем.
    expect(visibleFor(['USER'])).toContain('eventsAdmin')
  })

  it('ключи «Параметры событий» есть в ru и en словарях', () => {
    expect(enDict['settings.category.eventsConfig']).toBeTruthy()
    expect(ruDict['settings.category.eventsConfig']).toBeTruthy()
    expect(enDict['eventsConfig.title']).toBeTruthy()
    expect(ruDict['eventsConfig.title']).toBeTruthy()
    expect(enDict['eventsConfig.keyRateLimitPerMinute']).toBeTruthy()
    expect(ruDict['eventsConfig.keyRateLimitPerMinute']).toBeTruthy()
    expect(enDict['eventsConfig.decisionRouting']).toBeTruthy()
    expect(ruDict['eventsConfig.decisionRouting']).toBeTruthy()
  })
})
