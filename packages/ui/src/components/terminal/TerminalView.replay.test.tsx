/**
 * `TerminalView` — реплей снимка не должен превращаться во ввод (PROP-132).
 *
 * Контракт:
 * - пока снимок вывода пишется в эмулятор (`replaying`), данные из
 *   `term.onData` **отбрасываются**: это ответы xterm на исторические
 *   запросы (DA1 `ESC[?1;2c`, DA2 `ESC[>0;276;0c`, OSC-цвет), а не ввод
 *   человека. Иначе они уходят в PTY, и tmux по SSH печатает их текстом
 *   (`1;2c0;276;0c`);
 * - после завершения реплея тот же вызов `onData` снова уходит в PTY —
 *   пользовательский ввод не теряется;
 * - `stripEmulatorQueries` вычищает из снимка только запросы, не влияющие на
 *   экран, и не трогает режимы (`ESC[?1049h`, `ESC[2J`) и обычный текст.
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
  /** Обработчик ввода, который зарегистрировал `TerminalView`. */
  onDataHandler: null as ((data: string) => void) | null,
  get: vi.fn(),
  outputSince: vi.fn(),
  input: vi.fn(),
  stream: vi.fn(),
  notify: vi.fn(),
}))

// xterm.js в jsdom не работает — подменяем эмулятор минимальной заглушкой.
// `write` вызывает колбэк (реплей снимается по нему), `onData` запоминает
// обработчик — тест дёргает его сам, как это сделал бы xterm.
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
    onData(handler: (data: string) => void): { dispose: () => void } {
      mocks.onDataHandler = handler
      return { dispose: () => {} }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onScroll(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    write(data: string, callback?: () => void): void {
      mocks.writes.push(data)
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

// Тема интерфейса в тестах не нужна — палитра terminal берётся из дефолта.
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
import { stripEmulatorQueries, TerminalView } from './TerminalView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const TERMINAL_ID = 't1'
const TAB_ID = 'terminal-t1'

/** Ответ DA1, который xterm сгенерировал бы при реплее `ESC[c`. */
const DA1_RESPONSE = '\x1b[?1;2c'

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

/** Промис с внешним разрешением — «снимок ещё не пришёл». */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Подождать реальное время (батчинг ввода — 30 мс, интервал — 50 мс). */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/** Вызвать сохранённый обработчик ввода эмулятора (как это делает xterm). */
async function emitData(data: string): Promise<void> {
  const handler = mocks.onDataHandler
  expect(handler, 'обработчик term.onData не зарегистрирован').not.toBeNull()
  await act(async () => {
    handler?.(data)
  })
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writes.length = 0
  mocks.onDataHandler = null
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useTerminalsStore.setState({
    terminalsById: { [TERMINAL_ID]: makeTerminal({ status: 'running' }) },
    order: [TERMINAL_ID],
  })
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

describe('TerminalView — реплей снимка не превращается во ввод', () => {
  it('ответ эмулятора во время реплея в PTY не уходит', async () => {
    // Снимок отложен: реплей ещё не начался и не закончился.
    const snapshot = deferred<{
      data: string
      seq: number
      nextSeq: number
      truncated: boolean
      totalBytes: number
      droppedBytes: number
    }>()
    mocks.outputSince.mockReturnValue(snapshot.promise)

    await render()
    expect(mocks.onDataHandler, 'обработчик term.onData не зарегистрирован').not.toBeNull()

    // xterm отвечает на исторический `ESC[c` — это не ввод человека.
    await emitData(DA1_RESPONSE)
    await wait(120)

    expect(mocks.input).not.toHaveBeenCalled()
  })

  it('после завершения реплея тот же ввод уходит в PTY', async () => {
    const snapshot = deferred<{
      data: string
      seq: number
      nextSeq: number
      truncated: boolean
      totalBytes: number
      droppedBytes: number
    }>()
    mocks.outputSince.mockReturnValue(snapshot.promise)

    await render()

    // Снимок с запросом DA1 и ответом на него: запрос вычищается, ответ
    // остаётся текстом в буфере (он ничего не триггерит).
    snapshot.resolve({
      data: `история\x1b[c${DA1_RESPONSE}`,
      seq: 0,
      nextSeq: 7,
      truncated: false,
      totalBytes: 20,
      droppedBytes: 0,
    })
    await flush()

    // Снимок записан уже очищенным: запрос `ESC[c` вырезан, ответ — нет.
    expect(mocks.writes.length).toBeGreaterThan(0)
    expect(mocks.writes[0]).toBe(`история${DA1_RESPONSE}`)

    // Реплей завершён (колбэк `write` вызван) — ввод снова живой.
    await emitData('ls\n')
    await wait(120)

    expect(mocks.input).toHaveBeenCalledWith(TERMINAL_ID, 'ls\n')
  })
})

describe('stripEmulatorQueries', () => {
  it('вырезает запросы эмулятора', () => {
    const input = [
      'a',
      '\x1b[c', // DA1
      '\x1b[>c', // DA2
      '\x1b[=c', // DA3
      '\x1b[5n', // DSR: статус
      '\x1b[6n', // DSR: позиция курсора
      '\x1b[>q', // XTVERSION
      '\x1b]10;?\x07', // OSC 10 — цвет текста
      '\x1b]11;?\x1b\\', // OSC 11 — цвет фона (ST)
      '\x1b]4;1;?\x07', // OSC 4 — палитра
      'b',
    ].join('')

    expect(stripEmulatorQueries(input)).toBe('ab')
  })

  it('не трогает режимы и обычный текст', () => {
    const input =
      '\x1b[?1049h\x1b[2J\x1b[H' +
      '\x1b[32mзелёный\x1b[0m text' +
      '\x1b[?25l' +
      '\x1b]0;title\x07' +
      '\x1b]10;#ffffff\x07' +
      '\x1b[38;5;196m'

    expect(stripEmulatorQueries(input)).toBe(input)
  })

  it('пустая строка остаётся пустой', () => {
    expect(stripEmulatorQueries('')).toBe('')
  })
})
