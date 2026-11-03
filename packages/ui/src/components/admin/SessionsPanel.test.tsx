import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const apiMock = vi.hoisted(() => ({
  getSessionsPage: vi.fn(),
  resumeQueue: vi.fn(),
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
    input_tokens: 0,
    output_tokens: 0,
    project_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    pending_messages: [],
    ...overrides,
  }
}

/** Страница списка сессий (контракт `GET /api/v2/sessions`). */
function makePage(
  sessions: ReturnType<typeof makeSession>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    sessions,
    total: sessions.length,
    offset: 0,
    limit: 50,
    next_offset: null,
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
  apiMock.getSessionsPage.mockResolvedValue(
    makePage([
      makeSession({ id: 'regular-1234567890', input_tokens: 10, output_tokens: 20 }),
      makeSession({ id: 'blocked-1234567890', status: { blocked: 'resource-lock' }, pending_messages: [{}] }),
    ]),
  )
  apiMock.resumeQueue.mockResolvedValue(undefined)
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

describe('SessionsPanel — миграция на Settings UI Kit (ADR-072)', () => {
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

    expect(container.textContent).toContain('ID:')
    expect(container.textContent).toContain('regular-1234567890')
    expect(buttonByText(container, 'Hide')).toBeTruthy()
  })

  it('unlock заблокированной сессии идёт через synthApi.resumeQueue и перезагружает список', async () => {
    const container = await renderPanel()

    const unlock = buttonByText(container, 'Unlock')
    expect(unlock).toBeTruthy()
    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(apiMock.resumeQueue).toHaveBeenCalledTimes(1)
    expect(apiMock.resumeQueue).toHaveBeenCalledWith('blocked-1234567890')
    expect(apiMock.getSessionsPage).toHaveBeenCalledTimes(2)
  })
})

/**
 * Пагинация списка сессий (ADR-089): список **всегда** пагинирован, а
 * истории сообщений в нём нет — счётчика сообщений в панели быть не должно.
 */
describe('SessionsPanel — пагинация списка сессий', () => {
  it('счётчика сообщений нет (список не содержит истории)', async () => {
    apiMock.getSessionsPage.mockResolvedValue(
      makePage([makeSession({ id: 'regular-1234567890', messages: [{ id: 'm1' }, { id: 'm2' }] })]),
    )

    const container = await renderPanel()

    expect(container.textContent).not.toContain('messages')
    expect(container.textContent).not.toContain('message')
  })

  it('в meta — общее число сессий (total), а не размер страницы', async () => {
    apiMock.getSessionsPage.mockResolvedValue(
      makePage([makeSession({ id: 'regular-1234567890' })], { total: 137 }),
    )

    const container = await renderPanel()

    const meta = container.querySelector('[data-testid="settings-header-meta"]')
    expect(meta?.textContent).toContain('137 sessions')
  })

  it('при next_offset кнопка «Показать ещё» догружает следующую страницу', async () => {
    apiMock.getSessionsPage.mockResolvedValueOnce(
      makePage([makeSession({ id: 'regular-1234567890' })], { total: 2, next_offset: 1 }),
    )
    apiMock.getSessionsPage.mockResolvedValueOnce(
      makePage([makeSession({ id: 'second-1234567890' })], { total: 2, offset: 1, next_offset: null }),
    )

    const container = await renderPanel()

    const more = buttonByText(container, 'Show more')
    expect(more).toBeTruthy()

    await act(async () => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(apiMock.getSessionsPage).toHaveBeenLastCalledWith({ limit: 50, offset: 1 })
    expect(apiMock.getSessionsPage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('second-12345')
    // Последняя страница — кнопки больше нет.
    expect(buttonByText(container, 'Show more')).toBeFalsy()
  })

  it('без next_offset кнопки «Показать ещё» нет', async () => {
    const container = await renderPanel()

    expect(buttonByText(container, 'Show more')).toBeFalsy()
  })
})
