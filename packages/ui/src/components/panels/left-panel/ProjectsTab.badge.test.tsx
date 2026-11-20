/**
 * Тон названия и точка статуса строки сессии в дереве — из модели
 * `sessionBadgeState` (`lib/sessionBadgeState.ts`, ADR-118 §1).
 *
 * Проверяются два уровня:
 *  1. Модель применяется к реальным сторам панели: `status.last_turn` из DTO
 *     (`error` / `completed` / `limit`) плюс живые счётчики клиента.
 *  2. Локальная метка «просмотрено» (`notificationStore.ackedAtBySession`):
 *     после просмотра исхода название больше не красится.
 *
 * Текст названия остаётся текстом (`title`), цвет — токены темы: смысл состояния
 * не должен быть доступен только зрением.
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
      listProcesses: vi.fn(),
      listTimers: vi.fn(),
    },
  }
})
vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: { ...actual.terminalsApi, list: vi.fn().mockResolvedValue({
      terminals: [],
      total: 0,
      offset: 0,
      limit: 50,
      nextOffset: null,
    }) },
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
import { useNotificationStore } from '@/stores/notificationStore'
import { useProcessesStore } from '@/stores/processesStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { useTimersStore } from '@/stores/timersStore'
import { ProjectsTab } from './ProjectsTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Момент исхода последнего хода (детерминированные тесты ack-метки). */
const TURN_AT = '2026-01-01T12:00:00.000Z'
const TURN_MS = Date.parse(TURN_AT)

function session(id: string, overrides: Partial<SessionData> = {}): SessionData {
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
    ...overrides,
  }
}

