/**
 * Фоновая карточка саб-агента (`task` с `background: true`) — ADR-111.
 *
 * Репорт: у фонового саб-агента карточка показывала только PROMPT — ни шагов
 * («N шагов»), ни вложенных карточек вызовов. Причина: у фонового прогона в
 * `result.metadata` нет ни `tool_calls`, ни `steps` (тул вернул управление
 * сразу, публикация в родительский стрим отключена) — шаги лежат в истории
 * дочерней сессии.
 *
 * Проверяем: карточка догружает историю ребёнка и показывает шаги; ошибка
 * загрузки даёт пометку с повтором; терминальный статус прогона перечитывает
 * историю; синхронная карточка не меняется.
 *
 * Фикстуры — по форме реального DTO (`packages/core/src/server/serialize.ts`):
 * результат вызова `task` в родительской сессии лежит в `message.tool_calls`
 * (ядро берёт его из `metadata.tool_results`), шаги ребёнка — в истории его
 * сессии (`metadata.tool_results` финального сообщения ребёнка → DTO
 * `tool_calls`).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = () => {}
  }
})

const mocks = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  resumeSubagent: vi.fn().mockResolvedValue({ status: 'started' }),
  stopGeneration: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSessionMessages: mocks.getSessionMessages,
    resumeSubagent: mocks.resumeSubagent,
    stopGeneration: mocks.stopGeneration,
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import { useChatStore, type LivePart, type MessageData } from '@/stores/chatStore'
import { useSubagentRunsStore } from '@/stores/subagentRunsStore'
import { useProcessesStore } from '@/stores/processesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const MESSAGE = 'm1'
const CHILD = 'child-1'

type ToolCallDto = NonNullable<MessageData['tool_calls']>[number]

/**
 * Вызов `task` с `background: true` — результат без шагов (фоновый тул вернул
 * управление сразу: в `metadata` только id дочерней сессии и статус прогона).
 */
function backgroundTaskCall(): ToolCallDto {
  return {
    id: 'call_task',
    name: 'task',
    args: { prompt: 'PROMPT-BG', subagent_type: 'general', background: true },
    result: {
      content: 'started',
      metadata: {
        child_session_id: CHILD,
        status: 'running',
        background_run_id: 'bgr_1',
      },
    },
    iteration: 0,
  }
}

/** Вызов `task` синхронного сабагента — шаги в `result.metadata`. */
function syncTaskCall(): ToolCallDto {
  return {
    id: 'call_task',
    name: 'task',
    args: { prompt: 'PROMPT-SYNC', subagent_type: 'general' },
    result: {
      content: 'ok',
      metadata: {
        subagent_type: 'general',
        child_session_id: CHILD,
        steps: 2,
        tool_calls: [
          {
            name: 'execute_shell',
            args: { command: 'ls' },
            id: 'call-sync-1',
            result: { content: 'ok', isError: false },
            iteration: 0,
          },
        ],
      },
    },
    iteration: 0,
  }
}

/** Живая часть `tool_use` с результатом фонового вызова (`task`). */
function backgroundTaskPart(): LivePart {
  return {
    id: 'call_task',
    type: 'tool_use',
    text: '',
    data: {
      name: 'task',
      args: { prompt: 'PROMPT-BG', subagent_type: 'general', background: true },
      status: 'done',
      startedAt: '2026-10-31T00:00:01Z',
      completedAt: '2026-10-31T00:00:02Z',
      iteration: 0,
      result: {
        content: 'started',
        metadata: {
          child_session_id: CHILD,
          status: 'running',
          background_run_id: 'bgr_1',
        },
      },
    },
  }
}

/** История дочерней сессии: финальное сообщение с вызовами ребёнка. */
function childHistory() {
  return {
    messages: [
      {
        index: 0,
        id: 'm-child',
        role: 'assistant',
        content: 'ИТОГ РЕБЁНКА',
        disabled: false,
        pinned: false,
        hidden: false,
        created_at: '2026-10-31T00:00:09Z',
        tool_calls: [
          {
            name: 'execute_shell',
            args: { command: 'ls' },
            id: 'call-child-1',
            result: { content: 'ok', isError: false },
            iteration: 0,
          },
          {
            name: 'read_file',
            args: { path: 'a.ts' },
            id: 'call-child-2',
            result: { content: 'код', isError: false },
            iteration: 1,
          },
        ],
        metadata: { status: 'completed' },
      },
    ],
    session_id: CHILD,
  }
}

/** История ребёнка, пока прогон идёт: шагов ещё нет. */
function childHistoryWithoutSteps() {
  return { messages: [], session_id: CHILD }
}

function msg(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    id: MESSAGE,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-31T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatMessage
          message={message}
          sessionId={SESSION}
          onCopy={() => {}}
          onToggle={() => {}}
          onPin={() => {}}
          onDelete={() => {}}
          onRetry={() => {}}
          onDebug={() => {}}
          onFork={() => {}}
        />
      </I18nProvider>,
    )
  })
  return container
}

/** Раскрыть карточку саб-агента (клик по шапке). */
async function expandSubagent(container: HTMLElement): Promise<void> {
  const header = container.querySelector('[aria-expanded]') as HTMLElement
  expect(header).not.toBeNull()
  await act(async () => {
    header.click()
  })
}

