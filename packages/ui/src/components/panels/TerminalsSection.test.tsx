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
  getTerminalForeground: vi.fn(),
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
vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getTerminalForeground: mocks.getTerminalForeground },
}))
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
import { useUIStore } from '@/stores/useUIStore'
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

async function renderSection(
  options: { projectId?: string | null; sessionId?: string | null; sessionOnly?: boolean } = {},
): Promise<HTMLElement> {
  const { projectId = 'p1', sessionId = 's1', sessionOnly = false } = options
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TerminalsSection projectId={projectId} sessionId={sessionId} sessionOnly={sessionOnly} />
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

/** Средний клик по карточке терминала. */
async function middleClick(container: HTMLElement, terminalId: string): Promise<void> {
  const card = container.querySelector(
    `[data-testid="terminals-item-${terminalId}"]`,
  ) as HTMLElement | null
  expect(card, `карточка ${terminalId} не найдена`).toBeTruthy()
  await act(async () => {
    card!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
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
  mocks.close.mockResolvedValue(undefined)
  mocks.getTerminalForeground.mockResolvedValue({ isShell: true })
  mocks.confirm.mockResolvedValue(true)
  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
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
    const headerButton = container.querySelector('[data-testid="terminals-create-header"]')
    expect(headerButton, 'кнопки создания в шапке нет').not.toBeNull()
    expect((headerButton as HTMLButtonElement).disabled).toBe(false)

    await click(container, 'terminals-create-header')

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1' })
    expect(mocks.openTerminalTab).toHaveBeenCalledWith(makeTerminal('t-new'))
  })

  it('в пустом состоянии кнопки создания в блоке нет — остаётся только шапка', async () => {
    const container = await renderSection()

    expect(container.querySelector('[data-testid="terminals-empty"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-create"]')).toBeNull()
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

  it('без проекта и сессии шапки нет — только подсказка выбрать проект', async () => {
    const container = await renderSection({ projectId: null, sessionId: null })

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

  it('в карточке есть строка «Время работы»', async () => {
    mocks.list.mockResolvedValue({
      terminals: [makeTerminal('t1')],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })
    const container = await renderSection()

    expect(container.textContent).toContain('Uptime')
  })
})

describe('TerminalsSection: средний клик по терминалу', () => {
  /** Терминал в списке (живой). */
  function withTerminal(id = 't1', overrides: Partial<TerminalDto> = {}): void {
    mocks.list.mockResolvedValue({
      terminals: [makeTerminal(id, overrides)],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })
  }

  it('оболочка на переднем плане → терминал закрывается, вкладка закрыта', async () => {
    withTerminal()
    useUIStore.setState({
      centerTabs: [
        { id: 'terminal-t1', type: 'terminal', title: 't', data: { terminalId: 't1' } },
      ],
      activeCenterTabId: 'terminal-t1',
    })
    const container = await renderSection()

    await middleClick(container, 't1')

    expect(mocks.getTerminalForeground).toHaveBeenCalledWith('t1')
    expect(mocks.close).toHaveBeenCalledWith('t1')
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(useUIStore.getState().centerTabs.find((tab) => tab.id === 'terminal-t1')).toBeUndefined()
  })

  it('в терминале идёт команда → терминал не закрывается, тост-предупреждение', async () => {
    withTerminal()
    mocks.getTerminalForeground.mockResolvedValue({ isShell: false, command: 'npm' })
    const container = await renderSection()

    await middleClick(container, 't1')

    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'The terminal is running "npm"', type: 'warning' }),
    )
  })

  it('факт неизвестен (null) → подтверждение человека, без согласия терминал жив', async () => {
    withTerminal()
    mocks.getTerminalForeground.mockResolvedValue(null)
    mocks.confirm.mockResolvedValue(false)
    const container = await renderSection()

    await middleClick(container, 't1')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('факт неизвестен (null) и согласие → терминал закрывается', async () => {
    withTerminal()
    mocks.getTerminalForeground.mockResolvedValue(null)
    const container = await renderSection()

    await middleClick(container, 't1')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledWith('t1')
  })

  it('ошибка пробы переднего плана → подтверждение человека', async () => {
    withTerminal()
    mocks.getTerminalForeground.mockRejectedValue(new Error('нет связи'))
    const container = await renderSection()

    await middleClick(container, 't1')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
  })

  it('завершённый терминал закрывается сразу — без пробы и подтверждения', async () => {
    withTerminal('t-exited', { status: 'exited' })
    const container = await renderSection()

    await middleClick(container, 't-exited')

    expect(mocks.getTerminalForeground).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledWith('t-exited')
  })

  it('средняя кнопка не запускает автоскролл (mousedown отменён)', async () => {
    withTerminal()
    const container = await renderSection()
    const card = container.querySelector('[data-testid="terminals-item-t1"]') as HTMLElement

    const event = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })
    await act(async () => {
      card.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
  })
})
