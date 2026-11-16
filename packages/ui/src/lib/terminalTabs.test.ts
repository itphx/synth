/**
 * `lib/terminalTabs` — сборка вкладок терминалов и проверка их после
 * перезагрузки страницы (`verifyTerminalTabs`).
 *
 * Терминал живёт в памяти процесса: после рестарта ядра сервер его не знает
 * (`GET /terminals/:id` → 404) — такую вкладку закрываем, чтобы она не
 * «висела» с пустым экраном. Сетевая ошибка (не 404) закрывать вкладку не
 * должна: иначе рестарт инстанса съел бы открытые терминалы.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
  get: vi.fn(),
}))

vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: {
      ...actual.terminalsApi,
      get: mocks.get,
    },
  }
})

import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { SessionData } from '@/lib/api/synthApi'
import {
  openSessionTerminalTab,
  openTerminalTab,
  sessionTerminalTabId,
  syncTerminalTabTitle,
  terminalTabTitle,
  terminalTabTitleForSession,
  verifyTerminalTabs,
} from './terminalTabs'

/** Ошибка API v2: `fetchJSON` проставляет `status`. */
function apiError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status })
}

function terminalTab(id: string, terminalId: string): CenterTab {
  return {
    id,
    type: 'terminal',
    title: `Terminal ${terminalId}`,
    data: { terminalId },
  }
}

/** Сессия в списке сессий (источник имени для заголовка вкладки). */
function session(id: string, name: string | null): SessionData {
  return {
    id,
    name,
    user_id: 'u1',
    owner_id: 'u1',
    project_id: null,
    messages: [],
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

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useSessionsStore.setState({ sessions: [], error: null })
})

describe('terminalTabs — сборка вкладок', () => {
  it('заголовок вкладки: имя терминала → оболочка → id', () => {
    expect(terminalTabTitle({ id: 't1', title: 'Логи', shell: '/bin/zsh' })).toBe('Логи')
    expect(terminalTabTitle({ id: 't1', title: null, shell: '/bin/zsh' })).toBe('/bin/zsh')
    expect(terminalTabTitle({ id: 't1', title: null, shell: null })).toBe('t1')
  })

  it('openTerminalTab открывает вкладку терминала с его id и проектом', () => {
    openTerminalTab({ id: 't1', title: 'Логи', projectId: 'p1' })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.id).toBe('terminal-t1')
    expect(tabs[0]?.type).toBe('terminal')
    expect(tabs[0]?.title).toBe('Логи')
    expect(tabs[0]?.data).toMatchObject({ terminalId: 't1', projectId: 'p1' })
  })

  it('openTerminalTab без id ничего не открывает', () => {
    openTerminalTab({ id: '' })
    expect(useUIStore.getState().centerTabs).toHaveLength(0)
  })

  it('openTerminalTab кладёт в данные вкладки проект и сессию терминала', () => {
    openTerminalTab({ id: 't1', title: 'Логи', projectId: 'p1', sessionId: 's1' })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs[0]?.data).toMatchObject({
      terminalId: 't1',
      projectId: 'p1',
      sessionId: 's1',
    })
  })

  it('вкладка-сессия: одна на сессию, активный терминал — в данных', () => {
    openSessionTerminalTab({
      sessionId: 's1',
      sessionTitle: 'Сессия 1',
      projectId: 'p1',
      terminalId: 't2',
    })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.id).toBe(sessionTerminalTabId('s1'))
    expect(tabs[0]?.title).toBe('Сессия 1')
    expect(tabs[0]?.data).toMatchObject({
      sessionId: 's1',
      projectId: 'p1',
      terminalId: 't2',
    })
  })
})

