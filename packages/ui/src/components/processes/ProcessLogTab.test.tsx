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
  getProcess: vi.fn(),
  getProcessLogs: vi.fn(),
  stopProcess: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getProcess: mocks.getProcess,
    getProcessLogs: mocks.getProcessLogs,
    stopProcess: mocks.stopProcess,
  },
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProcessLogTab } from './ProcessLogTab'
import { useProcessesStore, processLogKey } from '@/stores/processesStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { BackgroundRunRecord } from '@/lib/api/synthApi'
import type { CenterTab } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Фоновый прогон (процесс). */
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

/** Доводит отложенные промисы эффектов/обработчиков до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Вкладка «Вывод процесса» для прогона `runId`. */
function makeTab(runId: string, title = 'npm test'): CenterTab {
  return {
    id: `process-${runId}`,
    type: 'process-log',
    title,
    data: { processRunId: runId, sessionId: 's1' },
  }
}

async function renderTab(tab: CenterTab): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProcessLogTab tab={tab} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await flush()
  return container
}

/** Клик по кнопке с указанным `data-testid`. */
async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  expect(button, `элемент ${testId} не найден`).toBeTruthy()
  await act(async () => {
    button!.click()
  })
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProcess.mockResolvedValue(makeRun('bgr_1'))
  mocks.getProcessLogs.mockResolvedValue({
    content: 'вывод процесса\n',
    offset: 0,
    nextOffset: 15,
    totalBytes: 15,
    truncated: false,
  })
  mocks.stopProcess.mockResolvedValue({ status: 'stopping' })
  mocks.confirm.mockResolvedValue(true)

  useProcessesStore.setState({
    byId: {},
    order: [],
    logs: {},
    pendingIds: [],
    error: null,
  })

  // Сессия-владелец прогона: в шапке вывода показывается её имя.
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'Моя сессия', project_id: 'p1' }] as never,
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
})

