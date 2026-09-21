import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getSessions: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SessionsPanel } from './SessionsPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function makeSession(overrides: Record<string, unknown>) {
  return {
    id: 'abcdef1234567890',
    status: {},
    messages: [],
    input_tokens: 0,
    output_tokens: 0,
    engine: 'test-engine',
    project_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    pending_messages: [],
    ...overrides,
  }
}

async function renderPanel(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SessionsPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
}

beforeEach(() => {
  apiMock.getSessions.mockResolvedValue([
    makeSession({ id: 'regular-1234567890', messages: [{}, {}], input_tokens: 10, output_tokens: 20 }),
    makeSession({ id: 'blocked-1234567890', status: { blocked: 'resource-lock' }, pending_messages: [{}] }),
  ])
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('SessionsPanel — миграция на Settings UI Kit (AD-072)', () => {
  it('каркас — SettingsPanel: один скролл, без pr-2, заголовок и actions-refresh', async () => {
    const container = await renderPanel()

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]!.classList.contains('overflow-x-hidden')).toBe(true)
    expect(container.innerHTML).not.toContain('pr-2')
    expect(container.textContent).toContain('Sessions')
    expect(container.textContent).toContain('2 sessions')
    expect(buttonByText(container, 'Refresh')).toBeTruthy()

    // Счётчик — в `meta` (виден при сворачивании описания), не в `description`.
    const meta = container.querySelector('[data-testid="settings-header-meta"]')
    expect(meta?.textContent).toContain('2 sessions')
    expect(container.querySelector('[data-testid="settings-header-description"]')).toBeNull()
  })

  it('раскрывает details и показывает поля сессии', async () => {
    const container = await renderPanel()

    const details = buttonByText(container, 'Details')
    expect(details).toBeTruthy()
    await act(async () => {
      details!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Engine:')
    expect(container.textContent).toContain('test-engine')
    expect(buttonByText(container, 'Hide')).toBeTruthy()
  })

  it('unlock заблокированной сессии шлёт POST и перезагружает список', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const container = await renderPanel()

    const unlock = buttonByText(container, 'Unlock')
    expect(unlock).toBeTruthy()
    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/v2/queue/blocked-1234567890/resume')
    expect(init?.method).toBe('POST')
    expect(apiMock.getSessions).toHaveBeenCalledTimes(2)
  })
})
