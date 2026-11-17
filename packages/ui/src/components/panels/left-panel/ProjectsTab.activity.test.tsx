/**
 * Индикаторы активной фоновой работы в дереве сессий.
 *
 * Строка сессии показывает значки того, что идёт **сейчас**: выполняющиеся
 * фоновые процессы и саб-агенты и живые терминалы. Источники — реестр
 * фоновых прогонов (`stores/processesStore.ts`) и реестр терминалов
 * (`stores/terminalsStore.ts`); подсчёт — чистая функция
 * `lib/sessionActivity.ts`.
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

const mocks = vi.hoisted(() => ({
  getSessionsPage: vi.fn(),
  getProjectsPage: vi.fn(),
  listProcesses: vi.fn(),
  listTerminals: vi.fn(),
  listTimers: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      getSessionsPage: mocks.getSessionsPage,
      getProjectsPage: mocks.getProjectsPage,
      listProcesses: mocks.listProcesses,
      listTimers: mocks.listTimers,
    },
  }
})
vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: { ...actual.terminalsApi, list: mocks.listTerminals },
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
import { useProcessesStore } from '@/stores/processesStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import { useTimersStore } from '@/stores/timersStore'
import type { BackgroundRunRecord, Timer } from '@/lib/api/synthApi'
import type { TerminalDto } from '@/lib/api/terminals'
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

/** Фоновый прогон. */
function makeRun(id: string, overrides: Partial<BackgroundRunRecord> = {}): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Терминал (live по умолчанию). */
function makeTerminal(id: string, overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id,
    projectId: 'p1',
    sessionId: 's1',
    ownerId: null,
    cwd: '/workspace/demo',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: `Terminal ${id}`,
    can_write: true,
    attached_clients: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    exitCode: null,
    signal: null,
    target: null,
    ...overrides,
  }
}