/** Дождаться разрешения промиса загрузки истории ребёнка. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  useChatStore.setState({ partsBySession: {}, turnBySession: {} })
  useSubagentRunsStore.getState().clear()
  useProcessesStore.setState({ byId: {}, order: [], logs: {}, pendingIds: [], error: null })
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

describe('ChatMessage: фоновая карточка саб-агента', () => {
  it('свёрнутая карточка не грузит историю ребёнка', async () => {
    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [backgroundTaskCall()] }),
    )

    expect(container.textContent).toContain('Subagent: general')
    // Загрузка ленивая — до раскрытия карточки запроса нет.
    expect(mocks.getSessionMessages).not.toHaveBeenCalled()
  })

  it('без загруженных шагов показывает только PROMPT', async () => {
    mocks.getSessionMessages.mockResolvedValue(childHistoryWithoutSteps())

    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [backgroundTaskCall()] }),
    )
    await expandSubagent(container)
    await flush()

    expect(mocks.getSessionMessages).toHaveBeenCalledWith(CHILD)
    expect(container.textContent).toContain('PROMPT-BG')
    // Шагов ещё нет — бейджа нет.
    expect(container.textContent).not.toContain('steps')
    expect(container.querySelectorAll('[data-tool-call-toggle]')).toHaveLength(0)
  })

  it('после загрузки истории ребёнка показывает бейдж шагов и карточки вызовов', async () => {
    mocks.getSessionMessages.mockResolvedValue(childHistory())

    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [backgroundTaskCall()] }),
    )
    await expandSubagent(container)
    await flush()

    expect(mocks.getSessionMessages).toHaveBeenCalledWith(CHILD)
    // Бейдж «N шагов».
    expect(container.textContent).toContain('2 steps')
    // Вложенные карточки вызовов ребёнка.
    expect(container.textContent).toContain('Shell')
    expect(container.textContent).toContain('Read')
    expect(container.querySelectorAll('[data-tool-call-toggle]').length).toBeGreaterThan(0)
  })

  it('ошибка загрузки даёт пометку и кнопку повтора', async () => {
    mocks.getSessionMessages.mockRejectedValue(new Error('boom'))

    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [backgroundTaskCall()] }),
    )
    await expandSubagent(container)
    await flush()

    expect(container.textContent).toContain('Failed to load steps')
    const retry = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry',
    )
    expect(retry).toBeDefined()

    // Повтор — новая попытка загрузки.
    mocks.getSessionMessages.mockResolvedValue(childHistory())
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('2 steps')
  })

  it('терминальный статус прогона перечитывает историю ребёнка', async () => {
    mocks.getSessionMessages.mockResolvedValue(childHistory())

    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [backgroundTaskCall()] }),
    )
    await expandSubagent(container)
    await flush()
    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(1)

    // Прогон завершился — реестр фоновых прогонов знает терминальный статус.
    useProcessesStore.setState({
      byId: {
        bgr_1: {
          id: 'bgr_1',
          kind: 'subagent',
          status: 'running',
          sessionId: SESSION,
          childSessionId: CHILD,
          startedAt: '2026-10-31T00:00:01Z',
          updatedAt: '2026-10-31T00:00:02Z',
        },
      },
      order: ['bgr_1'],
      logs: {},
      pendingIds: [],
      error: null,
    })
    await flush()

    useProcessesStore.setState({
      byId: {
        bgr_1: {
          id: 'bgr_1',
          kind: 'subagent',
          status: 'completed',
          sessionId: SESSION,
          childSessionId: CHILD,
          startedAt: '2026-10-31T00:00:01Z',
          updatedAt: '2026-10-31T00:00:10Z',
          finishedAt: '2026-10-31T00:00:10Z',
        },
      },
      order: ['bgr_1'],
      logs: {},
      pendingIds: [],
      error: null,
    })
    await flush()

    expect(mocks.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('2 steps')
  })

  it('живой вызов в идущем ходе даёт ту же фоновую карточку', async () => {
    mocks.getSessionMessages.mockResolvedValue(childHistory())

    useChatStore.setState({
      partsBySession: {
        [SESSION]: { [MESSAGE]: { call_task: backgroundTaskPart() } },
      },
    })

    const container = await renderChat(msg({ status: 'streaming' }))
    await expandSubagent(container)
    await flush()

    expect(container.textContent).toContain('Subagent: general')
    expect(container.textContent).toContain('PROMPT-BG')
    expect(mocks.getSessionMessages).toHaveBeenCalledWith(CHILD)
    expect(container.textContent).toContain('2 steps')
    expect(container.textContent).toContain('Shell')
  })

  it('синхронная карточка не меняется — шаги из result.metadata', async () => {
    const container = await renderChat(
      msg({ status: 'completed', tool_calls: [syncTaskCall()] }),
    )
    await expandSubagent(container)
    await flush()

    // История ребёнка не грузится — у синхронного прогона шаги уже в метаданных.
    expect(mocks.getSessionMessages).not.toHaveBeenCalled()
    expect(container.textContent).toContain('PROMPT-SYNC')
    expect(container.textContent).toContain('2 steps')
    expect(container.textContent).toContain('Shell')
  })
})
