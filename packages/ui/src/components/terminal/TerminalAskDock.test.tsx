/**
 * `TerminalAskDock` — док «Спросить агента» над терминалом (PROP-132, Ф4б).
 *
 * Инварианты:
 * - док — на **общем композере** сессии (`SessionComposer`): поле ввода,
 *   «Стоп», очередь и «В разрыв» приходят оттуда, второй копии очереди нет;
 * - док — **часть панели терминала**: ни шапки (крестик/статус), ни рамки
 *   карточки; ни строки контекста, ни кнопки вложений — только выбор
 *   сессии и само поле ввода;
 * - отправка уходит обычным сообщением в целевую сессию; вывод терминала
 *   уходит **отдельным** полем `context` (вопрос остаётся чистым, без
 *   `<terminal_context>`);
 * - после отправки док **не закрывается**; закрывается явно (Esc);
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
  notify: vi.fn(),
  suppressUnread: vi.fn(),
  clearSessionUnread: vi.fn(),
  isUnreadSuppressed: vi.fn(() => false),
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

// Подавление непрочитанных — фиксируем вызовы (в сторе состояние заменяется
// на новый объект, поэтому .spy на методе не переживает первый set).
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

// Композер сессии (общий с чатом) — моки как в `SessionComposer.test.tsx`.
vi.mock('@/lib/api/synthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/synthApi')>()
  return {
    ...actual,
    synthApi: {
      ...actual.synthApi,
      enqueueMessage: vi.fn(),
      getSession: vi.fn(),
      getAgents: vi.fn(),
      returnQueue: vi.fn(),
      steerQueue: vi.fn(),
      clearQueue: vi.fn(),
      resumeQueue: vi.fn(),
      reorderQueue: vi.fn(),
      addStickyNote: vi.fn(),
    },
  }
})

vi.mock('@/hooks/useDevice', () => ({
  useDevice: () => ({ isTouch: false, deviceType: 'desktop' }),
}))
vi.mock('@/components/ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }))
vi.mock('@/components/chat/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('@/components/chat/AgentModeSelector', () => ({ AgentModeSelector: () => null }))
vi.mock('@/components/chat/PlanActModeToggle', () => ({ PlanActModeToggle: () => null }))
vi.mock('@/components/chat/ReasoningLevelSelector', () => ({ ReasoningLevelSelector: () => null }))

if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {}
}
if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { useChatStore } from '@/stores/chatStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'
import { resetChatStore } from '@/stores/testUtils'
import { synthApi } from '@/lib/api/synthApi'
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

async function flush(times = 4): Promise<void> {
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
function DockHost({
  onClose,
  terminal = TERMINAL,
}: {
  onClose: () => void
  terminal?: TerminalDto
}): React.ReactElement {
  const [open, setOpen] = React.useState(true)
  if (!open) return <div data-testid="dock-closed" />
  return (
    <TerminalAskDock
      terminal={terminal}
      lines={['последняя строка вывода']}
      onClose={() => {
        onClose()
        setOpen(false)
      }}
    />
  )
}

async function renderDock(
  onClose: () => void = () => {},
  terminal: TerminalDto = TERMINAL,
): Promise<{ container: HTMLElement; onClose: () => void }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <DockHost onClose={onClose} terminal={terminal} />
      </I18nProvider>,
    )
  })
  await flush()
  return { container, onClose }
}

/** Вводит текст в композер (React видит `onChange`). */
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Кнопка отправки композера (`ChatInput`). */
function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.getAttribute('title') === enDict['chat.input.send'],
  ) as HTMLButtonElement | undefined
  expect(button, 'кнопка отправки композера').toBeTruthy()
  return button!
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  vi.mocked(synthApi.enqueueMessage).mockResolvedValue({
    messageId: 'm1',
    mode: 'queue',
    position: 1,
  } as never)
  vi.mocked(synthApi.getSession).mockResolvedValue({
    id: SESSION,
    pending_messages: [],
  } as never)
  vi.mocked(synthApi.getAgents).mockResolvedValue({ agents: [], default_agent: null } as never)
  vi.mocked(synthApi.steerQueue).mockResolvedValue({ steered: true, pending_count: 0 } as never)
  vi.mocked(synthApi.returnQueue).mockResolvedValue({ texts: ['x'] } as never)
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