/** Таймер/будильник (активный по умолчанию). */
function makeTimer(id: string, overrides: Partial<Timer> = {}): Timer {
  return {
    id,
    kind: 'timer',
    comment: 'напомнить',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'u1',
    repeat: { mode: 'once' },
    status: 'active',
    firesAt: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
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

/** Значок активности по виду работы. */
function activityIcon(node: ParentNode, kind: string): HTMLElement | null {
  return node.querySelector(`[data-testid="session-activity-${kind}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(synthApi.getSessionsPage).mockResolvedValue({
    sessions: [session('s1'), session('s2')],
    total: 2,
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
  // Активные прогоны инстанса — ответ `loadActive` (`status=running`).
  mocks.listProcesses.mockResolvedValue([
    makeRun('bgr_1', { kind: 'process', status: 'running', sessionId: 's1' }),
    makeRun('bgr_2', { kind: 'subagent', status: 'running', sessionId: 's1', childSessionId: 'child-1' }),
    makeRun('bgr_4', { kind: 'process', status: 'running', sessionId: 's3' }),
  ])
  mocks.listTerminals.mockResolvedValue({
    terminals: [],
    total: 0,
    offset: 0,
    limit: 50,
    nextOffset: null,
  })
  // Активные таймеры инстанса — ответ `loadActive` (`status=active`).
  mocks.listTimers.mockResolvedValue({
    timers: [
      makeTimer('tmr_1', { kind: 'timer', sessionId: 's1' }),
      makeTimer('tmr_2', { kind: 'alarm', sessionId: 's1' }),
    ],
    total: 2,
    offset: 0,
    limit: 200,
    next_offset: null,
  })

  useSessionsStore.setState({
    sessions: [session('s1'), session('s2')] as never,
    total: 2,
    nextOffset: null,
    loadingMore: false,
    listProjectId: null,
  })
  useProjectsStore.setState({ projects: [], loading: false, error: null })
  useChatStore.setState({ turnBySession: {}, queueBySession: {} })
  usePermissionStore.setState({ requestsBySession: {} })

  useProcessesStore.setState({
    byId: {
      bgr_1: makeRun('bgr_1', { kind: 'process', status: 'running', sessionId: 's1' }),
      bgr_2: makeRun('bgr_2', { kind: 'subagent', status: 'running', sessionId: 's1', childSessionId: 'child-1' }),
      // Завершённый прогон — не активность.
      bgr_3: makeRun('bgr_3', { kind: 'process', status: 'completed', sessionId: 's1' }),
      bgr_4: makeRun('bgr_4', { kind: 'process', status: 'running', sessionId: 's3' }),
    },
    order: ['bgr_1', 'bgr_2', 'bgr_3', 'bgr_4'],
    logs: {},
    pendingIds: [],
    error: null,
  })

  useTerminalsStore.setState({
    terminalsById: {
      t1: makeTerminal('t1', { sessionId: 's1' }),
      // Завершённый терминал — не активность.
      t2: makeTerminal('t2', { sessionId: 's1', status: 'exited' }),
      // Терминал без сессии — не активность.
      t3: makeTerminal('t3', { sessionId: null }),
    },
    order: ['t1', 't2', 't3'],
    queryIds: {},
    loading: false,
    error: null,
  })

  useTimersStore.setState({
    byId: {
      tmr_1: makeTimer('tmr_1', { kind: 'timer', sessionId: 's1' }),
      tmr_2: makeTimer('tmr_2', { kind: 'alarm', sessionId: 's1' }),
      // Приостановленный таймер — не активность.
      tmr_3: makeTimer('tmr_3', { kind: 'timer', sessionId: 's1', status: 'paused' }),
    },
    order: ['tmr_1', 'tmr_2', 'tmr_3'],
    pendingIds: [],
    loading: false,
    error: null,
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

describe('ProjectsTab — индикаторы активной фоновой работы', () => {
  it('у сессии с активностью — значки с подписями и числом', async () => {
    const container = await renderTree()
    const node = sessionNode(container, 's1')

    const process = activityIcon(node, 'processes')
    const subagent = activityIcon(node, 'subagents')
    const terminal = activityIcon(node, 'terminals')
    const timer = activityIcon(node, 'timers')
    const alarm = activityIcon(node, 'alarms')

    expect(process).not.toBeNull()
    expect(subagent).not.toBeNull()
    expect(terminal).not.toBeNull()
    expect(timer).not.toBeNull()
    expect(alarm).not.toBeNull()

    expect(process!.getAttribute('aria-label')).toBe('1 background process')
    expect(subagent!.getAttribute('aria-label')).toBe('1 background sub-agent')
    expect(terminal!.getAttribute('aria-label')).toBe('1 live terminal')
    expect(timer!.getAttribute('aria-label')).toBe('1 active timer')
    expect(alarm!.getAttribute('aria-label')).toBe('1 active alarm')

    // Цвет — не единственный сигнал: у значка есть текстовая подпись.
    expect(process!.getAttribute('title')).toBe('1 background process')
    expect(process!.getAttribute('role')).toBe('img')
    expect(timer!.getAttribute('title')).toBe('1 active timer')
  })

  it('у сессии без активности значков нет', async () => {
    const container = await renderTree()
    const node = sessionNode(container, 's2')

    expect(node.querySelector('[data-testid="session-activity"]')).toBeNull()
    expect(activityIcon(node, 'processes')).toBeNull()
    expect(activityIcon(node, 'subagents')).toBeNull()
    expect(activityIcon(node, 'terminals')).toBeNull()
    expect(activityIcon(node, 'timers')).toBeNull()
    expect(activityIcon(node, 'alarms')).toBeNull()
  })

  it('завершённые прогоны и терминалы активностью не считаются', async () => {
    const container = await renderTree()
    const node = sessionNode(container, 's1')

    // Один процесс (bgr_1), один саб-агент (bgr_2), один терминал (t1).
    expect(activityIcon(node, 'processes')!.getAttribute('aria-label')).toBe('1 background process')
    expect(activityIcon(node, 'subagents')!.getAttribute('aria-label')).toBe('1 background sub-agent')
    expect(activityIcon(node, 'terminals')!.getAttribute('aria-label')).toBe('1 live terminal')
  })

  it('приостановленный таймер активностью не считается', async () => {
    const container = await renderTree()
    const node = sessionNode(container, 's1')

    // Активных таймеров один (tmr_1), будильников один (tmr_2);
    // приостановленный tmr_3 в значок не попадает.
    expect(activityIcon(node, 'timers')!.getAttribute('aria-label')).toBe('1 active timer')
    expect(activityIcon(node, 'alarms')!.getAttribute('aria-label')).toBe('1 active alarm')
  })

  it('значки не ломают точку статуса и счётчик непрочитанного', async () => {
    const container = await renderTree()
    const node = sessionNode(container, 's1')

    // Точка статуса (статус сессии) на месте — индикаторы её не заменяют.
    expect(node.querySelector('span[role="img"][aria-label="Streaming"]')).toBeNull()
    expect(activityIcon(node, 'processes')).not.toBeNull()
  })

  it('реестры активности подгружаются при монтировании панели', async () => {
    await renderTree()

    expect(mocks.listProcesses).toHaveBeenCalledWith({ status: 'running', limit: 200 })
    expect(mocks.listTerminals).toHaveBeenCalled()
    expect(mocks.listTimers).toHaveBeenCalledWith({ status: 'active', limit: 200 })
  })
})