/** Сессия с durable-исходом последнего хода и простоем. */
function sessionWithTurn(
  id: string,
  outcome: 'completed' | 'error' | 'limit' | 'stopped' | 'cancelled',
  overrides: Partial<SessionData> = {},
): SessionData {
  return session(id, {
    activity: { type: 'idle' },
    status: { blocked: null, last_turn: { outcome, at: TURN_AT } },
    ...overrides,
  })
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

function sessionNode(container: ParentNode, id: string): HTMLElement {
  const node = container.querySelector(`[data-tree-node="session:${id}"]`)
  expect(node, `узел сессии ${id} не найден`).not.toBeNull()
  return node as HTMLElement
}

/** Span с названием сессии (без вложенных svg — это не иконка). */
function labelSpan(node: ParentNode, name: string): HTMLElement | null {
  return (
    [...node.querySelectorAll('span')].find(
      (el) => el.textContent === name && !el.querySelector('svg'),
    ) ?? null
  )
}

/** Точка-индикатор статуса в строке сессии. */
function statusDot(node: ParentNode): HTMLElement | null {
  return node.querySelector<HTMLElement>('span[role="img"]')
}

/** Раскрыть дочерние сессии узла (стрелка слева от иконки). */
async function expandSession(container: HTMLElement, id: string): Promise<void> {
  const node = sessionNode(container, id)
  const arrow = node.querySelector('span')
  expect(arrow, `стрелка раскрытия ${id} не найдена`).not.toBeNull()
  await act(async () => {
    arrow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Применить список сессий к стору и к ответу API (панель читает оба). */
function setSessions(list: SessionData[]): void {
  vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
    sessions: list,
    total: list.length,
    offset: 0,
    limit: 100,
    next_offset: null,
  })
  useSessionsStore.setState({
    sessions: list as never,
    total: list.length,
    nextOffset: null,
    loadingMore: false,
    listProjectId: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(synthApi.getProjectsPage).mockResolvedValue({
    projects: [],
    total: 0,
    offset: 0,
    limit: 100,
    next_offset: null,
  })
  vi.mocked(synthApi.listProcesses).mockResolvedValue([])
  vi.mocked(synthApi.listTimers).mockResolvedValue({
    timers: [],
    total: 0,
    offset: 0,
    limit: 200,
    next_offset: null,
  })

  useProjectsStore.setState({ projects: [], loading: false, error: null })
  useChatStore.setState({ turnBySession: {}, queueBySession: {} })
  usePermissionStore.setState({ requestsBySession: {} })
  // Метки «просмотрено» — локальные и живут дольше одного теста.
  useNotificationStore.setState({ sessionUnread: {}, ackedAtBySession: {} })
  useProcessesStore.setState({ byId: {}, order: [], logs: {}, pendingIds: [], error: null })
  useTerminalsStore.setState({ terminalsById: {}, order: [], queryIds: {}, loading: false, error: null })
  useTimersStore.setState({ byId: {}, order: [], pendingIds: [], loading: false, error: null })
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

describe('ProjectsTab — критическая ошибка последнего хода', () => {
  it('непросмотренная ошибка при простое: красное название и подпись, точки нет', async () => {
    setSessions([sessionWithTurn('s1', 'error')])
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const label = labelSpan(node, 's1')
    expect(label).not.toBeNull()
    expect(label!.classList.contains('text-status-error')).toBe(true)
    // Смысл не только в цвете: подпись на самом названии.
    expect(label!.getAttribute('title')).toBe('s1 — execution failed')
    // Ошибка — не «что-то происходит»: точки статуса нет.
    expect(statusDot(node)).toBeNull()
  })

  it('после просмотра (markSessionAcked) красного цвета нет', async () => {
    setSessions([sessionWithTurn('s1', 'error')])
    const container = await renderTree()

    expect(labelSpan(sessionNode(container, 's1'), 's1')!.classList.contains('text-status-error')).toBe(true)

    // Эмуляция открытия чата сессии: ChatTab ставит метку «просмотрено».
    await act(async () => {
      useNotificationStore.getState().markSessionAcked('s1', TURN_MS + 1_000)
    })

    const label = labelSpan(sessionNode(container, 's1'), 's1')!
    expect(label.classList.contains('text-status-error')).toBe(false)
    expect(label.classList.contains('text-foreground')).toBe(true)
    expect(label.getAttribute('title')).toBe('s1')
  })

  it('метка «просмотрено» раньше исхода ошибку не скрывает', async () => {
    setSessions([sessionWithTurn('s1', 'error')])
    // Просмотр был до исхода (старая вкладка) — новый сбой всё равно красится.
    useNotificationStore.setState({ ackedAtBySession: { s1: TURN_MS - 60_000 } })
    const container = await renderTree()

    expect(labelSpan(sessionNode(container, 's1'), 's1')!.classList.contains('text-status-error')).toBe(true)
  })

  it('ошибка при идущем ходе — синяя точка вместо красного', async () => {
    setSessions([sessionWithTurn('s1', 'error')])
    useChatStore.setState({
      turnBySession: { s1: { turnId: 't1', status: 'streaming' } } as never,
    })
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    expect(labelSpan(node, 's1')!.classList.contains('text-status-error')).toBe(false)
    const dot = statusDot(node)!
    expect(dot.classList.contains('bg-status-info')).toBe(true)
    expect(dot.getAttribute('aria-label')).toBe('Streaming')
  })
})

describe('ProjectsTab — завершённая работа', () => {
  it('completed + простой + верхний уровень без открытых todo: зелёное название', async () => {
    setSessions([sessionWithTurn('s1', 'completed')])
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const label = labelSpan(node, 's1')!
    expect(label.classList.contains('text-status-success')).toBe(true)
    expect(label.getAttribute('title')).toBe('s1 — work completed')
    expect(statusDot(node)).toBeNull()
  })

  it('открытый todo — не зелёный (работа не закрыта)', async () => {
    setSessions([
      sessionWithTurn('s1', 'completed', {
        todos: [{ id: 't1', content: 'доделать', status: 'in_progress', priority: 'medium' }],
      }),
    ])
    const container = await renderTree()

    const label = labelSpan(sessionNode(container, 's1'), 's1')!
    expect(label.classList.contains('text-status-success')).toBe(false)
  })

  it('дочерняя сессия того же вида не зеленеет (саб-агент — не индикатор)', async () => {
    const parent = session('p1', { activity: { type: 'idle' } })
    const child = sessionWithTurn('c1', 'completed', {
      parent_id: 'p1',
      session_origin: 'subagent',
    })
    setSessions([parent, child])
    const container = await renderTree()
    await expandSession(container, 'p1')

    // Узел ребёнка действительно отрисован (дерево раскрыто)…
    const childNode = sessionNode(container, 'c1')
    const childLabel = labelSpan(childNode, 'c1')!
    // …но зелёного у него нет.
    expect(childLabel.classList.contains('text-status-success')).toBe(false)
    expect(childLabel.classList.contains('text-foreground')).toBe(true)
  })

  it('просмотренное завершение цвета не даёт', async () => {
    setSessions([sessionWithTurn('s1', 'completed')])
    useNotificationStore.setState({ ackedAtBySession: { s1: TURN_MS + 5_000 } })
    const container = await renderTree()

    const label = labelSpan(sessionNode(container, 's1'), 's1')!
    expect(label.classList.contains('text-status-success')).toBe(false)
  })
})

describe('ProjectsTab — штатные исходы нейтральны', () => {
  for (const outcome of ['limit', 'stopped', 'cancelled'] as const) {
    it(`${outcome}: без цвета и без точки`, async () => {
      setSessions([sessionWithTurn('s1', outcome)])
      const container = await renderTree()

      const node = sessionNode(container, 's1')
      const label = labelSpan(node, 's1')!
      expect(label.classList.contains('text-foreground')).toBe(true)
      expect(label.classList.contains('text-status-error')).toBe(false)
      expect(label.classList.contains('text-status-success')).toBe(false)
      expect(statusDot(node)).toBeNull()
    })
  }

  it('сессия без last_turn (legacy) — нейтраль', async () => {
    setSessions([session('s1')])
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    expect(labelSpan(node, 's1')!.classList.contains('text-foreground')).toBe(true)
    expect(statusDot(node)).toBeNull()
  })

  it('сессия без status (частичный payload события) не роняет дерево', async () => {
    // `session.created` из пайплайна несёт только `id`/`owner_id`/`user_id`/
    // `project_id`/`name`, а `transportStore` кладёт payload в список как есть:
    // `status` может отсутствовать, и модель не должна падать.
    const partial = {
      id: 's9',
      name: 'new',
      project_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as SessionData
    setSessions([partial])
    const container = await renderTree()

    const node = sessionNode(container, 's9')
    expect(labelSpan(node, 'new')!.classList.contains('text-foreground')).toBe(true)
    expect(statusDot(node)).toBeNull()
  })
})

describe('ProjectsTab — «требуется действие» остаётся важнее', () => {
  it('подтверждение прав: caution + точка approval даже при непросмотренной ошибке', async () => {
    setSessions([sessionWithTurn('s1', 'error', { pending_approvals: 1 })])
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const dot = statusDot(node)!
    expect(dot.classList.contains('bg-status-caution')).toBe(true)
    expect(dot.getAttribute('aria-label')).toBe('Approval needed')
    expect(labelSpan(node, 's1')!.classList.contains('text-status-caution')).toBe(true)
    expect(labelSpan(node, 's1')!.classList.contains('text-status-error')).toBe(false)
  })

  it('остановка очереди (queue_stopped): caution + точка stalled', async () => {
    setSessions([
      sessionWithTurn('s1', 'error', { status: { blocked: null, queue_stopped: true } }),
    ])
    const container = await renderTree()

    const node = sessionNode(container, 's1')
    const dot = statusDot(node)!
    expect(dot.classList.contains('bg-status-warning')).toBe(true)
    expect(dot.getAttribute('aria-label')).toBe('Attention needed')
    expect(labelSpan(node, 's1')!.classList.contains('text-status-caution')).toBe(true)
  })

  it('живой stall очереди (стор) — та же метка', async () => {
    setSessions([session('s1')])
    useChatStore.setState({
      queueBySession: { s1: { pendingCount: 1, steerCount: 0, isStalled: true } } as never,
    })
    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-status-warning')).toBe(true)
  })

  it('непустая очередь без stall — нейтральная точка pending', async () => {
    setSessions([session('s1')])
    useChatStore.setState({
      queueBySession: { s1: { pendingCount: 2, steerCount: 0, isStalled: false } } as never,
    })
    const container = await renderTree()

    const dot = statusDot(sessionNode(container, 's1'))!
    expect(dot.classList.contains('bg-muted-foreground')).toBe(true)
    expect(dot.getAttribute('aria-label')).toBe('Answer ready')
  })
})
