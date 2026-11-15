/**
 * `TerminalView` — восстановление завершённого терминала (PROP-132, Ф3б).
 *
 * Контракт:
 * - терминал в статусе `exited` показывает сохранённый вывод (снимок
 *   `GET /terminals/:id/output`) и кнопку «Восстановить»;
 * - клик по «Восстановить» поднимает терминал заново (`POST /terminals/:id/restart`);
 * - терминала нет на сервере (404) — вкладка закрывается; вкладка-сессия
 *   передаёт свой обработчик (`onTerminalMissing`), и тогда остаётся открытой.
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
  /** Всё, что записано в эмулятор терминала. */
  writes: [] as string[],
  get: vi.fn(),
  outputSince: vi.fn(),
  restart: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
}))

// xterm.js в jsdom не работает — подменяем эмулятор минимальной заглушкой.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    buffer = { active: { viewportY: 0, baseY: 0, length: 0, getLine: () => undefined } }
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onSelectionChange(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onBell(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onScroll(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    write(data: string): void {
      mocks.writes.push(data)
    }
    getSelection(): string {
      return ''
    }
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose(): void {}
  },
}))

vi.mock('./terminalStream', () => ({
  runTerminalStreamSession: (...args: unknown[]) => mocks.stream(...args),
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

// Тема интерфейса в тестах не нужна — палитраterminal берётся из дефолта.
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: undefined }),
  useOptionalThemeSystem: () => ({ currentTheme: undefined }),
}))

vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: {
      ...actual.terminalsApi,
      get: mocks.get,
      outputSince: mocks.outputSince,
      restart: mocks.restart,
    },
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'
import { TerminalView } from './TerminalView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const TERMINAL_ID = 't1'
const TAB_ID = 'terminal-t1'

/** Снимок терминала. */
function makeTerminal(overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id: TERMINAL_ID,
    projectId: 'p1',
    sessionId: 's1',
    ownerId: null,
    cwd: '/workspace/demo',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: 'Логи',
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

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function render(
  props: { onTerminalMissing?: (id: string) => void } = {},
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const tab: CenterTab = {
    id: TAB_ID,
    type: 'terminal',
    title: 'Логи',
    data: { terminalId: TERMINAL_ID, projectId: 'p1' },
  }
  useUIStore.setState({ centerTabs: [tab], activeCenterTabId: TAB_ID })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TerminalView tab={tab} {...props} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writes.length = 0
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  mocks.outputSince.mockResolvedValue({
    data: 'сохранённый вывод\n',
    seq: 0,
    nextSeq: 12,
    truncated: false,
    totalBytes: 12,
    droppedBytes: 0,
  })
  mocks.restart.mockImplementation(async () => makeTerminal({ status: 'running' }))
  mocks.stream.mockResolvedValue(undefined)
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

describe('TerminalView — завершённый терминал', () => {
  it('статус exited: показывает сохранённый вывод и кнопку «Восстановить»', async () => {
    useTerminalsStore.setState({
      terminalsById: { [TERMINAL_ID]: makeTerminal({ status: 'exited', exitCode: 0 }) },
      order: [TERMINAL_ID],
    })

    const container = await render()

    // Снимок вывода записан в эмулятор — человек видит сохранённый вывод.
    expect(mocks.outputSince).toHaveBeenCalledWith(TERMINAL_ID, 0)
    expect(mocks.writes.join('')).toContain('сохранённый вывод')

    const restore = byTestId(container, 'terminal-restore') as HTMLButtonElement
    expect(restore, 'кнопки «Восстановить» нет').not.toBeNull()
    expect(restore.textContent).toContain('Restore terminal')
    // Статус терминала — «finished», и плашка «Terminal finished».
    expect(container.textContent).toContain('finished')
    expect(container.textContent).toContain('Terminal finished')
  })

  it('клик по «Восстановить» поднимает терминал заново', async () => {
    useTerminalsStore.setState({
      terminalsById: { [TERMINAL_ID]: makeTerminal({ status: 'exited', exitCode: 0 }) },
      order: [TERMINAL_ID],
    })

    const container = await render()

    const restore = byTestId(container, 'terminal-restore') as HTMLButtonElement
    await act(async () => {
      restore.click()
    })
    await flush()

    expect(mocks.restart).toHaveBeenCalledWith(TERMINAL_ID)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Terminal restored' }),
    )
  })

  it('у живого терминала кнопки «Восстановить» нет', async () => {
    useTerminalsStore.setState({
      terminalsById: { [TERMINAL_ID]: makeTerminal({ status: 'running' }) },
      order: [TERMINAL_ID],
    })

    const container = await render()

    expect(byTestId(container, 'terminal-restore')).toBeNull()
    expect(mocks.restart).not.toHaveBeenCalled()
  })
})

describe('TerminalView — терминала нет на сервере (404)', () => {
  it('обработчик onTerminalMissing вызывается с id терминала', async () => {
    const onTerminalMissing = vi.fn()
    mocks.get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))

    await render({ onTerminalMissing })

    expect(mocks.get).toHaveBeenCalledWith(TERMINAL_ID)
    expect(onTerminalMissing).toHaveBeenCalledWith(TERMINAL_ID)
    // Вкладка-сессия остаётся открытой — закрывает её владелец вкладки.
    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })

  it('без обработчика — вкладка закрывается', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))

    await render()

    expect(useUIStore.getState().centerTabs).toHaveLength(0)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', text: 'The terminal is gone — the tab was closed' }),
    )
  })

  it('сетевая ошибка (не 404) — вкладка остаётся, показывается «не найден»', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }))

    const container = await render()

    expect(container.textContent).toContain('Terminal not found')
    expect(useUIStore.getState().centerTabs).toHaveLength(1)
  })
})
