/**
 * `TerminalAskDock` — док «Спросить агента» над терминалом (PROP-132, Ф4б).
 *
 * Инварианты:
 * - после отправки док **не закрывается** — он показывает, идёт ли ход агента
 *   («агент работает…» → «готово»), и закрывается только явно;
 * - поле вопроса очищается после отправки;
 * - пока док открыт, сессия не накапливает непрочитанные (`suppressUnread`),
 *   при закрытии подавление снимается.
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
  sendMessage: vi.fn(),
  notify: vi.fn(),
  suppressUnread: vi.fn(),
  clearSessionUnread: vi.fn(),
  isUnreadSuppressed: vi.fn(() => false),
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

// Отправка вопроса — обычное сообщение в сессию (транспорт перехватываем).
vi.mock('@/stores/transportStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/transportStore')>()
  const real = actual.useTransportStore
  const mocked = Object.assign(
    (selector?: (state: unknown) => unknown) =>
      typeof selector === 'function' ? selector(real.getState()) : real.getState(),
    {
      ...real,
      getState: () => ({ ...real.getState(), sendMessage: mocks.sendMessage }),
    },
  )
  return { ...actual, useTransportStore: mocked }
})

// Подавление непрочитанных — фиксируем вызовы (в сторе состояние заменяется
// на новый объект, поэтому.spy на методе не переживает первый set).
vi.mock('@/stores/notificationStore', () => {
  const state = {
    suppressedUnread: {} as Record<string, boolean>,
    sessionUnread: {} as Record<string, number>,
    suppressUnread: mocks.suppressUnread,
    clearSessionUnread: mocks.clearSessionUnread,
    isUnreadSuppressed: mocks.isUnreadSuppressed,
  }
  mocks.suppressUnread.mockImplementation((sessionId: string, suppressed: boolean) => {
    if (suppressed) state.suppressedUnread[sessionId] = true
    else delete state.suppressedUnread[sessionId]
  })
  return {
    useNotificationStore: {
      getState: () => state,
      setState: () => {},
      subscribe: () => () => {},
    },
  }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { resetChatStore } from '@/stores/testUtils'
import type { TerminalDto } from '@/lib/api/terminals'
import { TerminalAskDock } from './TerminalAskDock'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION = 's1'
const PROJECT = 'p1'

const TERMINAL: TerminalDto = {
  id: 't1',
  projectId: PROJECT,
  sessionId: SESSION,
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
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

/**
 * Хост как в `TerminalView`: док живёт, пока его не закрыли явно
 * (`onClose` → размонтирование).
 */
function DockHost({ onClose }: { onClose: () => void }): React.ReactElement {
  const [open, setOpen] = React.useState(true)
  if (!open) return <div data-testid="dock-closed" />
  return (
    <TerminalAskDock
      terminal={TERMINAL}
      lines={['последняя строка вывода']}
      mode="ask"
      onClose={() => {
        onClose()
        setOpen(false)
      }}
    />
  )
}

async function renderDock(
  onClose: () => void = () => {},
): Promise<{ container: HTMLElement; onClose: () => void }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <DockHost onClose={onClose} />
      </I18nProvider>,
    )
  })
  await flush()
  return { container, onClose }
}

/** Вводит текст в контролируемое поле (React видит `onChange`). */
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  mocks.sendMessage.mockResolvedValue({ messageId: 'm1' })
  useSessionsStore.setState({
    sessions: [
      {
        id: SESSION,
        name: 'Сессия 1',
        project_id: PROJECT,
        user_id: null,
        owner_id: null,
      },
    ],
  } as never)
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

describe('TerminalAskDock — отправка вопроса', () => {
  it('после отправки док остаётся открытым, поле очищено, индикатор «агент работает…»', async () => {
    const onClose = vi.fn()
    const { container } = await renderDock(onClose)

    const textarea = byTestId(container, 'terminal-ask-input') as HTMLTextAreaElement
    await typeInto(textarea, 'что здесь происходит?')

    const send = byTestId(container, 'terminal-ask-send') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    await flush()

    // Вопрос ушёл в сессию вместе с блоком контекста.
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    const [target, message] = mocks.sendMessage.mock.calls[0] as [string, string]
    expect(target).toBe(SESSION)
    expect(message).toContain('что здесь происходит?')
    expect(message).toContain('<terminal_context terminal="t1"')
    expect(message).toContain('последняя строка вывода')

    // Док **не** закрылся, поле очищено.
    expect(onClose).not.toHaveBeenCalled()
    expect(byTestId(container, 'terminal-ask-dock')).not.toBeNull()
    expect((byTestId(container, 'terminal-ask-input') as HTMLTextAreaElement).value).toBe('')

    // Индикатор работы агента.
    const status = byTestId(container, 'terminal-ask-status')
    expect(status?.getAttribute('data-phase')).toBe('working')
    expect(status?.textContent).toContain('the agent is working…')
  })

  it('ход агента завершился — индикатор «готово»', async () => {
    const { container } = await renderDock()

    const textarea = byTestId(container, 'terminal-ask-input') as HTMLTextAreaElement
    await typeInto(textarea, 'вопрос')
    await act(async () => {
      ;(byTestId(container, 'terminal-ask-send') as HTMLButtonElement).click()
    })
    await flush()

    // Ход идёт — индикатор «агент работает…».
    await act(async () => {
      useChatStore.setState({
        turnBySession: { [SESSION]: { turnId: 'turn-1', status: 'streaming' } },
      })
    })
    await flush()
    expect(byTestId(container, 'terminal-ask-status')?.getAttribute('data-phase')).toBe('working')

    // Ход завершён — индикатор «готово».
    await act(async () => {
      useChatStore.setState({
        turnBySession: { [SESSION]: { turnId: 'turn-1', status: 'completed' } },
      })
    })
    await flush()

    const status = byTestId(container, 'terminal-ask-status')
    expect(status?.getAttribute('data-phase')).toBe('done')
    expect(status?.textContent).toContain('done')
  })

  it('ошибка отправки — док остаётся, показывается уведомление об ошибке', async () => {
    mocks.sendMessage.mockRejectedValue(new Error('соединение потеряно'))
    const onClose = vi.fn()
    const { container } = await renderDock(onClose)

    const textarea = byTestId(container, 'terminal-ask-input') as HTMLTextAreaElement
    await typeInto(textarea, 'вопрос')
    await act(async () => {
      ;(byTestId(container, 'terminal-ask-send') as HTMLButtonElement).click()
    })
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    expect(byTestId(container, 'terminal-ask-dock')).not.toBeNull()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text: 'Could not send: соединение потеряно' }),
    )
  })
})

describe('TerminalAskDock — подавление непрочитанных', () => {
  it('при открытии подавление включается, при закрытии — снимается', async () => {
    const { container } = await renderDock()

    expect(mocks.suppressUnread).toHaveBeenCalledWith(SESSION, true)
    expect(mocks.clearSessionUnread).toHaveBeenCalledWith(SESSION)

    // Закрытие дока (крестик) — док размонтируется, подавление снимется.
    await act(async () => {
      ;(byTestId(container, 'terminal-ask-close') as HTMLButtonElement).click()
    })
    await flush()

    expect(byTestId(container, 'dock-closed')).not.toBeNull()
    expect(mocks.suppressUnread).toHaveBeenCalledWith(SESSION, false)
  })
})
