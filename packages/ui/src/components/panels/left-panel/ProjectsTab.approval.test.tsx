/**
 * Индикатор «ждёт подтверждения прав» в дереве сессий.
 *
 * Запрос подтверждения (`permission.asked`) копится в `permissionStore`; дерево
 * левой панели читает его и помечает строку сессии статусом `approval`
 * (оранжевая точка + оранжевое название из токена темы `status-caution`).
 * Статус важнее идущего хода и состояния очереди — ждём действия пользователя.
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
      getProjectsPage: vi.fn(),
    },
  }
})
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { synthApi, type SessionData } from '@/lib/api/synthApi'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useChatStore } from '@/stores/chatStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { createDispatcher } from '@/stores/transportStore'
import { ProjectsTab } from './ProjectsTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Диспетчер транспорта — живое событие `permission.replied`. */
const dispatch = createDispatcher()

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

/** Сессия с серверным счётчиком висящих подтверждений (ADR-029). */
function sessionWithPending(id: string, count: number): SessionData {
  return { ...session(id), pending_approvals: count }
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

function sessionNode(container: ParentNode, id: string): HTMLElement {
  const node = container.querySelector(`[data-tree-node="session:${id}"]`)
  expect(node).not.toBeNull()
  return node as HTMLElement
}

/** Точка-индикатор статуса в строке сессии. */
function statusDot(node: ParentNode): HTMLElement | null {
  return node.querySelector<HTMLElement>('span[role="img"]')
}

/** Span с названием сессии. */
function labelSpan(node: ParentNode): HTMLElement | null {
  return [...node.querySelectorAll('span')].find(
    (el) => el.textContent === 's1' && !el.querySelector('svg'),
  ) ?? null
}

function addPendingRequest(sessionId: string, approvalId = 'a1'): void {
  usePermissionStore.getState().addRequest(sessionId, {
    approvalId,
    toolName: 'execute_shell',
    params: {},
    reason: 'нужно подтверждение',
    askedAt: new Date().toISOString(),
    // Без таймаута — запрос живёт до ответа, тест не зависит от часов.
    timeoutMs: 0,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
    sessions: [session('s1')],
    total: 1,
    offset: 0,
    limit: 100,
    next_offset: null,
  })
  vi.mocked(synthApi.getProjectsPage).mockResolvedValue({
    projects: [],
    total: 0,
    offset: 0,
    limit: 100,
    next_offset: null,
  })

  useSessionsStore.setState({
    sessions: [session('s1')] as never,
    total: 1,
    nextOffset: null,
    loadingMore: false,
    listProjectId: null,
  })
  useProjectsStore.setState({ projects: [], loading: false, error: null })
  useChatStore.setState({ turnBySession: {}, queueBySession: {} })
  usePermissionStore.setState({ requestsBySession: {} })
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
  usePermissionStore.setState({ requestsBySession: {} })
})

describe('ProjectsTab — статус «ждёт подтверждения прав»', () => {
  it('без pending-одобрения точки статуса нет', async () => {
    const container = await renderTree()
    expect(statusDot(sessionNode(container, 's1'))).toBeNull()
  })

  it('pending-одобрение помечает сессию: оранжевая точка и оранжевое название', async () => {
    addPendingRequest('s1')
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const dot = statusDot(node)
    expect(dot).not.toBeNull()
    expect(dot!.classList.contains('bg-status-caution')).toBe(true)
    // Текстовый дубль цвета — для скринридера.
    expect(dot!.getAttribute('aria-label')).toBe('Approval needed')

    const label = labelSpan(node)
    expect(label).not.toBeNull()
    expect(label!.classList.contains('text-status-caution')).toBe(true)
  })

  it('приоритетнее идущего хода', async () => {
    useChatStore.setState({
      turnBySession: { s1: { turnId: 't1', status: 'streaming' } } as never,
    })
    addPendingRequest('s1')
    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)
    expect(dot.classList.contains('bg-status-info')).toBe(false)
  })

  it('приоритетнее зависшей очереди и сообщений в очереди', async () => {
    useChatStore.setState({
      queueBySession: { s1: { pendingCount: 3, steerCount: 0, isStalled: true } } as never,
    })
    addPendingRequest('s1')
    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)
    expect(dot.classList.contains('bg-status-warning')).toBe(false)
  })

  it('без одобрения идущий ход остаётся синим (поведение не сломано)', async () => {
    useChatStore.setState({
      turnBySession: { s1: { turnId: 't1', status: 'streaming' } } as never,
    })
    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-info')).toBe(true)
  })

  it('после перезагрузки страницы метка приходит из DTO (pending_approvals)', async () => {
    // Живой стор пуст: событие `permission.asked` в этой вкладке не приходило
    // (перезагрузка страницы) — метку должен дать серверный счётчик в DTO.
    usePermissionStore.setState({ requestsBySession: {} })
    vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
      sessions: [sessionWithPending('s1', 1)],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    })
    useSessionsStore.setState({
      sessions: [sessionWithPending('s1', 1)] as never,
      total: 1,
      nextOffset: null,
      loadingMore: false,
      listProjectId: null,
    })

    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const dot = statusDot(node)!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)
    expect(dot.getAttribute('aria-label')).toBe('Approval needed')

    const label = labelSpan(node)
    expect(label).not.toBeNull()
    expect(label!.classList.contains('text-status-caution')).toBe(true)
  })

  it('DTO-счётчик важнее идущего хода', async () => {
    usePermissionStore.setState({ requestsBySession: {} })
    vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
      sessions: [sessionWithPending('s1', 2)],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    })
    useSessionsStore.setState({
      sessions: [sessionWithPending('s1', 2)] as never,
      total: 1,
      nextOffset: null,
      loadingMore: false,
      listProjectId: null,
    })
    useChatStore.setState({
      turnBySession: { s1: { turnId: 't1', status: 'streaming' } } as never,
    })

    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)
    expect(dot.classList.contains('bg-status-info')).toBe(false)
  })

  it('нулевой счётчик в DTO метки не даёт (поведение не сломано)', async () => {
    usePermissionStore.setState({ requestsBySession: {} })
    vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
      sessions: [sessionWithPending('s1', 0)],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    })
    useSessionsStore.setState({
      sessions: [sessionWithPending('s1', 0)] as never,
      total: 1,
      nextOffset: null,
      loadingMore: false,
      listProjectId: null,
    })

    const container = await renderTree()

    expect(statusDot(sessionNode(container, 's1'))).toBeNull()
  })

  it('после ответа метка пропадает: живой стор пуст + DTO-счётчик обнулён', async () => {
    // «Перезагрузка страницы»: событие `permission.asked` в этой вкладке не
    // приходило — метку даёт серверный счётчик в DTO.
    usePermissionStore.setState({ requestsBySession: {} })
    vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
      sessions: [sessionWithPending('s1', 1)],
      total: 1,
      offset: 0,
      limit: 100,
      next_offset: null,
    })
    useSessionsStore.setState({
      sessions: [sessionWithPending('s1', 1)] as never,
      total: 1,
      nextOffset: null,
      loadingMore: false,
      listProjectId: null,
    })

    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)

    // Ответ на подтверждение: карточка снята, DTO-счётчик уменьшен.
    await act(async () => {
      dispatch({
        type: 'permission.replied',
        session_id: 's1',
        data: { approval_id: 'a1' },
      })
    })

    expect(useSessionsStore.getState().sessions[0]!.pending_approvals).toBe(0)
    expect(statusDot(sessionNode(container, 's1'))).toBeNull()
  })
})
