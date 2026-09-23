import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { StreamingPlaceholder } from './StreamingPlaceholder'
import type { StreamState } from '@/stores/chatStore'

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
        <StreamingPlaceholder stream={stream} onStop={() => {}} />
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

describe('StreamingPlaceholder — live-статистика (AD-070 §2.6)', () => {
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
