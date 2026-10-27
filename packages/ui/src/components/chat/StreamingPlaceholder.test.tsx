import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  backgroundSession: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { backgroundSession: mocks.backgroundSession },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
  useNotification: () => ({ notify: vi.fn() }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { StreamingPlaceholder } from './StreamingPlaceholder'
import { type StreamState, type LiveToolCall } from '@/stores/chatStore'
import { resetChatStore } from '@/stores/testUtils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function makeStream(partial: Partial<StreamState> = {}): StreamState {
  return {
    streamId: 'st1',
    agentRole: null,
    content: '',
    reasoningBlocks: [],
    intermediateTextBlocks: [],
    isStreaming: true,
    hasContent: false,
    toolCalls: [],
    toolIteration: 0,
    _lastContentLen: 0,
    ...partial,
  }
}

async function renderPlaceholder(
  stream: StreamState,
  locale: 'en' | 'ru' = 'en',
  sessionId?: string,
): Promise<HTMLElement> {
  useI18nStore.setState({
    locale,
    dictionary: locale === 'ru' ? ruDict : enDict,
    loadingLocale: null,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StreamingPlaceholder stream={stream} sessionId={sessionId} onStop={() => {}} />
      </I18nProvider>,
    )
  })
  return container
}

/** Кнопка статистики в футере, открывает поповер (контент — в portal `body`). */
async function openStats(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector('button[title="Response stats"]')
  expect(trigger).not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const popup = document.querySelector('[data-testid="stream-live-stats"]')
  expect(popup).not.toBeNull()
  return popup as HTMLElement
}

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

describe('StreamingPlaceholder — live-статистика (ADR-070 §2.6)', () => {
  it('инлайн-строки нет, кнопка статистики открывает поповер: токены, стоимость, % кэша', async () => {
    const container = await renderPlaceholder(makeStream({
      usage: {
        input_tokens: 1_700_000,
        output_tokens: 33_300,
        total_tokens: 1_733_300,
        cache_read_tokens: 1_581_000,
      },
      costUsd: 0.03,
      usageEstimated: false,
    }))

    // До открытия статистика инлайном не рендерится.
    expect(container.querySelector('[data-testid="stream-live-stats"]')).toBeNull()

    const el = await openStats(container)
    const text = el.textContent ?? ''
    expect(text).toContain('1.7M in')
    expect(text).toContain('33.3k out')
    expect(text).toContain('~ 0.03 $')
    expect(text).toContain('93% cache')
    // Сегменты разделены `·`.
    expect(el.querySelectorAll('[aria-hidden="true"]').length).toBe(3)
  })

  it('usageEstimated → префикс ~ у токенов', async () => {
    const container = await renderPlaceholder(makeStream({
      usage: { input_tokens: 8800, output_tokens: 1200, total_tokens: 10_000 },
      usageEstimated: true,
    }))

    const el = await openStats(container)
    const text = el.textContent ?? ''
    expect(text).toContain('~8.8k in')
    expect(text).toContain('~1.2k out')
  })

  it('без usage/cost кнопки статистики нет', async () => {
    const container = await renderPlaceholder(makeStream())
    expect(container.querySelector('button[title="Response stats"]')).toBeNull()
    expect(document.querySelector('[data-testid="stream-live-stats"]')).toBeNull()
  })

  it('ru-локаль: подписи локализованы', async () => {
    const container = await renderPlaceholder(
      makeStream({
        usage: { input_tokens: 1500, output_tokens: 300, total_tokens: 1800, cache_read_tokens: 750 },
        costUsd: 0.01,
      }),
      'ru',
    )

    const trigger = container.querySelector('button[title="Статистика ответа"]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const el = document.querySelector('[data-testid="stream-live-stats"]')
    expect(el).not.toBeNull()
    const text = el!.textContent ?? ''
    expect(text).toContain('1.5k вх')
    expect(text).toContain('300 исх')
    expect(text).toContain('~ 0.01 $')
    expect(text).toContain('50% кэш')
  })

  it('C2b: стоимость live-статистики — в валюте costCurrency', async () => {
    const container = await renderPlaceholder(makeStream({
      usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
      costUsd: 0.05,
      costCurrency: 'RUB',
    }))

    const el = await openStats(container)
    const text = el.textContent ?? ''
    expect(text).toContain('~ 0.05 ₽')
    expect(text).not.toContain('~ 0.05 $')
  })
})

/** Live-тул-вызов для строки активности хода. */
function makeLiveCall(partial: Partial<LiveToolCall>): LiveToolCall {
  return {
    callId: 'call-1',
    name: 'task',
    args: {},
    status: 'running',
    startedAt: '2026-10-27T00:00:00.000Z',
    iteration: 0,
    ...partial,
  }
}

describe('StreamingPlaceholder — «В фон» (ADR-111 §detach)', () => {
  beforeEach(() => {
    mocks.backgroundSession.mockReset()
    mocks.backgroundSession.mockResolvedValue({
      sessionId: 's1',
      detached: [{ id: 'child-1', kind: 'subagent' }],
    })
    resetChatStore()
  })

  it('running task → кнопка есть; клик переводит все прогоны сессии (без type)', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'task' })] }),
      'en',
      's1',
    )
    const button = container.querySelector('button[aria-label="Move to background"]')
    expect(button).not.toBeNull()

    await act(async () => {
      ;(button as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.backgroundSession).toHaveBeenCalledTimes(1)
    expect(mocks.backgroundSession).toHaveBeenCalledWith('s1', undefined)
  })

  it('running execute_shell → кнопка есть', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'execute_shell' })] }),
      'en',
      's1',
    )
    expect(container.querySelector('button[aria-label="Move to background"]')).not.toBeNull()
  })

  it('running read_file (не блокирующий прогон) → кнопки нет', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'read_file' })] }),
      'en',
      's1',
    )
    expect(container.querySelector('button[aria-label="Move to background"]')).toBeNull()
  })

  it('завершённый task (status done) → кнопки нет', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'task', status: 'done' })] }),
      'en',
      's1',
    )
    expect(container.querySelector('button[aria-label="Move to background"]')).toBeNull()
  })

  it('без sessionId кнопки нет (некуда слать запрос)', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'task' })] }),
      'en',
    )
    expect(container.querySelector('button[aria-label="Move to background"]')).toBeNull()
  })

  it('ход не стримит → кнопки нет', async () => {
    const container = await renderPlaceholder(
      makeStream({ isStreaming: false, toolCalls: [makeLiveCall({ name: 'task' })] }),
      'en',
      's1',
    )
    expect(container.querySelector('button[aria-label="Move to background"]')).toBeNull()
  })

  it('ru-локаль: подпись/подсказка локализованы', async () => {
    const container = await renderPlaceholder(
      makeStream({ toolCalls: [makeLiveCall({ name: 'task' })] }),
      'ru',
      's1',
    )
    const button = container.querySelector('button[aria-label="В фон"]') as HTMLElement | null
    expect(button).not.toBeNull()
    expect(button!.title).toContain('ctrl+b')
  })
})
