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
  notify: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  getContextWindowPolicy,
  resetContextWindowPolicyCache,
} from '@/lib/api/contextWindowSettings'
import { useUIStore } from '@/stores/useUIStore'
import { ContextWindowSettings } from './ContextWindowSettings'

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

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

const radios = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

async function flush(): Promise<void> {
  await act(async () => {})
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useUIStore.setState({ settingsShowAdvanced: true, settingsFocus: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ContextWindowSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

async function clickRadio(container: HTMLElement, index: number): Promise<void> {
  const radio = radios(container)[index]
  expect(radio, `radio #${index}`).toBeTruthy()
  await act(async () => {
    radio!.click()
  })
  await flush()
  await flush()
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId}`).toBeTruthy()
  await act(async () => {
    el!.click()
  })
  await flush()
  await flush()
}

const RUNTIME_SETTINGS = {
  policy: 'warn',
  saved: 'warn',
  defaults: 'warn',
  source: 'runtime',
  envLocked: false,
  restartRequired: false,
}

beforeEach(() => {
  resetContextWindowPolicyCache()
})

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
  resetContextWindowPolicyCache()
  document.body.innerHTML = ''
})

describe('ContextWindowSettings — загрузка', () => {
  it('показывает текущую политику, источник и описания режимов', async () => {
    stubFetch(() => ({ body: RUNTIME_SETTINGS }))
    const container = await renderSettings()

    expect(byTestId(container, 'context-window-load-error')).toBeNull()
    expect(byTestId(container, 'context-window-source-badge')?.textContent).toContain('runtime')
    expect(radios(container).map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(byTestId(container, 'context-window-mode-warn')?.getAttribute('data-active')).toBe('true')
    expect(byTestId(container, 'context-window-mode-enforce')?.getAttribute('data-active')).toBe(
      'false',
    )
    // Кнопка сброса доступна: значение — runtime-override.
    expect(byTestId(container, 'context-window-reset')).not.toBeNull()
    expect(byTestId(container, 'context-window-env-banner')).toBeNull()
  })

  it('ошибка загрузки показывается сообщением', async () => {
    stubFetch(() => ({ status: 500, body: { detail: 'boom' } }))
    const container = await renderSettings()

    const error = byTestId(container, 'context-window-load-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('boom')
    expect(byTestId(container, 'context-window-policy')).toBeNull()
  })
})

describe('ContextWindowSettings — сохранение', () => {
  it('выбор enforce → PUT {policy:"enforce"} и обновление кэша хука', async () => {
    const calls = stubFetch((call) =>
      call.method === 'PUT'
        ? {
            body: {
              ...RUNTIME_SETTINGS,
              policy: 'enforce',
              saved: 'enforce',
            },
          }
        : { body: RUNTIME_SETTINGS },
    )
    const container = await renderSettings()

    await clickRadio(container, 2)

    const put = calls.find((call) => call.method === 'PUT')
    expect(put).toBeDefined()
    expect(put?.url).toBe('/api/v2/settings/context-window')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ policy: 'enforce' })
    expect(getContextWindowPolicy()).toBe('enforce')
    expect(radios(container)[2]?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.notify).toHaveBeenCalled()
  })

  it('409 (env) → баннер, контрол заблокирован, ошибка показана', async () => {
    stubFetch((call) =>
      call.method === 'PUT'
        ? { status: 409, body: { error: { code: 'CONFLICT', message: 'env locked' } } }
        : { body: RUNTIME_SETTINGS },
    )
    const container = await renderSettings()

    await clickRadio(container, 2)

    expect(byTestId(container, 'context-window-env-banner')?.textContent).toContain(
      'SYNTH_CONTEXT_WINDOW_POLICY',
    )
    expect(radios(container).every((radio) => radio.disabled)).toBe(true)
    expect(byTestId(container, 'context-window-action-error')?.textContent).toContain(
      'SYNTH_CONTEXT_WINDOW_POLICY',
    )
  })

  it('source=env при загрузке → баннер и disabled без сохранения', async () => {
    stubFetch(() => ({
      body: {
        policy: 'enforce',
        saved: null,
        defaults: 'warn',
        source: 'env',
        envLocked: true,
        restartRequired: false,
      },
    }))
    const container = await renderSettings()

    expect(byTestId(container, 'context-window-env-banner')).not.toBeNull()
    expect(radios(container).every((radio) => radio.disabled)).toBe(true)
    // Сброс доступен только при runtime-значении.
    expect(byTestId(container, 'context-window-reset')).toBeNull()
  })
})

describe('ContextWindowSettings — сброс', () => {
  it('кнопка сброса вызывает DELETE и обновляет состояние', async () => {
    const calls = stubFetch((call) =>
      call.method === 'DELETE'
        ? {
            body: {
              policy: 'warn',
              saved: null,
              defaults: 'warn',
              source: 'default',
              envLocked: false,
              restartRequired: false,
            },
          }
        : { body: { ...RUNTIME_SETTINGS, policy: 'off', saved: 'off' } },
    )
    const container = await renderSettings()

    await clickTestId(container, 'context-window-reset')

    expect(calls.some((call) => call.method === 'DELETE')).toBe(true)
    expect(getContextWindowPolicy()).toBe('warn')
    expect(radios(container)[1]?.getAttribute('aria-checked')).toBe('true')
    expect(byTestId(container, 'context-window-reset')).toBeNull()
    expect(mocks.notify).toHaveBeenCalled()
  })
})
