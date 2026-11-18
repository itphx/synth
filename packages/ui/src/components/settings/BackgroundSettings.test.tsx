import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => void data.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({ notify: vi.fn() }))

vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BackgroundSettings } from './BackgroundSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

interface FetchCall { url: string; method: string; body?: string }
interface FetchResult { status?: number; body: unknown }

function stubFetch(handler: (call: FetchCall) => FetchResult): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const result = handler(call)
    const status = result.status ?? 200
    return { ok: status < 400, status, json: async () => result.body } as unknown as Response
  }))
  return calls
}

const byTestId = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${id}"]`)

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement =>
  Array.from(container.querySelectorAll('button'))
    .find((btn) => (btn.textContent ?? '').includes(text)) as HTMLButtonElement

/** Изменить controlled-инпут так, чтобы React увидел `onChange`. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <BackgroundSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.notify.mockClear()
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
  vi.clearAllMocks()
})

const VIEW = {
  enabled: true,
  maxSubagentsPerSession: 2,
  maxProcessesPerSession: 3,
  maxRunsPerSession: 5,
  logMaxBytes: 1048576,
  retentionDays: 7,
  saved: null,
  defaults: {
    enabled: true,
    maxSubagentsPerSession: 1,
    maxProcessesPerSession: 1,
    maxRunsPerSession: 1,
    logMaxBytes: 0,
    retentionDays: 0,
  },
  source: 'config',
  sources: {},
  envLocked: false,
  envLockedFields: [],
  restartRequired: false,
}

describe('BackgroundSettings', () => {
  it('рендерит значения, сохраняет частичный патч и сбрасывает runtime', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') {
        return { body: { ...VIEW, maxRunsPerSession: 9, saved: { maxRunsPerSession: 9 }, source: 'runtime' } }
      }
      if (call.method === 'DELETE') return { body: { ...VIEW, source: 'config' } }
      return { body: VIEW }
    })
    const container = await render()

    expect(byTestId(container, 'background-settings-source-badge')?.textContent).toContain('config')
    const input = byTestId(container, 'background-settings-max-runs')?.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('5')

    await typeInto(input, '9')
    await act(async () => {
      buttonByText(container, 'Save').click()
    })

    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toBe(JSON.stringify({ maxRunsPerSession: 9 }))
    expect(byTestId(container, 'background-settings-source-badge')?.textContent).toContain('runtime')

    await act(async () => {
      buttonByText(container, 'Reset').click()
    })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(byTestId(container, 'background-settings-source-badge')?.textContent).toContain('config')
  })

  it('409 ENV_LOCKED подсвечивает fields и блокирует поле', async () => {
    stubFetch((call) =>
      call.method === 'PUT'
        ? {
            status: 409,
            body: {
              error: {
                code: 'ENV_LOCKED',
                message: 'background: fixed',
                fields: ['maxRunsPerSession'],
              },
            },
          }
        : { body: VIEW },
    )
    const container = await render()

    const input = byTestId(container, 'background-settings-max-runs')?.querySelector('input') as HTMLInputElement
    await typeInto(input, '9')
    await act(async () => {
      buttonByText(container, 'Save').click()
    })

    expect(byTestId(container, 'background-settings-action-error')).not.toBeNull()
    expect(byTestId(container, 'background-settings-env-banner')).not.toBeNull()
    const locked = byTestId(container, 'background-settings-max-runs')?.querySelector('input') as HTMLInputElement
    expect(locked.disabled).toBe(true)
  })

  it('отрицательный лимит не отправляется', async () => {
    const calls = stubFetch(() => ({ body: VIEW }))
    const container = await render()

    const input = byTestId(container, 'background-settings-log-max-bytes')?.querySelector('input') as HTMLInputElement
    await typeInto(input, '-1')

    expect(buttonByText(container, 'Save').disabled).toBe(true)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })
})
