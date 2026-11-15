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
  close: vi.fn(),
  openTerminalTab: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: {
      ...actual.terminalsApi,
      list: mocks.list,
      create: mocks.create,
      close: mocks.close,
    },
  }
})
vi.mock('@/lib/terminalTabs', () => ({ openTerminalTab: mocks.openTerminalTab }))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TerminalsSection } from './TerminalsSection'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Снимок терминала проекта. */
function makeTerminal(id: string, overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id,
    projectId: 'p1',
    sessionId: 's1',
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

/** Доводит отложенные промисы эффектов/обработчиков до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderSection(projectId: string | null = 'p1'): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TerminalsSection projectId={projectId} currentSessionId="s1" onlyCurrent={false} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await flush()
  return container
}

/** Клик по элементу с указанным `data-testid`. */
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
  mocks.list.mockResolvedValue({
    terminals: [],
    total: 0,
    offset: 0,
    limit: 50,
    nextOffset: null,
  })
  mocks.create.mockResolvedValue(makeTerminal('t-new'))
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
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

describe('TerminalsSection: создание терминала из шапки секции', () => {
  it('кнопка в шапке видна при непустом списке и создаёт терминал проекта', async () => {
    mocks.list.mockResolvedValue({
      terminals: [makeTerminal('t1')],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })
    const container = await renderSection()

    expect(container.querySelector('[data-testid="terminals-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-create"]')).toBeNull()
    const headerButton = container.querySelector('[data-testid="terminals-create-header"]')
    expect(headerButton, 'кнопки создания в шапке нет').not.toBeNull()
    expect((headerButton as HTMLButtonElement).disabled).toBe(false)

    await click(container, 'terminals-create-header')

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1' })
    expect(mocks.openTerminalTab).toHaveBeenCalledWith(makeTerminal('t-new'))
  })

  it('в пустом состоянии остаются обе кнопки — в шапке и в пустом блоке', async () => {
    const container = await renderSection()

    expect(container.querySelector('[data-testid="terminals-empty"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-create"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-create-header"]')).not.toBeNull()
  })

  it('пока идёт создание, кнопка шапки disabled и показывает спиннер', async () => {
    mocks.list.mockResolvedValue({
      terminals: [makeTerminal('t1')],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })
    let release: (value: TerminalDto) => void = () => {}
    mocks.create.mockReturnValue(
      new Promise<TerminalDto>((resolve) => {
        release = resolve
      }),
    )
    const container = await renderSection()

    const headerButton = container.querySelector(
      '[data-testid="terminals-create-header"]',
    ) as HTMLButtonElement
    await act(async () => {
      headerButton.click()
    })

    expect(headerButton.disabled).toBe(true)
    expect(headerButton.innerHTML).toContain('animate-spin')

    await act(async () => {
      release(makeTerminal('t-new'))
    })
    await flush()

    expect(headerButton.disabled).toBe(false)
    expect(headerButton.innerHTML).not.toContain('animate-spin')
  })

  it('без проекта шапки нет — только подсказка выбрать проект', async () => {
    const container = await renderSection(null)

    expect(container.querySelector('[data-testid="terminals-no-project"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-create-header"]')).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('список проекта запрашивается вместе с завершёнными (includeExited)', async () => {
    await renderSection()

    expect(mocks.list).toHaveBeenCalledWith({ projectId: 'p1', includeExited: true })
  })

  it('восстановленный (завершённый) терминал виден: бейдж статуса и кнопка «Открыть»', async () => {
    mocks.list.mockResolvedValue({
      terminals: [makeTerminal('t-restored', { status: 'exited', restored: true })],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })
    const container = await renderSection()

    expect(container.querySelector('[data-testid="terminals-item-t-restored"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="terminals-status-t-restored"]')?.textContent,
    ).toBe('finished')
    expect(container.querySelector('[data-testid="terminals-open-t-restored"]')).not.toBeNull()
  })
})
