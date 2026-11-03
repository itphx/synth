/**
 * Пагинация списка проектов в дереве (ADR-089, B1): список проектов приходит
 * страницей (`GET /projects` → `{projects, total, next_offset}`), внизу дерева —
 * кнопка «Показать ещё проекты», которая догружает следующую страницу.
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
      getProjectsPage: vi.fn(),
    },
  }
})
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { synthApi, type ProjectData } from '@/lib/api/synthApi'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { ProjectsTab } from './ProjectsTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function project(id: string): ProjectData {
  return {
    id,
    name: id,
    owner_id: 'u1',
    members: {},
    description: '',
    current_task: '',
    invariants: '',
    icon: null,
    color: null,
    workspace: null,
    repos: null,
    status_messages: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Страница списка проектов — ответ `GET /projects`. */
function page(projects: ProjectData[], nextOffset: number | null = null, total = projects.length) {
  return { projects, total, offset: 0, limit: 100, next_offset: nextOffset }
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
  return container.querySelector<HTMLButtonElement>('[data-testid="load-more-projects"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    projects: [],
    loading: false,
    error: null,
    total: 0,
    nextOffset: null,
    loadingMore: false,
  })
  useSessionsStore.setState({
    sessions: [],
    total: 0,
    nextOffset: null,
    loadingMore: false,
    listProjectId: null,
  })
  useUIStore.setState({ collapsedProjects: new Set<string>() })
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

describe('ProjectsTab — пагинация списка проектов', () => {
  it('кнопки нет, когда проекты умещаются в одну страницу', async () => {
    vi.mocked(synthApi.getProjectsPage).mockResolvedValue(page([project('p1')]))

    const container = await renderTree()

    expect(loadMoreButton(container)).toBeNull()
  })

  it('при next_offset кнопка «Показать ещё проекты» догружает следующую страницу', async () => {
    vi.mocked(synthApi.getProjectsPage).mockResolvedValueOnce(page([project('p1')], 1, 2))
    vi.mocked(synthApi.getProjectsPage).mockResolvedValueOnce(page([project('p2')], null, 2))

    const container = await renderTree()

    const button = loadMoreButton(container)
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Show more projects')

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(synthApi.getProjectsPage).toHaveBeenLastCalledWith({ limit: 100, offset: 1 })
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(['p1', 'p2'])
    // Последняя страница — кнопки больше нет.
    expect(loadMoreButton(container)).toBeNull()
  })

  it('догрузка не сбрасывает раскрытие проектов', async () => {
    vi.mocked(synthApi.getProjectsPage).mockResolvedValueOnce(page([project('p1')], 1, 2))
    vi.mocked(synthApi.getProjectsPage).mockResolvedValueOnce(page([project('p2')], null, 2))

    const container = await renderTree()
    // Проект раскрыт (сворачивание хранится в UI-сторе, не в списке).
    useUIStore.getState().toggleProjectCollapse('p1')
    expect(useUIStore.getState().collapsedProjects.has('p1')).toBe(true)

    const button = loadMoreButton(container)!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(useUIStore.getState().collapsedProjects.has('p1')).toBe(true)
  })
})