describe('ProcessLogTab — экран вывода фонового прогона', () => {
  it('в шапке — «Время работы» и имя сессии (не сырой id)', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1', { command: 'npm test' }))

    const container = await renderTab(makeTab('bgr_1'))

    expect(container.querySelector('[data-testid="process-log-elapsed"]')?.textContent).toContain(
      'Uptime',
    )
    const session = container.querySelector('[data-testid="process-log-session"]')
    expect(session?.textContent).toContain('Моя сессия')
    expect(session?.textContent).not.toContain('s1')
  })

  it('сессии нет в списке — в шапке её id', async () => {
    useSessionsStore.setState({ sessions: [] } as never)
    useProcessesStore.getState().upsert(makeRun('bgr_1'))

    const container = await renderTab(makeTab('bgr_1'))

    const session = container.querySelector('[data-testid="process-log-session"]')
    expect(session?.textContent).toContain('s1')
  })

  it('по умолчанию читает общий поток (combined) и показывает вывод', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1', { command: 'npm test' }))

    const container = await renderTab(makeTab('bgr_1'))

    expect(mocks.getProcessLogs).toHaveBeenCalledWith('bgr_1', { offset: 0, stream: 'combined' })
    const content = container.querySelector('[data-testid="process-log-content"]')
    expect(content?.textContent).toContain('вывод процесса')
    // Накопленный текст лежит под ключом `runId:stream`.
    expect(
      useProcessesStore.getState().logs[processLogKey('bgr_1', 'combined')]?.content,
    ).toContain('вывод процесса')
  })

  it('переключение на stdout делает запрос с stream=stdout и показывает текст потока', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1'))
    mocks.getProcessLogs.mockImplementation(async (_id: string, options?: { stream?: string }) => {
      if (options?.stream === 'stdout') {
        return {
          content: 'только stdout\n',
          offset: 0,
          nextOffset: 13,
          totalBytes: 13,
          truncated: false,
        }
      }
      return {
        content: 'вывод процесса\n',
        offset: 0,
        nextOffset: 15,
        totalBytes: 15,
        truncated: false,
      }
    })

    const container = await renderTab(makeTab('bgr_1'))
    await click(container, 'process-log-stream-stdout')

    expect(mocks.getProcessLogs).toHaveBeenCalledWith('bgr_1', { offset: 0, stream: 'stdout' })
    const content = container.querySelector('[data-testid="process-log-content"]')
    expect(content?.textContent).toContain('только stdout')
    // Общий поток не затирается потоковым.
    expect(
      useProcessesStore.getState().logs[processLogKey('bgr_1', 'combined')]?.content,
    ).toContain('вывод процесса')
  })

  it('404 на потоке даёт подсказку, «Весь вывод» продолжает работать', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1'))
    mocks.getProcessLogs.mockImplementation(async (_id: string, options?: { stream?: string }) => {
      if (options?.stream !== 'combined') {
        throw Object.assign(new Error('log not found'), { status: 404 })
      }
      return {
        content: 'вывод процесса\n',
        offset: 0,
        nextOffset: 15,
        totalBytes: 15,
        truncated: false,
      }
    })

    const container = await renderTab(makeTab('bgr_1'))
    await click(container, 'process-log-stream-stdout')

    const hint = container.querySelector('[data-testid="process-log-stream-unavailable"]')
    expect(hint).not.toBeNull()
    expect(hint?.textContent).toContain('no separate stream file')
    expect(container.querySelector('[data-testid="process-log-error"]')).toBeNull()

    // Возврат к общему потоку работает.
    await click(container, 'process-log-stream-combined')
    expect(container.querySelector('[data-testid="process-log-stream-unavailable"]')).toBeNull()
    expect(container.querySelector('[data-testid="process-log-content"]')?.textContent).toContain(
      'вывод процесса',
    )
  })

  it('«Завершить» останавливает прогон после подтверждения', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1', { command: 'sleep 100' }))

    const container = await renderTab(makeTab('bgr_1'))
    await click(container, 'process-log-stop')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.stopProcess).toHaveBeenCalledWith('bgr_1')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Background run stopped', type: 'success' }),
    )
  })

  it('отказ в подтверждении не останавливает прогон', async () => {
    mocks.confirm.mockResolvedValue(false)
    useProcessesStore.getState().upsert(makeRun('bgr_1'))

    const container = await renderTab(makeTab('bgr_1'))
    await click(container, 'process-log-stop')

    expect(mocks.stopProcess).not.toHaveBeenCalled()
  })

  it('у завершённого прогона кнопки «Завершить» нет', async () => {
    useProcessesStore.getState().upsert(
      makeRun('bgr_1', { status: 'completed', finishedAt: '2026-10-01T00:05:00.000Z' }),
    )

    const container = await renderTab(makeTab('bgr_1'))

    expect(container.querySelector('[data-testid="process-log-stop"]')).toBeNull()
    expect(container.querySelector('[data-testid="process-log-status"]')?.textContent).toContain(
      'completed',
    )
  })

  it('неизвестный прогон даёт пустое состояние «Run not found»', async () => {
    mocks.getProcess.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))

    const container = await renderTab(makeTab('bgr_missing'))

    expect(container.querySelector('[data-testid="process-log-not-found"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="process-log-not-found"]')?.textContent).toContain(
      'Run not found',
    )
  })

  it('ANSI-цвета: лог раскрашен, управляющих символов ESC в тексте нет', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1'))
    mocks.getProcessLogs.mockResolvedValue({
      content: '\u001b[32mPASS\u001b[0m a.test.ts\n\u001b[90m1 passed\u001b[39m\n',
      offset: 0,
      nextOffset: 40,
      totalBytes: 40,
      truncated: false,
    })

    const container = await renderTab(makeTab('bgr_1'))
    const content = container.querySelector('[data-testid="process-log-content"]') as HTMLElement

    expect(content.textContent).toContain('PASS a.test.ts')
    expect(content.textContent).not.toContain('\u001b')
    // 16 базовых цветов — классами темы, а не инлайном.
    expect(content.querySelector('.text-ansi-green')).not.toBeNull()
    expect(content.querySelector('.text-ansi-bright-black')).not.toBeNull()
  })

  it('выключение «Цветов» даёт плоский текст без раскраски', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1'))
    mocks.getProcessLogs.mockResolvedValue({
      content: '\u001b[31mfail\u001b[0m rest\n',
      offset: 0,
      nextOffset: 20,
      totalBytes: 20,
      truncated: false,
    })

    const container = await renderTab(makeTab('bgr_1'))
    const toggle = container.querySelector('[data-testid="process-log-colors"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')

    await click(container, 'process-log-colors')

    const content = container.querySelector('[data-testid="process-log-content"]') as HTMLElement
    expect(
      container.querySelector('[data-testid="process-log-colors"]')?.getAttribute('aria-pressed'),
    ).toBe('false')
    expect(content.textContent).toContain('fail rest')
    expect(content.textContent).not.toContain('\u001b')
    expect(content.querySelector('.text-ansi-red')).toBeNull()
  })

  it('переключатель потоков отражает выбранный поток (aria-pressed)', async () => {
    useProcessesStore.getState().upsert(makeRun('bgr_1'))

    const container = await renderTab(makeTab('bgr_1'))
    expect(
      container.querySelector('[data-testid="process-log-stream-combined"]')?.getAttribute('aria-pressed'),
    ).toBe('true')

    await click(container, 'process-log-stream-stderr')
    expect(
      container.querySelector('[data-testid="process-log-stream-combined"]')?.getAttribute('aria-pressed'),
    ).toBe('false')
    expect(
      container.querySelector('[data-testid="process-log-stream-stderr"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
  })
})