describe('terminalTabs — заголовок вкладки = имя сессии', () => {
  it('терминал с сессией: заголовок вкладки — имя сессии', () => {
    useSessionsStore.setState({ sessions: [session('s1', 'Сессия 1')] })

    expect(terminalTabTitleForSession({ id: 't1', shell: '/bin/zsh', sessionId: 's1' })).toBe(
      'Сессия 1',
    )

    openTerminalTab({ id: 't1', title: 'Логи', shell: '/bin/zsh', sessionId: 's1' })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs[0]?.title).toBe('Сессия 1')
  })

  it('сессия без имени — её id', () => {
    useSessionsStore.setState({ sessions: [session('s1', null)] })

    expect(terminalTabTitleForSession({ id: 't1', shell: '/bin/zsh', sessionId: 's1' })).toBe('s1')
  })

  it('сессии нет в списке — откат на заголовок терминала', () => {
    useSessionsStore.setState({ sessions: [] })

    expect(terminalTabTitleForSession({ id: 't1', title: 'Логи', sessionId: 's1' })).toBe('Логи')
    expect(terminalTabTitleForSession({ id: 't1', shell: '/bin/zsh' })).toBe('/bin/zsh')
  })

  it('syncTerminalTabTitle переименовывает вкладку по имени сессии', () => {
    useUIStore.setState({
      centerTabs: [terminalTab('terminal-t1', 't1')],
      activeCenterTabId: 'terminal-t1',
    })
    useSessionsStore.setState({ sessions: [session('s1', 'Новое имя')] })

    syncTerminalTabTitle('terminal-t1', 's1')

    expect(useUIStore.getState().centerTabs[0]?.title).toBe('Новое имя')
  })

  it('syncTerminalTabTitle: терминал без сессии и неизвестная сессия заголовок не трогают', () => {
    useUIStore.setState({
      centerTabs: [terminalTab('terminal-t1', 't1')],
      activeCenterTabId: 'terminal-t1',
    })
    useSessionsStore.setState({ sessions: [session('s1', 'Сессия 1')] })

    syncTerminalTabTitle('terminal-t1', null)
    syncTerminalTabTitle('terminal-t1', 's-other')

    expect(useUIStore.getState().centerTabs[0]?.title).toBe('Terminal t1')
  })
})

describe('verifyTerminalTabs — проверка вкладок после перезагрузки', () => {
  it('терминала нет на сервере (404) — вкладка закрывается', async () => {
    useUIStore.setState({
      centerTabs: [terminalTab('terminal-t1', 't1')],
      activeCenterTabId: 'terminal-t1',
    })
    mocks.get.mockRejectedValue(apiError(404, 'not found'))

    await verifyTerminalTabs()

    expect(mocks.get).toHaveBeenCalledWith('t1')
    expect(useUIStore.getState().centerTabs).toHaveLength(0)
  })

  it('живой терминал — вкладка остаётся', async () => {
    useUIStore.setState({
      centerTabs: [terminalTab('terminal-t1', 't1')],
      activeCenterTabId: 'terminal-t1',
    })
    mocks.get.mockResolvedValue({ id: 't1', status: 'running' })

    await verifyTerminalTabs()

    expect(mocks.get).toHaveBeenCalledWith('t1')
    expect(useUIStore.getState().centerTabs).toHaveLength(1)
    expect(useUIStore.getState().centerTabs[0]?.id).toBe('terminal-t1')
  })

  it('сетевая ошибка (не 404) — вкладку не закрываем', async () => {
    useUIStore.setState({
      centerTabs: [terminalTab('terminal-t1', 't1')],
      activeCenterTabId: 'terminal-t1',
    })
    mocks.get.mockRejectedValue(apiError(503, 'service unavailable'))

    await verifyTerminalTabs()

    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })

  it('вкладка без активного терминала не проверяется', async () => {
    useUIStore.setState({
      centerTabs: [
        {
          id: 'terminal-session-s1',
          type: 'terminal',
          title: 'Сессия 1',
          data: { sessionId: 's1' },
        },
      ],
      activeCenterTabId: 'terminal-session-s1',
    })

    await verifyTerminalTabs()

    expect(mocks.get).not.toHaveBeenCalled()
    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })

  it('вкладки не-терминала не трогаем', async () => {
    useUIStore.setState({
      centerTabs: [
        { id: 'chat-s1', type: 'chat', title: 'Сессия', data: { sessionId: 's1' } },
      ],
      activeCenterTabId: 'chat-s1',
    })

    await verifyTerminalTabs()

    expect(mocks.get).not.toHaveBeenCalled()
    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })
})
