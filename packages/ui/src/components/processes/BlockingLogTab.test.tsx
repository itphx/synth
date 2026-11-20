// BlockingLogTab: live-лог **блокирующего** прогона (ADR-111 §detach).
//
// Здесь проверяется отображение ANSI-цветов: shell исполняется в PTY с
// `TERM=xterm-256color`, поэтому вывод приходит с SGR-последовательностями, а
// раньше рендерился в `<pre>` как есть (`□[32m` вместо цвета). Модуль разбора —
// `lib/ansi.ts`, компонент — `components/ansi/AnsiText`.

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
  getBlockingLogs: vi.fn(),
  stopBlockingRun: vi.fn(),
  refreshBlocking: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getBlockingLogs: mocks.getBlockingLogs,
    stopBlockingRun: mocks.stopBlockingRun,
  },
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
  useNotification: () => ({ notify: vi.fn() }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { BlockingLogTab } from './BlockingLogTab'
import { useProcessesStore } from '@/stores/processesStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import type { CenterTab } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Доводит отложенные промисы эффектов до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function makeTab(runId: string, title = 'npm test'): CenterTab {
  return {
    id: `blocking-${runId}`,
    type: 'process-log',
    title,
    data: { blockingRunId: runId, blockingRunTitle: title, sessionId: 's1' },
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
        <BlockingLogTab tab={tab} />
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
  mocks.getBlockingLogs.mockResolvedValue({
    content: 'вывод\n',
    offset: 0,
    nextOffset: 5,
    totalBytes: 5,
    truncated: false,
  })

  useProcessesStore.setState({
    blocking: [
      {
        id: 'brun_1',
        kind: 'process',
        sessionId: 's1',
        title: 'npm test',
        startedAt: new Date().toISOString(),
      },
    ],
    refreshBlocking: mocks.refreshBlocking,
  } as never)

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

describe('BlockingLogTab — live-лог блокирующего прогона', () => {
  it('показывает вывод прогона', async () => {
    const container = await renderTab(makeTab('brun_1'))

    expect(mocks.getBlockingLogs).toHaveBeenCalledWith('brun_1', { sessionId: 's1', offset: 0 })
    const content = container.querySelector('[data-testid="blocking-log-content"]')
    expect(content?.textContent).toContain('вывод')
  })

  it('ANSI-цвета: вывод раскрашен, ESC в тексте отсутствует', async () => {
    mocks.getBlockingLogs.mockResolvedValue({
      content: '\u001b[1m\u001b[31mFAIL\u001b[0m a.test.ts\n\u001b[90m1 failed\u001b[39m\n',
      offset: 0,
      nextOffset: 45,
      totalBytes: 45,
      truncated: false,
    })

    const container = await renderTab(makeTab('brun_1'))
    const content = container.querySelector('[data-testid="blocking-log-content"]') as HTMLElement

    expect(content.textContent).toContain('FAIL a.test.ts')
    expect(content.textContent).toContain('1 failed')
    expect(content.textContent).not.toContain('\u001b')
    // Яркий красный — класс темы; `1m` даёт жирное начертание.
    expect(content.querySelector('.text-ansi-red')).not.toBeNull()
    expect(content.querySelector('.text-ansi-bright-black')).not.toBeNull()
    expect(content.querySelector('.font-bold')).not.toBeNull()
  })

  it('truecolor и палитра 256 — инлайновым стилем, без dangerouslySetInnerHTML', async () => {
    mocks.getBlockingLogs.mockResolvedValue({
      content: '\u001b[38;2;18;52;86mtruecolor\u001b[0m \u001b[38;5;196mcube\u001b[0m\n',
      offset: 0,
      nextOffset: 50,
      totalBytes: 50,
      truncated: false,
    })

    const container = await renderTab(makeTab('brun_1'))
    const colored = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="blocking-log-content"] span'),
    ).filter((span) => span.style.color !== '')

    expect(colored.map((span) => span.style.color)).toEqual([
      'rgb(18, 52, 86)',
      'rgb(255, 0, 0)',
    ])
  })

  it('выключение «Цветов» даёт плоский текст', async () => {
    mocks.getBlockingLogs.mockResolvedValue({
      content: '\u001b[32mPASS\u001b[0m rest\n',
      offset: 0,
      nextOffset: 20,
      totalBytes: 20,
      truncated: false,
    })

    const container = await renderTab(makeTab('brun_1'))
    expect(
      container.querySelector('[data-testid="blocking-log-colors"]')?.getAttribute('aria-pressed'),
    ).toBe('true')

    await click(container, 'blocking-log-colors')

    const content = container.querySelector('[data-testid="blocking-log-content"]') as HTMLElement
    expect(
      container.querySelector('[data-testid="blocking-log-colors"]')?.getAttribute('aria-pressed'),
    ).toBe('false')
    expect(content.textContent).toContain('PASS rest')
    expect(content.textContent).not.toContain('\u001b')
    expect(content.querySelector('.text-ansi-green')).toBeNull()
  })

  it('прогресс-бар с \\r показывает финальный кадр, а не все кадры', async () => {
    mocks.getBlockingLogs.mockResolvedValue({
      content: '\r 10%\r 55%\r100%\n',
      offset: 0,
      nextOffset: 20,
      totalBytes: 20,
      truncated: false,
    })

    const container = await renderTab(makeTab('brun_1'))
    const text = container.querySelector('[data-testid="blocking-log-content"]')?.textContent ?? ''

    expect(text.trim()).toBe('100%')
    expect(text).not.toContain('10%')
  })
})
