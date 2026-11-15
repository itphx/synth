/**
 * `TerminalSessionView` — переключатель терминалов сессии (PROP-132).
 *
 * Проверяем контракт вкладки-сессии:
 * - переключение активного терминала пишет `terminalId` в данные вкладки
 *   (`updateTabData`), а не в состояние компонента (переживает смену вкладок);
 * - «+» создаёт терминал сессии (`project_id` + `session_id` в теле запроса);
 * - пустое состояние предлагает создать терминал.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
})

const mocks = vi.hoisted(() => ({
  fetchJSON: vi.fn(),
  notify: vi.fn(),
}))

// Реальный `terminalsApi` — перехватываем только транспорт: так проверяется
// и путь запроса, и тело (snake_case `project_id`/`session_id`).
vi.mock('@/lib/api/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/base')>()
  return { ...actual, fetchJSON: mocks.fetchJSON }
})

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

// xterm не нужен: переключатель — это список вкладок + активный терминал.
vi.mock('./TerminalView', () => ({
  TerminalView: ({ tab }: { tab: { data: { terminalId?: string } } }) => (
    <div data-testid="terminal-view">{tab.data.terminalId ?? ''}</div>
  ),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'
import { TerminalSessionView } from './TerminalSessionView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION = 's1'
const PROJECT = 'p1'
const TAB_ID = 'terminal-session-s1'

/** Снимок терминала. */
function makeTerminal(id: string, overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id,
    projectId: PROJECT,
    sessionId: SESSION,
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

const T1 = makeTerminal('t1', { createdAt: 1000, title: 'Первый' })
const T2 = makeTerminal('t2', { createdAt: 2000, title: 'Второй' })
const CREATED = makeTerminal('t-new', { createdAt: 3000, title: 'Новый' })

/** Терминалы, которые «отдаёт» сервер (список). */
let serverTerminals: TerminalDto[] = [T1, T2]
/** Тела POST-запросов создания терминала. */
let createBodies: Array<Record<string, unknown>> = []

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function click(container: HTMLElement, testId: string): Promise<void> {
  const el = byTestId(container, testId)
  expect(el, `элемент ${testId} не найден`).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

/** Вкладка-сессия из стора — источник истины для `terminalId`. */
function Harness({ tabId }: { tabId: string }): React.ReactElement | null {
  const tab = useUIStore((s) => s.centerTabs.find((t) => t.id === tabId))
  if (!tab) return null
  return <TerminalSessionView tab={tab} />
}

async function render(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const tab: CenterTab = {
    id: TAB_ID,
    type: 'terminal',
    title: 'Сессия 1',
    data: { sessionId: SESSION, projectId: PROJECT },
  }
  useUIStore.setState({ centerTabs: [tab], activeCenterTabId: TAB_ID })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness tabId={TAB_ID} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  serverTerminals = [T1, T2]
  createBodies = []
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })
  mocks.fetchJSON.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? 'GET').toUpperCase()
    if (method === 'POST' && url.endsWith('/terminals')) {
      createBodies.push(JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>)
      return { terminal: CREATED }
    }
    if (method === 'GET') {
      return {
        terminals: serverTerminals,
        total: serverTerminals.length,
        offset: 0,
        limit: 50,
        next_offset: null,
      }
    }
    return {}
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

describe('TerminalSessionView — переключатель терминалов', () => {
  it('показывает терминалы сессии и по умолчанию берёт первый', async () => {
    const container = await render()

    expect(byTestId(container, 'terminal-session-tabs')).not.toBeNull()
    expect(byTestId(container, 'terminal-session-tab-t1')).not.toBeNull()
    expect(byTestId(container, 'terminal-session-tab-t2')).not.toBeNull()
    // Порядок — по созданию: t1 старше t2.
    const tabs = Array.from(
      container.querySelectorAll('[data-testid^="terminal-session-tab-"]'),
    ) as HTMLElement[]
    expect(tabs.map((el) => el.getAttribute('data-testid'))).toEqual([
      'terminal-session-tab-t1',
      'terminal-session-tab-t2',
    ])
    expect(byTestId(container, 'terminal-session-tab-t1')?.getAttribute('data-active')).toBe('true')
    expect(byTestId(container, 'terminal-view')?.textContent).toBe('t1')
  })

  it('клик по второму терминалу меняет активный и пишет terminalId в данные вкладки', async () => {
    const container = await render()

    await click(container, 'terminal-session-tab-t2')

    // Активный терминал живёт в данных вкладки (ADR: переживает смену вкладок).
    expect(useUIStore.getState().centerTabs[0]?.data.terminalId).toBe('t2')
    expect(byTestId(container, 'terminal-session-tab-t2')?.getAttribute('data-active')).toBe('true')
    expect(byTestId(container, 'terminal-session-tab-t1')?.getAttribute('data-active')).toBeNull()
    expect(byTestId(container, 'terminal-view')?.textContent).toBe('t2')
  })

  it('«+» создаёт терминал сессии (project_id + session_id) и делает его активным', async () => {
    const container = await render()

    await click(container, 'terminal-session-create')

    expect(createBodies).toHaveLength(1)
    expect(createBodies[0]).toMatchObject({ project_id: PROJECT, session_id: SESSION })
    // Новый терминал становится активным.
    expect(useUIStore.getState().centerTabs[0]?.data.terminalId).toBe('t-new')
    expect(byTestId(container, 'terminal-view')?.textContent).toBe('t-new')
  })

  it('пустое состояние: подсказка и кнопка создания', async () => {
    serverTerminals = []
    const container = await render()

    expect(container.textContent).toContain('No terminals in this session yet')
    expect(byTestId(container, 'terminal-session-create-empty')).not.toBeNull()
    expect(byTestId(container, 'terminal-session-tabs')).toBeNull()

    await click(container, 'terminal-session-create-empty')

    expect(createBodies).toHaveLength(1)
    expect(createBodies[0]).toMatchObject({ project_id: PROJECT, session_id: SESSION })
  })

  it('чужие терминалы (другая сессия) в переключатель не попадают', async () => {
    serverTerminals = [T1, makeTerminal('t-other', { sessionId: 's-other', createdAt: 500 })]
    const container = await render()

    expect(byTestId(container, 'terminal-session-tab-t-other')).toBeNull()
    expect(byTestId(container, 'terminal-session-tab-t1')).not.toBeNull()
  })

  it('список сессии запрашивается вместе с завершёнными (include_exited)', async () => {
    await render()

    const url = String(mocks.fetchJSON.mock.calls[0]?.[0] ?? '')
    expect(url).toContain('/terminals?')
    expect(url).toContain('include_exited=true')
  })

  it('завершённый (восстановленный) терминал виден в переключателе со статусом', async () => {
    serverTerminals = [
      T1,
      makeTerminal('t-restored', { status: 'exited', restored: true, createdAt: 2000 }),
    ]
    const container = await render()

    const restoredTab = byTestId(container, 'terminal-session-tab-t-restored')
    expect(restoredTab).not.toBeNull()
    expect(restoredTab?.getAttribute('data-status')).toBe('exited')
    // Статус в подписи кнопки и текстом рядом с точкой.
    expect(restoredTab?.getAttribute('title')).toContain('finished')
    expect(byTestId(container, 'terminal-session-status-t-restored')?.textContent).toBe('finished')
    // Точка статуса на месте.
    expect(byTestId(container, 'terminal-session-dot-t-restored')).not.toBeNull()
  })
})
