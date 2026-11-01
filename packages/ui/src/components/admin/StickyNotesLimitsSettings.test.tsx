import { afterEach, describe, expect, it, vi } from 'vitest'
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
  notify: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DEFAULT_STICKY_NOTES_LIMITS,
  type StickyNotesLimits,
  type StickyNotesLimitsSource,
} from '@/lib/api/stickyNotesLimits'
import { StickyNotesLimitsSettings } from './StickyNotesLimitsSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface FetchCall {
  url: string
  method: string
  body?: string
}

interface FetchResult {
  status?: number
  body: unknown
}

/** Стаб `fetch`: запоминает вызовы и отвечает по методу (GET/PUT/DELETE). */
function stubFetch(handler: (call: FetchCall) => FetchResult): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : undefined,
      }
      calls.push(call)
      const result = handler(call)
      const status = result.status ?? 200
      return {
        ok: status < 400,
        status,
        json: async () => result.body,
      } as unknown as Response
    }),
  )
  return calls
}

const RUNTIME_LIMITS: StickyNotesLimits = { maxCount: 30, maxChars: 1000 }

function response(
  limits: StickyNotesLimits = RUNTIME_LIMITS,
  source: StickyNotesLimitsSource = 'runtime',
) {
  return {
    limits,
    saved: source === 'runtime' ? { ...limits } : null,
    defaults: DEFAULT_STICKY_NOTES_LIMITS,
    source,
    restartRequired: false,
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
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
          <StickyNotesLimitsSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function blur(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.focus()
    el.blur()
  })
  await flush()
}

async function click(el: HTMLElement | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    el!.click()
  })
  await flush()
  await flush()
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocks.notify.mockReset()
  document.body.innerHTML = ''
})

describe('StickyNotesLimitsSettings — загрузка', () => {
  it('показывает оба поля, источник и подсказку про лимиты инстанса', async () => {
    stubFetch(() => ({ body: response() }))
    const container = await renderSettings()

    expect(byTestId(container, 'sticky-notes-load-error')).toBeNull()
    expect(container.querySelector('[data-settings-section="context-sticky-notes"]')).not.toBeNull()
    expect(container.textContent).toContain('Notes')
    expect(byTestId(container, 'sticky-notes-source-badge')?.textContent).toContain('runtime')
    expect(byTestId(container, 'sticky-notes-hint')?.textContent).toContain(
      'apply to all sessions',
    )
    expect((byTestId(container, 'sticky-notes-max-count') as HTMLInputElement).value).toBe('30')
    expect((byTestId(container, 'sticky-notes-max-chars') as HTMLInputElement).value).toBe('1000')
    expect(byTestId(container, 'sticky-notes-reset')).not.toBeNull()
  })

  it('ошибка загрузки показывается сообщением и повторяет запрос', async () => {
    let fail = true
    stubFetch(() => (fail ? { status: 500, body: { detail: 'boom' } } : { body: response() }))
    const container = await renderSettings()

    const error = byTestId(container, 'sticky-notes-load-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('boom')
    expect(byTestId(container, 'sticky-notes-max-count')).toBeNull()

    fail = false
    await click(byTestId(container, 'sticky-notes-retry'))
    expect(byTestId(container, 'sticky-notes-load-error')).toBeNull()
    expect(byTestId(container, 'sticky-notes-max-count')).not.toBeNull()
  })

  it('при source=config кнопки сброса нет', async () => {
    stubFetch(() => ({ body: response(RUNTIME_LIMITS, 'config') }))
    const container = await renderSettings()
    expect(byTestId(container, 'sticky-notes-source-badge')?.textContent).toContain('Default')
    expect(byTestId(container, 'sticky-notes-reset')).toBeNull()
  })
})

describe('StickyNotesLimitsSettings — сохранение', () => {
  it('изменение числа (blur) → PUT с частичным патчем limits', async () => {
    let state = RUNTIME_LIMITS
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        const patch = JSON.parse(call.body ?? '{}').limits as Partial<StickyNotesLimits>
        state = { ...state, ...patch }
      }
      return { body: response(state) }
    })
    const container = await renderSettings()

    const input = byTestId(container, 'sticky-notes-max-count') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '60')
    })
    await blur(input)

    const put = calls.find((call) => call.method === 'PUT')
    expect(put?.url).toBe('/api/v2/settings/sticky-notes')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ limits: { maxCount: 60 } })
    expect(input.value).toBe('60')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('значение вне границ не уходит в PUT, показывается ошибка поля', async () => {
    const calls = stubFetch(() => ({ body: response() }))
    const container = await renderSettings()

    const maxCount = byTestId(container, 'sticky-notes-max-count') as HTMLInputElement
    await act(async () => {
      setInputValue(maxCount, '0')
    })
    await blur(maxCount)
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(container.textContent).toContain('Enter an integer from 1 to 1000')

    const maxChars = byTestId(container, 'sticky-notes-max-chars') as HTMLInputElement
    await act(async () => {
      setInputValue(maxChars, '100001')
    })
    await blur(maxChars)
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(container.textContent).toContain('Enter an integer from 1 to 100000')
  })

  it('400 от сервера → сообщение и откат к серверному значению', async () => {
    stubFetch((call) =>
      call.method === 'PUT'
        ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'invalid limits' } } }
        : { body: response() },
    )
    const container = await renderSettings()

    const input = byTestId(container, 'sticky-notes-max-count') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '80')
    })
    await blur(input)

    expect(byTestId(container, 'sticky-notes-action-error')?.textContent).toContain(
      'invalid limits',
    )
    expect(input.value).toBe('30')
  })
})

describe('StickyNotesLimitsSettings — сброс', () => {
  it('при source=runtime кнопка сброса вызывает DELETE и убирает себя', async () => {
    let source: StickyNotesLimitsSource = 'runtime'
    const calls = stubFetch((call) => {
      if (call.method === 'DELETE') source = 'default'
      return {
        body: response(
          source === 'default' ? DEFAULT_STICKY_NOTES_LIMITS : RUNTIME_LIMITS,
          source,
        ),
      }
    })
    const container = await renderSettings()

    await click(byTestId(container, 'sticky-notes-reset'))

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
    expect(byTestId(container, 'sticky-notes-reset')).toBeNull()
    expect(byTestId(container, 'sticky-notes-source-badge')?.textContent).toContain('default')
    expect(mocks.notify).toHaveBeenCalled()
  })
})
