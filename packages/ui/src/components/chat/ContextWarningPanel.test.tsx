import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/i18n пишет в localStorage — в Node/vitest его нет.
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

const mocks = vi.hoisted(() => ({ policy: 'warn' as 'off' | 'warn' | 'enforce' }))

vi.mock('@/lib/api/contextWindowSettings', () => ({
  useContextWindowPolicy: () => mocks.policy,
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ContextWarningPanel } from './ContextWarningPanel'
import { useChatStore, type MessageData } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderPanel(locale: 'en' | 'ru' = 'en'): Promise<HTMLElement> {
  useI18nStore.setState({
    locale,
    dictionary: locale === 'ru' ? ruDict : enDict,
    loadingLocale: null,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ContextWarningPanel sessionId="s1" />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function message(inputTokens: number): MessageData {
  return {
    index: 0,
    id: 'm1',
    role: 'assistant',
    content: 'x',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-01T17:00:00.000Z',
    usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
  } as MessageData
}

function setInputTokens(inputTokens: number): void {
  useChatStore.setState({ messagesBySession: { s1: [message(inputTokens)] } } as never)
}

beforeEach(() => {
  mocks.policy = 'warn'
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'mm' } }],
  } as never)
  useProvidersStore.setState({
    models: [{ id: 'mm', name: 'mm', context_window: 200_000 }],
    selectedModelName: null,
  } as never)
  setInputTokens(0)
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
})

describe('ContextWarningPanel — блок предупреждения о контексте', () => {
  it('не рендерится при 89%', async () => {
    setInputTokens(178_000) // 89%
    const container = await renderPanel()
    expect(container.querySelector('[data-testid="context-warning-panel"]')).toBeNull()
  })

  it('рендерится при 90%: заголовок с числами, подсказка и «Что делать»', async () => {
    setInputTokens(180_000) // 90%
    const container = await renderPanel()
    const panel = container.querySelector('[data-testid="context-warning-panel"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.dataset.variant).toBe('warning')
    expect(panel.textContent).toContain('Context is 90% full')
    expect(panel.textContent).toContain('180,000')
    expect(panel.textContent).toContain('200,000')
    expect(panel.textContent).toContain('The model may lose quality')

    const toggle = panel.querySelector('[data-testid="context-warning-panel-details"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(panel.textContent).not.toContain('Summarize the context')

    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(panel.textContent).toContain('Summarize the context')
    expect(panel.textContent).toContain('auto-summarization')
    expect(panel.textContent).toContain('Disable some messages')
  })

  it('скрыт при политике off', async () => {
    mocks.policy = 'off'
    setInputTokens(195_000) // 98%
    const container = await renderPanel()
    expect(container.querySelector('[data-testid="context-warning-panel"]')).toBeNull()
  })

  it('показывается при политике enforce', async () => {
    mocks.policy = 'enforce'
    setInputTokens(195_000)
    const container = await renderPanel()
    expect(container.querySelector('[data-testid="context-warning-panel"]')).not.toBeNull()
  })

  it('пометка об оценке окна, если у модели нет context_window', async () => {
    useProvidersStore.setState({
      models: [{ id: 'mm', name: 'mm' }],
      selectedModelName: null,
    } as never)
    setInputTokens(185_000) // 92.5% от оценки 200 000
    const container = await renderPanel()
    const panel = container.querySelector('[data-testid="context-warning-panel"]') as HTMLElement
    expect(panel.textContent).toContain('an estimate of 200,000 tokens is used')
  })

  it('русский заголовок с числами', async () => {
    setInputTokens(185_000)
    const container = await renderPanel('ru')
    expect(container.textContent).toContain('Контекст заполнен на 93%')
    expect(container.textContent).toContain('Что делать')
  })
})
