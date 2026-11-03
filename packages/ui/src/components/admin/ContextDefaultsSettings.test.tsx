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
  DEFAULT_CONTEXT_DEFAULTS,
  type ContextDefaultsSource,
  type ContextDefaultsValues,
} from '@/lib/api/contextDefaults'
import { ContextDefaultsSettings } from './ContextDefaultsSettings'

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

const RUNTIME_DEFAULTS: ContextDefaultsValues = {
  contextOptimization: 'summarization',
  summarizationEnabled: true,
  summarizationTriggerMode: 'tokens',
  summarizeAfterN: 20,
  summarizeTokenThreshold: 80,
  summarizationHeadMessages: 2,
  summarizationTailMessages: 4,
  summarizationKeepTokens: 6000,
  compactionKeepTokens: 12000,
  compactionTokenThreshold: 90,
  slidingWindowMode: 'messages',
  slidingWindowMessageLimit: 20,
  slidingWindowTokenThreshold: 80,
}

function response(
  defaults: ContextDefaultsValues = RUNTIME_DEFAULTS,
  source: ContextDefaultsSource = 'runtime',
) {
  return { defaults, saved: { ...defaults }, source, restartRequired: false }
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
          <ContextDefaultsSettings />
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

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement | null, label: string): Promise<void> {
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger!.click()
  })
  const options = [...document.body.querySelectorAll('[role="option"]')]
  const option = options.find((o) => o.textContent?.trim().startsWith(label)) as
    | HTMLElement
    | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
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

