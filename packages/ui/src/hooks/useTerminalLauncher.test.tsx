/**
 * `useTerminalLauncher` — переход «сессия ↔ терминал» (PROP-132).
 *
 * Ключевой сценарий — **восстановленные** терминалы (поднятые из снимков
 * после рестарта ядра): сервер по умолчанию их не отдаёт, поэтому клиент
 * просит список с `includeExited: true`, а `open()`:
 *   - при **только завершённых** терминалах — открывает вкладку-сессию
 *     (там кнопка «Восстановить»), новый терминал НЕ создаёт;
 *   - при отсутствии терминалов вовсе — создаёт первый.
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
  list: vi.fn(),
  create: vi.fn(),
  openSessionTerminalTab: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: {
      ...actual.terminalsApi,
      list: mocks.list,
      create: mocks.create,
    },
  }
})
vi.mock('@/lib/terminalTabs', () => ({ openSessionTerminalTab: mocks.openSessionTerminalTab }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'
import { useTerminalLauncher } from './useTerminalLauncher'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION = 's1'
const PROJECT = 'p1'

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

/** Завершённый терминал (восстановленный из снимка после рестарта ядра). */
const RESTORED = makeTerminal('t-restored', {
  status: 'exited',
  restored: true,
  createdAt: 1000,
})

/** Страница списка терминалов (сервер отдаёт объект-страницу). */
function page(terminals: TerminalDto[]) {
  return {
    terminals,
    total: terminals.length,
    offset: 0,
    limit: 50,
    nextOffset: null,
  }
}

/**
 * Состав терминалов на сервере.
 *
 * Сервер отдаёт **только живые**, если не запрошен `includeExited` — как и
 * делает настоящий `GET /terminals` (завершённые скрыты по умолчанию).
 */
let serverTerminals: TerminalDto[] = []

mocks.list.mockImplementation(async (options?: { includeExited?: boolean }) =>
  page(
    options?.includeExited
      ? serverTerminals
      : serverTerminals.filter((terminal) => terminal.status !== 'exited'),
  ),
)

/** Значения хука — наружу (тест зовёт `open()`). */
let launcher: ReturnType<typeof useTerminalLauncher> | null = null

function Harness(): React.ReactElement {
  launcher = useTerminalLauncher(SESSION, PROJECT)
  return <div data-testid="launcher" />
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(): Promise<void> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useSessionsStore.setState({
    sessions: [{ id: SESSION, name: 'Session 1' } as never],
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness />
      </I18nProvider>,
    )
  })
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  launcher = null
  serverTerminals = []
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })
  mocks.create.mockResolvedValue(makeTerminal('t-new'))
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

describe('useTerminalLauncher — восстановленные терминалы', () => {
  it('список сессии запрашивается вместе с завершёнными (includeExited)', async () => {
    await render()

    expect(mocks.list).toHaveBeenCalledWith({ sessionId: SESSION, includeExited: true })
  })

  it('при только завершённых терминалах открывает вкладку-сессию и не создаёт новый', async () => {
    serverTerminals = [RESTORED]
    await render()

    expect(launcher?.sessionTerminals).toHaveLength(1)
    expect(launcher?.liveTerminal).toBeUndefined()
    expect(launcher?.hasTerminal).toBe(true)

    await act(async () => {
      await launcher?.open()
    })
    await flush()

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.openSessionTerminalTab).toHaveBeenCalledTimes(1)
    expect(mocks.openSessionTerminalTab).toHaveBeenCalledWith({
      sessionId: SESSION,
      sessionTitle: 'Session 1',
      projectId: PROJECT,
      terminalId: RESTORED.id,
    })
  })

  it('при живом терминале открывает вкладку на нём', async () => {
    const live = makeTerminal('t-live', { createdAt: 2000 })
    serverTerminals = [RESTORED, live]
    await render()

    await act(async () => {
      await launcher?.open()
    })
    await flush()

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.openSessionTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: live.id }),
    )
  })

  it('без терминалов вовсе — создаёт первый и открывает вкладку на нём', async () => {
    serverTerminals = []
    await render()

    await act(async () => {
      await launcher?.open()
    })
    await flush()

    expect(mocks.create).toHaveBeenCalledWith({ projectId: PROJECT, sessionId: SESSION })
    expect(mocks.openSessionTerminalTab).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't-new' }),
    )
  })
})
