/**
 * `TerminalView` — затенение краёв терминала (PROP-132).
 *
 * Контракт — как у чата (`MessageList.handleScroll` → `data-scroll-shadow`):
 * **два независимых** признака. Верхнее затенение — только когда сверху есть
 * контент (`viewportY > 0`), нижнее — только когда снизу есть контент
 * (`viewportY < baseY`). Высота — как в чате (`--scroll-shadow-size: 3rem`).
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
  /** Положение вьюпорта в буфере xterm (как `term.buffer.active`). */
  buffer: { viewportY: 0, baseY: 0, length: 0, getLine: () => undefined },
  /** Обработчик прокрутки, который зарегистрировал `TerminalView`. */
  onScrollHandler: null as (() => void) | null,
  get: vi.fn(),
  outputSince: vi.fn(),
  input: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
}))

// xterm.js в jsdom не работает — подменяем эмулятор минимальной заглушкой.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    buffer = { active: mocks.buffer }
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
    onScroll(handler: () => void): { dispose: () => void } {
      mocks.onScrollHandler = handler
      return { dispose: () => {} }
    }
    write(_data: string, callback?: () => void): void {
      if (callback) setTimeout(callback, 0)
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
      input: mocks.input,
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

async function render(): Promise<HTMLElement> {
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
        <TerminalView tab={tab} />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

/** Прокрутка терминала: меняем положение вьюпорта и шлём событие. */
async function scrollTo(viewportY: number, baseY: number): Promise<void> {
  mocks.buffer.viewportY = viewportY
  mocks.buffer.baseY = baseY
  await act(async () => {
    mocks.onScrollHandler?.()
  })
  await flush(2)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.buffer.viewportY = 0
  mocks.buffer.baseY = 0
  mocks.onScrollHandler = null
  mocks.stream.mockResolvedValue(undefined)
  mocks.outputSince.mockResolvedValue({
    data: '',
    seq: 0,
    nextSeq: 0,
    truncated: false,
    totalBytes: 0,
    droppedBytes: 0,
  })
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useTerminalsStore.setState({
    terminalsById: { [TERMINAL_ID]: makeTerminal({ status: 'running' }) },
    order: [TERMINAL_ID],
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

describe('TerminalView — затенение краёв', () => {
  it('пустой терминал: затенения нет ни с одной стороны', async () => {
    const container = await render()

    expect(container.querySelector('[data-testid="terminal-fade-top"]')).toBeNull()
    expect(container.querySelector('[data-testid="terminal-fade-bottom"]')).toBeNull()
  })

  it('в середине буфера: затенены оба края', async () => {
    const container = await render()
    await scrollTo(5, 10)

    expect(container.querySelector('[data-testid="terminal-fade-top"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminal-fade-bottom"]')).not.toBeNull()
  })

  it('в самом низу буфера: затенён только верх', async () => {
    const container = await render()
    await scrollTo(10, 10)

    expect(container.querySelector('[data-testid="terminal-fade-top"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminal-fade-bottom"]')).toBeNull()
  })

  it('в начале буфера: затенён только низ', async () => {
    const container = await render()
    await scrollTo(0, 10)

    expect(container.querySelector('[data-testid="terminal-fade-top"]')).toBeNull()
    expect(container.querySelector('[data-testid="terminal-fade-bottom"]')).not.toBeNull()
  })

  it('высота затенения — как в чате (3rem)', async () => {
    const container = await render()
    await scrollTo(5, 10)

    const top = container.querySelector('[data-testid="terminal-fade-top"]') as HTMLElement
    const bottom = container.querySelector('[data-testid="terminal-fade-bottom"]') as HTMLElement
    expect(top.className).toContain('h-12')
    expect(bottom.className).toContain('h-12')
  })
})