describe('TerminalAskDock — общий композер сессии', () => {
  it('док рендерит композер: поле ввода и кнопка отправки (своей кнопки нет)', async () => {
    const { container } = await renderDock()

    expect(byTestId(container, 'terminal-ask-dock')).not.toBeNull()
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(sendButton(container)).toBeTruthy()
    // Кнопка «Отправить» из дока убрана — отправка через композер.
    expect(byTestId(container, 'terminal-ask-send')).toBeNull()
    // Строки контекста («N строк · каталог · оболочка») в доке нет:
    // вывод терминала уходит отдельным полем `context`.
    expect(byTestId(container, 'terminal-ask-context')).toBeNull()
    expect(container.textContent).not.toContain('/workspace/demo')
    expect(container.textContent).not.toContain('/bin/bash')
  })

  it('в доке нет кнопки вложений — вложения прикрепляются в чате', async () => {
    const { container } = await renderDock()

    // Кнопка «Прикрепить файл» (`AttachmentButton`) и её скрытый input.
    expect(byTestId(container, 'attachment-input')).toBeNull()
    expect(
      container.querySelector(`button[title="${enDict['chat.attachments.attach']}"]`),
    ).toBeNull()
  })

  it('док без шапки и рамки: нет крестика, статуса и кнопки разворота', async () => {
    const { container } = await renderDock()

    // Шапки нет: ни крестика, ни индикатора хода.
    expect(byTestId(container, 'terminal-ask-close')).toBeNull()
    expect(byTestId(container, 'terminal-ask-status')).toBeNull()
    // Карточки нет: у корня нет рамки/тени/скругления.
    const dock = byTestId(container, 'terminal-ask-dock') as HTMLElement
    expect(dock.className).not.toContain('border')
    expect(dock.className).not.toContain('shadow')
    expect(dock.className).not.toContain('rounded')
    // «Развернуть» в доке нечего — кнопки нет (в чате она есть).
    expect(container.querySelector(`button[title="${enDict['chat.footer.expand']}"]`)).toBeNull()
  })

  it('отправка: вопрос уходит чистым, вывод терминала — отдельным context', async () => {
    const { container } = await renderDock()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, 'что здесь происходит?')
    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    expect(synthApi.enqueueMessage).toHaveBeenCalledTimes(1)
    const [target, message, options] = vi.mocked(synthApi.enqueueMessage).mock.calls[0] as [
      string,
      string,
      { context?: Record<string, unknown> },
    ]
    expect(target).toBe(SESSION)
    // Текст вопроса чистый — блока `<terminal_context>` в нём нет.
    expect(message).toBe('что здесь происходит?')
    expect(message).not.toContain('<terminal_context')
    // Вывод терминала ушёл отдельным полем `context`.
    expect(options.context).toEqual({
      terminal_id: 't1',
      content: 'последняя строка вывода',
      cwd: '/workspace/demo',
      shell: '/bin/bash',
      status: 'running',
      lines: 1,
      truncated: false,
    })
  })

  it('после отправки док остаётся открытым, текст очищен', async () => {
    const onClose = vi.fn()
    const { container } = await renderDock(onClose)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, 'вопрос')
    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    expect(byTestId(container, 'terminal-ask-dock')).not.toBeNull()
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
  })

  it('ход агента идёт — композер переключается на «в очередь»', async () => {
    const { container } = await renderDock()

    await act(async () => {
      useChatStore.setState({
        turnBySession: { [SESSION]: { turnId: 'turn-1', status: 'streaming' } },
      })
    })
    await flush()

    // Кнопка отправки в развёрнутом ходе — «Добавить в очередь».
    const enqueue = Array.from(container.querySelectorAll('button')).find(
      (el) => el.getAttribute('title') === enDict['chat.input.enqueue'],
    )
    expect(enqueue).toBeTruthy()
  })

  it('ошибка отправки — док остаётся, показывается уведомление об ошибке', async () => {
    vi.mocked(synthApi.enqueueMessage).mockRejectedValueOnce(new Error('соединение потеряно'))
    const onClose = vi.fn()
    const { container } = await renderDock(onClose)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(textarea, 'вопрос')
    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    expect(byTestId(container, 'terminal-ask-dock')).not.toBeNull()
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text: expect.stringContaining('соединение потеряно') }),
    )
  })

  it('очередь сессии доступна в доке: «Вклинить» уходит в разрыв хода', async () => {
    act(() => {
      useChatStore.getState().setPendingMessages(SESSION, [{ id: 'msg-1', content: 'в очереди' }])
      useChatStore.getState().updateQueueCount(SESSION, 1)
      // Активный ход — «Вклинить» доступно (ADR-118 §1).
      useChatStore.setState({
        turnBySession: { [SESSION]: { turnId: 'turn-1', status: 'streaming' } },
      })
    })
    const { container } = await renderDock()

    // Панель очереди — общая с чатом.
    expect(byTestId(container, 'queue-header-toggle')).not.toBeNull()

    const toggle = byTestId(container, 'queue-header-toggle') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await flush(2)

    const steer = byTestId(container, 'queue-steer-0') as HTMLButtonElement | null
    expect(steer).not.toBeNull()
    await act(async () => {
      steer!.click()
    })
    await flush()

    expect(synthApi.steerQueue).toHaveBeenCalledWith(SESSION, { id: 'msg-1' })
  })
})

describe('TerminalAskDock — закрытие', () => {
  it('Esc закрывает док', async () => {
    const onClose = vi.fn()
    await renderDock(onClose)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    expect(onClose).toHaveBeenCalled()
  })
})

describe('TerminalAskDock — подавление непрочитанных', () => {
  it('при открытии подавление включается, при закрытии — снимается', async () => {
    const { container } = await renderDock()

    expect(mocks.suppressUnread).toHaveBeenCalledWith(SESSION, true)
    expect(mocks.clearSessionUnread).toHaveBeenCalledWith(SESSION)

    // Закрытие дока (Esc) — док размонтируется, подавление снимется.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    expect(byTestId(container, 'dock-closed')).not.toBeNull()
    expect(mocks.suppressUnread).toHaveBeenCalledWith(SESSION, false)
  })
})

describe('TerminalAskDock — режима «прикрепить вывод» больше нет', () => {
  it('ни кнопки прикрепления, ни режима attach в доке нет', async () => {
    const { container } = await renderDock()

    expect(byTestId(container, 'terminal-attach-confirm')).toBeNull()
    // Док — только про композер: выбора режима нет.
    expect(container.querySelector('textarea')).toBeTruthy()
  })
})
