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
    clear: () => data.clear(),
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
import { AgentsLimitsSettings } from './AgentsLimitsSettings'

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
          <AgentsLimitsSettings />
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
  subagentMaxInputTokens: 150000,
  saved: null,
  defaults: 0,
  source: 'config',
  envLocked: false,
  restartRequired: false,
}

describe('AgentsLimitsSettings', () => {
  it('загружает значение, сохраняет и сбрасывает', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'PUT') return { body: { ...VIEW, subagentMaxInputTokens: 50000, saved: 50000, source: 'runtime' } }
      if (call.method === 'DELETE') return { body: { ...VIEW, source: 'config' } }
      return { body: VIEW }
    })
    const container = await render()

    expect(byTestId(container, 'agents-limits-source-badge')?.textContent).toContain('config')
    const input = byTestId(container, 'agents-limits-input') as HTMLInputElement
    expect(input.value).toBe('150000')

    await typeInto(input, '50000')
    await act(async () => {
      buttonByText(container, 'Save').click()
    })
    expect(calls.find((c) => c.method === 'PUT')?.body).toContain('50000')

    await act(async () => {
      buttonByText(container, 'Reset').click()
    })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(byTestId(container, 'agents-limits-source-badge')?.textContent).toContain('config')
  })

  it('env-lock: баннер и disabled-контролы; 409 показывает конфликт', async () => {
    stubFetch((call) => call.method === 'PUT'
      ? { status: 409, body: { error: { code: 'CONFLICT' } } }
      : { body: { ...VIEW, source: 'env', envLocked: true, subagentMaxInputTokens: 90000 } })
    const container = await render()

    expect(byTestId(container, 'agents-limits-env-banner')).not.toBeNull()
    const input = byTestId(container, 'agents-limits-input') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('отрицательное значение не отправляется', async () => {
    const calls = stubFetch(() => ({ body: VIEW }))
    const container = await render()
    const input = byTestId(container, 'agents-limits-input') as HTMLInputElement
    await typeInto(input, '-1')
    expect(byTestId(container, 'agents-limits-action-error')).toBeNull()
    const save = buttonByText(container, 'Save')
    expect(save.disabled).toBe(true)
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })
})
