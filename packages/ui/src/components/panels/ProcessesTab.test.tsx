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
  listProcesses: vi.fn(),
  getProcessLogs: vi.fn(),
  stopProcess: vi.fn(),
  removeProcess: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listProcesses: mocks.listProcesses,
    getProcessLogs: mocks.getProcessLogs,
    stopProcess: mocks.stopProcess,
    removeProcess: mocks.removeProcess,
  },
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProcessesTab } from './ProcessesTab'
import { useUIStore } from '@/stores/useUIStore'
import { useProcessesStore } from '@/stores/processesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Фоновый прогон (процесс или саб-агент). */
function makeRun(id: string, overrides: Record<string, unknown> = {}) {
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

async function renderProcesses(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProcessesTab />
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
  mocks.listProcesses.mockResolvedValue([])
  mocks.getProcessLogs.mockResolvedValue({
    content: 'вывод процесса\n',
    offset: 0,
    nextOffset: 15,
    totalBytes: 15,
    truncated: false,
  })
  mocks.stopProcess.mockResolvedValue({ status: 'stopping' })
  mocks.removeProcess.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)

  useProcessesStore.setState({
    byId: {},
    order: [],
    logs: {},
    pendingIds: [],
    error: null,
  })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
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

describe('ProcessesTab — единый реестр фоновых прогонов (PROP-096/097)', () => {
  it('рендерит список прогонов: вид, статус, команда', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { command: 'npm run build', cwd: '/work' }),
      makeRun('bgr_2', {
        kind: 'subagent',
        status: 'completed',
        childSessionId: 'child-1',
        description: 'Рефакторинг',
        exitCode: 0,
        finishedAt: '2026-10-01T00:05:00.000Z',
      }),
    ])

    const container = await renderProcesses()

    expect(mocks.listProcesses).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()

    // Вид прогона и статус.
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')?.getAttribute('data-kind')).toBe(
      'process',
    )
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')?.getAttribute('data-kind')).toBe(
      'subagent',
    )
    expect(container.querySelector('[data-testid="processes-status-bgr_1"]')?.textContent).toContain('running')
    expect(container.querySelector('[data-testid="processes-status-bgr_2"]')?.textContent).toContain('completed')

    // Команда и каталог процесса.
    const text = container.textContent ?? ''
    expect(text).toContain('npm run build')
    expect(text).toContain('/work')
    expect(text).toContain('Рефакторинг')
  })

  it('пустое состояние — «Фоновых процессов нет» + подсказка', async () => {
    mocks.listProcesses.mockResolvedValue([])

    const container = await renderProcesses()

    const empty = container.querySelector('[data-testid="processes-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No background processes')
    expect(empty?.textContent).toContain('appear here')
  })

  it('фильтр «Саб-агенты» оставляет только фоновых саб-агентов', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1'),
      makeRun('bgr_2', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()

    await click(container, 'processes-filter-subagent')

    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).toBeNull()
  })

  it('фильтр «Только текущая сессия» оставляет прогоны активной сессии', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { sessionId: 's1' }),
      makeRun('bgr_2', { sessionId: 's2' }),
    ])

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()

    const toggle = container.querySelector('[data-testid="processes-kind-filter"] [role="switch"]')
    expect(toggle).not.toBeNull()
    await act(async () => {
      ;(toggle as HTMLElement).click()
    })
    await flush()

    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).toBeNull()
  })

  it('«Остановить» вызывает stopProcess (после подтверждения)', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'sleep 100' })])

    const container = await renderProcesses()
    await click(container, 'processes-stop-bgr_1')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.stopProcess).toHaveBeenCalledWith('bgr_1')
  })

  it('отказ в подтверждении не вызывает stopProcess', async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1')])

    const container = await renderProcesses()
    await click(container, 'processes-stop-bgr_1')

    expect(mocks.stopProcess).not.toHaveBeenCalled()
  })

  it('«Удалить» вызывает removeProcess и убирает запись', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { status: 'completed', finishedAt: '2026-10-01T00:05:00.000Z' }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-remove-bgr_1')

    expect(mocks.removeProcess).toHaveBeenCalledWith('bgr_1')
    expect(useProcessesStore.getState().byId['bgr_1']).toBeUndefined()
  })

  it('«Открыть сессию» открывает дочернюю сессию в центральной вкладке', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-open-bgr_1')

    const tabs = useUIStore.getState().centerTabs
    const opened = tabs.find((tab) => tab.data.sessionId === 'child-1')
    expect(opened).toBeDefined()
    expect(opened?.type).toBe('chat')
  })

  it('«Показать лог» подгружает лог процесса и выводит его', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="processes-log"]')).toBeNull()

    await click(container, 'processes-log-toggle-bgr_1')

    expect(mocks.getProcessLogs).toHaveBeenCalledWith('bgr_1', undefined)
    const log = container.querySelector('[data-testid="processes-log-content"]')
    expect(log?.textContent).toContain('вывод процесса')
  })

  it('у саб-агента кнопки лога нет (лог есть только у процесса)', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-log-toggle-bgr_1"]')).toBeNull()
  })

  it('ошибка загрузки списка показывается в баннере', async () => {
    mocks.listProcesses.mockRejectedValue(new Error('доступ запрещён'))

    const container = await renderProcesses()

    const error = container.querySelector('[data-testid="processes-error"]')
    expect(error?.textContent).toContain('доступ запрещён')
  })

  it('компактные кнопки: фильтры и действия строк без min-h-10/min-w-10 (десктоп)', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { command: 'npm test' }),
      makeRun('bgr_2', { status: 'completed', finishedAt: '2026-10-01T00:05:00.000Z' }),
    ])

    const container = await renderProcesses()

    // Фильтры — как сегментные кнопки в других вкладках: без принудительных 40px.
    const filter = container.querySelector('[data-testid="processes-filter-all"]') as HTMLElement
    expect(filter).not.toBeNull()
    expect(filter.className).not.toContain('min-h-10')
    expect(filter.className).not.toContain('min-w-10')

    // Кнопки-действия строк — компактные (size="icon" → 32px), не 40px.
    for (const testId of ['processes-stop-bgr_1', 'processes-log-toggle-bgr_1', 'processes-remove-bgr_2']) {
      const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
      expect(button, `элемент ${testId} не найден`).toBeTruthy()
      expect(button.className).not.toContain('min-h-10')
      expect(button.className).not.toContain('min-w-10')
      expect(button.className).toContain('size-8')
      // Тач-таргет ≥40px на coarse-указателе (ADR-044).
      expect(button.className).toContain('pointer-coarse:size-10')
    }
  })

  it('кнопки панели лога — компактные (size="icon")', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()
    await click(container, 'processes-log-toggle-bgr_1')

    for (const testId of ['processes-log-refresh', 'processes-log-hide']) {
      const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
      expect(button, `элемент ${testId} не найден`).toBeTruthy()
      expect(button.className).not.toContain('min-h-10')
      expect(button.className).not.toContain('min-w-10')
      expect(button.className).toContain('size-8')
    }
  })
})