describe('ContextDefaultsSettings — загрузка', () => {
  it('показывает значения, источник и подсказку про новые сессии', async () => {
    stubFetch(() => ({ body: response() }))
    const container = await renderSettings()

    expect(byTestId(container, 'context-defaults-load-error')).toBeNull()
    expect(byTestId(container, 'context-defaults-source-badge')?.textContent).toContain('runtime')
    expect(byTestId(container, 'context-defaults-new-sessions-hint')?.textContent).toContain(
      'new sessions',
    )
    expect(byTestId(container, 'context-defaults-strategy')?.textContent).toContain('Summarization')
    expect(byTestId(container, 'context-defaults-strategy-hint')?.textContent).toContain(
      'compressed into a summary',
    )
    expect((byTestId(container, 'context-defaults-summarize-after') as HTMLInputElement).value).toBe(
      '20',
    )
    expect(
      (byTestId(container, 'context-defaults-summarize-threshold') as HTMLInputElement).value,
    ).toBe('80')
    expect(
      (byTestId(container, 'context-defaults-summarization-keep') as HTMLInputElement).value,
    ).toBe('6000')
    expect((byTestId(container, 'context-defaults-compaction-keep') as HTMLInputElement).value).toBe(
      '12000',
    )
    expect(
      (byTestId(container, 'context-defaults-compaction-threshold') as HTMLInputElement).value,
    ).toBe('90')
    expect(byTestId(container, 'context-defaults-reset')).not.toBeNull()
  })

  it('не показывает устаревшие head/tail и тумблер суммаризации (стратегия — переключатель)', async () => {
    stubFetch(() => ({ body: response() }))
    const container = await renderSettings()

    expect(byTestId(container, 'context-defaults-summarization-head')).toBeNull()
    expect(byTestId(container, 'context-defaults-summarization-tail')).toBeNull()
    expect(byTestId(container, 'context-defaults-summarization-toggle')).toBeNull()
    expect(
      container.querySelector('[data-testid="context-defaults-summarization"] [role="switch"]'),
    ).toBeNull()
  })

  it('ошибка загрузки показывается сообщением и повторяет запрос', async () => {
    let fail = true
    stubFetch(() => (fail ? { status: 500, body: { detail: 'boom' } } : { body: response() }))
    const container = await renderSettings()

    const error = byTestId(container, 'context-defaults-load-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('boom')
    expect(byTestId(container, 'context-defaults-strategy')).toBeNull()

    fail = false
    await click(byTestId(container, 'context-defaults-retry'))
    expect(byTestId(container, 'context-defaults-load-error')).toBeNull()
    expect(byTestId(container, 'context-defaults-strategy')).not.toBeNull()
  })
})

describe('ContextDefaultsSettings — сохранение', () => {
  it('выбор стратегии «Компактизация» → PUT с частичным патчем и подсказкой', async () => {
    let state = RUNTIME_DEFAULTS
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        const patch = JSON.parse(call.body ?? '{}').defaults as Partial<ContextDefaultsValues>
        state = { ...state, ...patch }
      }
      return { body: response(state) }
    })
    const container = await renderSettings()

    await selectOption(byTestId(container, 'context-defaults-strategy'), 'Compaction')

    const put = calls.find((call) => call.method === 'PUT')
    expect(put?.url).toBe('/api/v2/settings/context-defaults')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      defaults: { contextOptimization: 'compaction' },
    })
    expect(byTestId(container, 'context-defaults-strategy')?.textContent).toContain('Compaction')
    expect(byTestId(container, 'context-defaults-strategy-hint')?.textContent).toContain(
      'working state',
    )
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('изменение числа (blur) → PUT с патчем; невалидное число не сохраняется', async () => {
    let state = RUNTIME_DEFAULTS
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        const patch = JSON.parse(call.body ?? '{}').defaults as Partial<ContextDefaultsValues>
        state = { ...state, ...patch }
      }
      return { body: response(state) }
    })
    const container = await renderSettings()

    const input = byTestId(container, 'context-defaults-summarize-after') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '35')
    })
    await blur(input)

    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
    expect(JSON.parse(calls.find((call) => call.method === 'PUT')?.body ?? '{}')).toEqual({
      defaults: { summarizeAfterN: 35 },
    })

    // 0 не проходит клиентскую валидацию — запроса нет, показана ошибка.
    const afterInvalid = calls.filter((call) => call.method === 'PUT').length
    await act(async () => {
      setInputValue(input, '0')
    })
    await blur(input)
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(afterInvalid)
    expect(container.textContent).toContain('Enter an integer')
  })

  it('поля компактизации сохраняются частичным патчем (порог — проценты)', async () => {
    let state = RUNTIME_DEFAULTS
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        const patch = JSON.parse(call.body ?? '{}').defaults as Partial<ContextDefaultsValues>
        state = { ...state, ...patch }
      }
      return { body: response(state) }
    })
    const container = await renderSettings()

    const keep = byTestId(container, 'context-defaults-compaction-keep') as HTMLInputElement
    await act(async () => {
      setInputValue(keep, '20000')
    })
    await blur(keep)

    expect(JSON.parse(calls.find((call) => call.method === 'PUT')?.body ?? '{}')).toEqual({
      defaults: { compactionKeepTokens: 20000 },
    })

    const threshold = byTestId(container, 'context-defaults-compaction-threshold') as HTMLInputElement
    await act(async () => {
      setInputValue(threshold, '101')
    })
    await blur(threshold)
    // 101 % не проходит валидацию процентов — второго запроса нет.
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
    expect(container.textContent).toContain('from 1 to 100')
  })

  it('400 от сервера → сообщение и откат к серверному значению', async () => {
    stubFetch((call) =>
      call.method === 'PUT'
        ? { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'invalid default' } } }
        : { body: response() },
    )
    const container = await renderSettings()

    const input = byTestId(container, 'context-defaults-compaction-keep') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '20000')
    })
    await blur(input)

    expect(byTestId(container, 'context-defaults-action-error')?.textContent).toContain(
      'invalid default',
    )
    expect(
      (byTestId(container, 'context-defaults-compaction-keep') as HTMLInputElement).value,
    ).toBe('12000')
  })
})

describe('ContextDefaultsSettings — сброс', () => {
  it('при source=runtime кнопка сброса вызывает DELETE и убирает себя', async () => {
    let source: ContextDefaultsSource = 'runtime'
    const calls = stubFetch((call) => {
      if (call.method === 'DELETE') source = 'default'
      return {
        body: response(source === 'default' ? DEFAULT_CONTEXT_DEFAULTS : RUNTIME_DEFAULTS, source),
      }
    })
    const container = await renderSettings()

    await click(byTestId(container, 'context-defaults-reset'))

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
    expect(byTestId(container, 'context-defaults-reset')).toBeNull()
    expect(byTestId(container, 'context-defaults-source-badge')?.textContent).toContain('default')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('при source=config кнопки сброса нет (нет runtime-значения)', async () => {
    stubFetch(() => ({ body: response(RUNTIME_DEFAULTS, 'config') }))
    const container = await renderSettings()

    expect(byTestId(container, 'context-defaults-source-badge')?.textContent).toContain(
      'Default',
    )
    expect(byTestId(container, 'context-defaults-reset')).toBeNull()
  })
})
