import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({ fetchJSON: vi.fn() }))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

// Base UI Select тяжело управляется в jsdom — подменяем на нативный <select>,
// сохраняя контракт value/onValueChange и вложенность опций.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const fragment = (children: unknown) => React.createElement(React.Fragment, null, children as null)
  return {
    Select: (props: Record<string, unknown>) =>
      React.createElement(
        'select',
        {
          value: props.value as string,
          onChange: (e: { target: { value: string } }) =>
            (props.onValueChange as ((v: string) => void) | undefined)?.(e.target.value),
        },
        props.children as null,
      ),
    SelectTrigger: (props: Record<string, unknown>) => fragment(props.children),
    SelectValue: () => null,
    SelectContent: (props: Record<string, unknown>) => fragment(props.children),
    SelectItem: (props: Record<string, unknown>) =>
      React.createElement('option', { value: props.value as string }, props.children as null),
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { DebugPanel } from './DebugPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG = {
  groups: {
    OPENAI: 'INFO',
    ANTHROPIC: 'INFO',
    ROUTES: 'WARNING',
    STORAGE: 'WARNING',
    DEBUG: 'DEBUG',
    WEBSOCKET: 'INFO',
  },
  available_levels: ['NONE', 'DEBUG', 'INFO', 'WARNING', 'ERROR'],
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <DebugPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function findPostCall() {
  return apiMock.fetchJSON.mock.calls.find(
    (call) => (call[1] as { method?: string } | undefined)?.method === 'POST',
  ) as [string, { method: string; body: string }] | undefined
}

beforeEach(() => {
  apiMock.fetchJSON.mockImplementation(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { status: 'saved' }
    return { ...CONFIG, groups: { ...CONFIG.groups } }
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

describe('DebugPanel — AD-072: действия в каждой секции', () => {
  it('рендерит AI и SERVICE секции с отдельными Save', async () => {
    const container = await renderPanel()

    expect(byTestId(container, 'debug-save-ai')).not.toBeNull()
    expect(byTestId(container, 'debug-save-service')).not.toBeNull()
    expect(byTestId(container, 'debug-save-ai')!.disabled).toBe(true)
    expect(byTestId(container, 'debug-save-service')!.disabled).toBe(true)
  })

  it('Save категории отправляет только её группы и показывает статус', async () => {
    const container = await renderPanel()
    const selects = container.querySelectorAll('select')
    // ai-секция: OPENAI, ANTHROPIC; service-секция: ROUTES, STORAGE, DEBUG, WEBSOCKET
    expect(selects).toHaveLength(6)

    await act(async () => {
      setSelectValue(selects[0] as HTMLSelectElement, 'ERROR')
    })

    expect(byTestId(container, 'debug-save-ai')!.disabled).toBe(false)
    expect(byTestId(container, 'debug-save-service')!.disabled).toBe(true)

    await act(async () => {
      byTestId(container, 'debug-save-ai')!.click()
    })
    await act(async () => {})

    const post = findPostCall()
    expect(post).toBeDefined()
    expect(post![0]).toBe('/api/v2/admin/debug/config')
    expect(JSON.parse(post![1].body)).toEqual({
      groups: { OPENAI: 'ERROR', ANTHROPIC: 'INFO' },
    })
    expect(container.textContent).toContain('Saved')
  })

  it('Cancel возвращает черновик категории к сохранённым значениям', async () => {
    const container = await renderPanel()
    const select = container.querySelectorAll('select')[0] as HTMLSelectElement

    await act(async () => {
      setSelectValue(select, 'ERROR')
    })
    expect(byTestId(container, 'debug-save-ai')!.disabled).toBe(false)

    await act(async () => {
      byTestId(container, 'debug-cancel-ai')!.click()
    })

    expect((container.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('INFO')
    expect(byTestId(container, 'debug-save-ai')!.disabled).toBe(true)
  })

  it('Reset возвращает черновик категории к серверному дефолту', async () => {
    const container = await renderPanel()
    const select = container.querySelectorAll('select')[0] as HTMLSelectElement

    await act(async () => {
      setSelectValue(select, 'ERROR')
    })
    expect((container.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('ERROR')

    await act(async () => {
      byTestId(container, 'debug-reset-ai')!.click()
    })

    expect((container.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('INFO')
    expect(byTestId(container, 'debug-save-ai')!.disabled).toBe(true)
  })

  it('Reset категории серый/неактивен на сохранённых значениях и активен при изменениях', async () => {
    const container = await renderPanel()
    const resetAi = () =>
      container.querySelector('[data-testid="debug-reset-ai"]') as HTMLButtonElement

    expect(resetAi().disabled).toBe(true)
    expect(resetAi().className).toContain('border-muted-foreground')

    await act(async () => {
      setSelectValue(container.querySelectorAll('select')[0] as HTMLSelectElement, 'ERROR')
    })

    expect(resetAi().disabled).toBe(false)
    expect(resetAi().className).toContain('border-primary')
  })
})
