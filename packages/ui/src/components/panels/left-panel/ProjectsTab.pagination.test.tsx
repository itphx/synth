/**
 * Пагинация списка сессий в дереве проектов (ADR-089): список сессий всегда
 * приходит страницей (`GET /sessions` → `{sessions, total, next_offset}`), внизу
 * дерева — кнопка «Показать ещё», которая догружает следующую страницу.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {}
  }
})

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getSessionsPage: vi.fn(),
    },
  }
})
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useSessionsStore } from '@/stores/sessionsStore'
import { ProjectsTab } from './ProjectsTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function session(id: string): SessionData {
  return {
    id,
    name: id,
    user_id: 'u1',
    owner_id: 'u1',
    project_id: null,
    pending_messages: [],
    status: { blocked: null },
    settings: {},
    sticky_notes: [],
    summarization_pending: false,
    can_summarize: false,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    processor_running: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function renderTree(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProjectsTab />
      </I18nProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

function loadMoreButton(container: ParentNode): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="load-more-sessions"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionsStore.setState({
    sessions: [],
    total: 0,
    nextOffset: null,
    loadingMore: false,
    listProjectId: null,
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
  document.body.innerHTML = ''
})

describe('ProjectsTab — пагинация списка сессий', () => {
  it('кнопки нет, когда список умещается в одну страницу', async () => {
    vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
      sessions: [session('s1')],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    })

    const container = await renderTree()

    expect(loadMoreButton(container)).toBeNull()
  })

  it('при next_offset кнопка «Показать ещё» догружает следующую страницу', async () => {
    vi.mocked(synthApi.getSessionsPage).mockResolvedValueOnce({
      sessions: [session('s1')],
      total: 2,
      offset: 0,
      limit: 100,
      next_offset: 1,
    })
    vi.mocked(synthApi.getSessionsPage).mockResolvedValueOnce({
      sessions: [session('s2')],
      total: 2,
      offset: 1,
      limit: 100,
      next_offset: null,
    })

    const container = await renderTree()

    const button = loadMoreButton(container)
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Show more sessions')

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(synthApi.getSessionsPage).toHaveBeenLastCalledWith({
      project_id: undefined,
      limit: 100,
      offset: 1,
    })
    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(['s1', 's2'])
    // Последняя страница — кнопки больше нет.
    expect(loadMoreButton(container)).toBeNull()
  })
})
