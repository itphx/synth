import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) пишет в localStorage, useAdaptiveIcons — ResizeObserver; в jsdom нет.
const storage = vi.hoisted(() => {
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
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  }
  return ls
})

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getProject: vi.fn(),
  getSessions: vi.fn(),
  listSshKeys: vi.fn(),
  getFileTree: vi.fn(),
  readFile: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { LeftPanel } from './LeftPanel'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Есть ли среди svg узла иконка с заданным цветом (стрелка-раскрытие тоже svg). */
function svgHasColor(node: Element, color: string): boolean {
  return [...node.querySelectorAll('svg')].some(
    (el) => (el as SVGElement).style.color.includes(color),
  )
}

/** Есть ли среди svg узла класс (для проверки подсветки hasUnread). */
function svgClassHas(node: Element, cls: string): boolean {
  return [...node.querySelectorAll('svg')].some((el) => el.classList.contains(cls))
}

const P1 = {
  id: 'p1',
  name: 'Proj1',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: 'code' as string | null,
  color: 'a11' as string | null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

const S1 = {
  id: 's1',
  project_id: 'p1',
  name: 'Sess',
  icon: 'rocket' as string | null,
  color: 'a11' as string | null,
  updated_at: '2026-01-01T00:00:00Z',
}

async function render(tab: 'files' | 'projects'): Promise<HTMLElement> {
  useUIStore.setState({ leftPanelTab: tab })
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <LeftPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

beforeEach(() => {
  // Полный контроль над отложенными таймерами: `useAutoScroll` заводит setTimeout(80ms),
  // который не должен выстрелить после teardown jsdom (глобальный `CSS` там отсутствует).
  vi.useFakeTimers()
  storage.clear()
  mocks.getProjects.mockResolvedValue([P1])
  mocks.getProject.mockResolvedValue(P1)
  mocks.getSessions.mockResolvedValue([S1])
  mocks.listSshKeys.mockResolvedValue([])
  mocks.getFileTree.mockResolvedValue({ entries: [] })

  useUIStore.setState({
    leftPanelTab: 'projects',
    centerTabs: [{ id: 'chat-s1', type: 'chat', title: 'Sess', data: { sessionId: 's1' } }],
    activeCenterTabId: 'chat-s1',
    onlyActiveProject: false,
    collapsedProjects: new Set(),
  })
  useSessionsStore.setState({ sessions: [S1] as never, loading: false, error: null })
  useProjectsStore.setState({ projects: [P1] as never, loading: false, error: null })
})

afterEach(async () => {
  // Гасим запланированный авто-скролл до размонтирования/тирдауна, затем
  // размонтируем корни и возвращаем реальные таймеры следующему тесту.
  vi.clearAllTimers()
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('LeftPanel — иконка/цвет проектов и сессий (ADR-075)', () => {
  it('проект с ключом иконки в Files-дереве рендерит иконку (регрессия: сырой ключ → null)', async () => {
    const container = await render('files')
    const node = container.querySelector('[data-tree-node="file-project:p1"]')
    expect(node).not.toBeNull()
    expect(node!.querySelector('svg')).not.toBeNull()
    expect(svgHasColor(node!, 'var(--palette-11)')).toBe(true)
  })

  it('проект с неизвестным значением иконки не роняет узел — фоллбек folder-3', async () => {
    const bad = { ...P1, icon: '🚀' }
    useProjectsStore.setState({ projects: [bad] as never, loading: false, error: null })
    const container = await render('files')
    const node = container.querySelector('[data-tree-node="file-project:p1"]')
    expect(node!.querySelector('svg')).not.toBeNull()
  })

  it('иконка/цвет сессии в дереве проектов', async () => {
    const container = await render('projects')
    const node = container.querySelector('[data-tree-node="session:s1"]')
    expect(node).not.toBeNull()
    expect(node!.querySelector('svg')).not.toBeNull()
    expect(svgHasColor(node!, 'var(--palette-11)')).toBe(true)
  })

  it('закрытая сессия (нет таба) — иконка серая, без кастомного цвета (регрессия)', async () => {
    // Сессия не открыта: ни активного, ни фонового таба.
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    const container = await render('projects')
    const node = container.querySelector('[data-tree-node="session:s1"]')
    expect(node).not.toBeNull()
    // inline-цвета нет → класс TreeNode даёт muted-foreground (не перебит).
    expect(svgHasColor(node!, 'var(--palette-11)')).toBe(false)
  })

  it('сессия с открытым фоновым табом сохраняет кастомный цвет иконки', async () => {
    useUIStore.setState({
      centerTabs: [
        { id: 'chat-s1', type: 'chat', title: 'Sess', data: { sessionId: 's1' } },
        { id: 'chat-s2', type: 'chat', title: 'Other', data: { sessionId: 's2' } },
      ],
      activeCenterTabId: 'chat-s2',
    })
    const container = await render('projects')
    const node = container.querySelector('[data-tree-node="session:s1"]')
    expect(svgHasColor(node!, 'var(--palette-11)')).toBe(true)
  })

  it('закрытая сессия с непрочитанным сохраняет оранжевую подсветку иконки', async () => {
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    useNotificationStore.setState({ sessionUnread: { s1: 1 } })
    const container = await render('projects')
    const node = container.querySelector('[data-tree-node="session:s1"]')
    expect(node!.querySelector('svg')).not.toBeNull()
    // hasUnread работает, т.к. inline-стиль цвета не выставлен.
    expect(svgClassHas(node!, 'text-orange-400')).toBe(true)
    useNotificationStore.setState({ sessionUnread: {} })
  })

  it('сессия без иконки → фоллбек chat-new', async () => {
    useSessionsStore.setState({ sessions: [{ ...S1, icon: null, color: null }] as never, loading: false, error: null })
    const container = await render('projects')
    const node = container.querySelector('[data-tree-node="session:s1"]')
    expect(node!.querySelector('svg')).not.toBeNull()
  })
})
