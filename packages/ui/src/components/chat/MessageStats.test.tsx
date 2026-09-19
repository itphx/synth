import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { MessageStats, hasMessageStats } from './MessageStats'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Минимальный MessageData-каркас. */
function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: 'Answer',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderStats(message: MessageData, locale: 'en' | 'ru' = 'en'): Promise<HTMLElement> {
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
        <MessageStats message={message} />
      </I18nProvider>,
    )
  })
  return container
}

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('MessageStats', () => {
  it('полный набор сегментов: duration, in/out, cost, cache, tok/s', async () => {
    const container = await renderStats(
      makeMessage({
        usage: {
          input_tokens: 1_700_000,
          output_tokens: 33_300,
          total_tokens: 1_733_300,
          cache_read_tokens: 1_581_000,
        },
        metadata: { duration_ms: 694_000, cost_usd: 0.03 },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Done in 11m 34s')
    expect(text).toContain('1.7M in')
    expect(text).toContain('33.3k out')
    expect(text).toContain('~$0.03')
    expect(text).toContain('93% cached')
    expect(text).toContain('48 tok/s')
    // Разделители между сегментами.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(5)
  })

  it('без duration нет сегмента Done in и нет tok/s', async () => {
    const container = await renderStats(
      makeMessage({
        usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
        metadata: { cost_usd: 0.01 },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).not.toContain('Done in')
    expect(text).not.toContain('tok/s')
    expect(text).toContain('1k in')
    expect(text).toContain('500 out')
    expect(text).toContain('~$0.01')
  })

  it('нет данных вообще → null (ничего не рендерится)', async () => {
    const container = await renderStats(makeMessage({ usage: null }))
    expect(container.querySelector('[data-testid="message-stats"]')).toBeNull()
    expect(container.textContent).toBe('')
    expect(hasMessageStats(makeMessage({ usage: null }))).toBe(false)
  })

  it('input = 0 → сегмент кэша отсутствует', async () => {
    const container = await renderStats(
      makeMessage({
        usage: {
          input_tokens: 0,
          output_tokens: 100,
          total_tokens: 100,
          cache_read_tokens: 50,
        },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).not.toContain('cached')
    expect(text).toContain('0 in')
    expect(text).toContain('100 out')
  })

  it('duration без usage → только Done in, без tok/s и токенов', async () => {
    const container = await renderStats(
      makeMessage({ usage: null, metadata: { duration_ms: 12_000 } }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Done in 12s')
    expect(text).not.toContain('tok/s')
    expect(text).not.toContain(' out')
  })

  it('ru-локаль: перевод сегментов и форматирование', async () => {
    const container = await renderStats(
      makeMessage({
        usage: {
          input_tokens: 1500,
          output_tokens: 300,
          total_tokens: 1800,
          cache_read_tokens: 750,
        },
        metadata: { duration_ms: 60_000, cost_usd: 0.01 },
      }),
      'ru',
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Готово за 1m')
    expect(text).toContain('1.5k вх')
    expect(text).toContain('300 исх')
    expect(text).toContain('~$0.01')
    expect(text).toContain('50% из кэша')
    expect(text).toContain('5 tok/s')
  })
})

describe('hasMessageStats', () => {
  it('usage есть → true', () => {
    expect(hasMessageStats(makeMessage({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }))).toBe(true)
  })

  it('только cost_usd → true', () => {
    expect(hasMessageStats(makeMessage({ usage: null, metadata: { cost_usd: 0.5 } }))).toBe(true)
  })

  it('только duration_ms → true', () => {
    expect(hasMessageStats(makeMessage({ usage: null, metadata: { duration_ms: 1000 } }))).toBe(true)
  })

  it('нечисловой duration/cost → false', () => {
    expect(
      hasMessageStats(makeMessage({ usage: null, metadata: { duration_ms: '1000', cost_usd: null } })),
    ).toBe(false)
  })
})
