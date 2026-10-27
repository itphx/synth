import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  backgroundSession: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notifyMessage,
  useNotification: () => ({ notify: vi.fn() }),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    backgroundSession: mocks.backgroundSession,
    resumeSubagent: vi.fn(),
    stopGeneration: vi.fn(),
  },
}))

// useUIStore использует zustand persist (localStorage в jsdom-среде тестов
// недоступен в момент импорта модуля) — подменяем лёгким стабом вкладок.
vi.mock('@/stores/useUIStore', () => {
  const state = {
    centerTabs: [{ id: 'chat-parent', type: 'chat', title: 'Родитель', data: { sessionId: 'parent' } }],
    activeCenterTabId: 'chat-parent',
    openTab: vi.fn(),
  }
  const useUIStore = ((selector: (s: typeof state) => unknown) => selector(state)) as {
    (selector: (s: typeof state) => unknown): unknown
    getState: () => typeof state
    setState: (patch: Partial<typeof state>) => void
  }
  useUIStore.getState = () => state
  useUIStore.setState = (patch: Partial<typeof state>) => Object.assign(state, patch)
  return { useUIStore }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { SubagentPart, type SubagentPartData } from './SubagentPart'
import { useChatStore, type StreamState } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeSubagent(partial: Partial<SubagentPartData>): SubagentPartData {
  return {
    name: 'researcher',
    sessionId: 'child-1234',
    callId: 'call-1',
    ...partial,
  }
}

function runningStream(): StreamState {
  return {
    streamId: 'st1',
    agentRole: 'developer',
    content: '',
    reasoningBlocks: [],
    intermediateTextBlocks: [],
    isStreaming: true,
    hasContent: true,
    toolCalls: [
      {
        callId: 'call-1',
        name: 'task',
        args: {},
        status: 'running',
        startedAt: '2026-10-27T00:00:00.000Z',
        iteration: 0,
      },
    ],
    toolIteration: 0,
    _lastContentLen: 0,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderSubagent(data: SubagentPartData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SubagentPart subagent={data} />
      </I18nProvider>,
    )
  })
  return container
}

function findBackgroundButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'В фон',
  ) as HTMLButtonElement | undefined
}

/** Тексты показанных тостов (мок `notifyMessage`). */
function notificationTexts(): string[] {
  return mocks.notifyMessage.mock.calls.map(
    (call) => (call[0] as { text: string }).text,
  )
}

beforeAll(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStore()
  useChatStore.setState({
    streamingBySession: { parent: { st1: runningStream() } },
  })
  mocks.backgroundSession.mockResolvedValue({
    sessionId: 'parent',
    detached: [{ id: 'child-1234', kind: 'subagent', title: 'researcher' }],
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

describe('SubagentPart — кнопка «В фон» (ADR-111 §detach)', () => {
  it('running-прогон: кнопка есть', async () => {
    const container = await renderSubagent(makeSubagent({ running: true }))
    expect(findBackgroundButton(container)).toBeDefined()
  })

  it('завершённый (running не выставлен) — кнопки нет', async () => {
    const container = await renderSubagent(makeSubagent({}))
    expect(findBackgroundButton(container)).toBeUndefined()
  })

  it('ошибка прогона (running=false) — кнопки нет', async () => {
    const container = await renderSubagent(makeSubagent({ running: false }))
    expect(findBackgroundButton(container)).toBeUndefined()
  })

  it('клик → backgroundSession(сессия-владелец, {type:"subagent"}), парт снят из хода', async () => {
    const container = await renderSubagent(makeSubagent({ running: true }))
    const button = findBackgroundButton(container)!

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.backgroundSession).toHaveBeenCalledTimes(1)
    expect(mocks.backgroundSession).toHaveBeenCalledWith('parent', { type: 'subagent' })
    expect(useChatStore.getState().streamingBySession.parent!.st1!.toolCalls).toHaveLength(0)
    expect(notificationTexts().some((text) => text.includes('Переведено в фон: 1'))).toBe(true)
    // Кнопка исчезает: повторный клик невозможен.
    expect(findBackgroundButton(container)).toBeUndefined()
  })

  it('во время запроса кнопка disabled, второй клик не дублирует вызов', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    mocks.backgroundSession.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve
    }))
    const container = await renderSubagent(makeSubagent({ running: true }))
    const button = findBackgroundButton(container)!

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button.disabled).toBe(true)

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.backgroundSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest({ sessionId: 'parent', detached: [{ id: 'child-1234', kind: 'subagent' }] })
    })
  })

  it('ошибка API → тост с ошибкой, кнопка снова доступна', async () => {
    mocks.backgroundSession.mockRejectedValue(new Error('detach unsupported'))
    const container = await renderSubagent(makeSubagent({ running: true }))

    await act(async () => {
      findBackgroundButton(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(notificationTexts().some((text) => text.includes('Не удалось перевести в фон: detach unsupported'))).toBe(true)
    expect(findBackgroundButton(container)!.disabled).toBe(false)
  })

  it('клик по «В фон» не переключает expanded', async () => {
    const container = await renderSubagent(makeSubagent({ running: true }))
    const header = container.querySelector('[role="button"][aria-expanded]') as HTMLElement
    expect(header.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      findBackgroundButton(container)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(header.getAttribute('aria-expanded')).toBe('false')
  })
})
