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
import {
  openSessionTerminalTab,
  openTerminalTab,
  sessionTerminalTabId,
  terminalTabTitle,
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

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
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
