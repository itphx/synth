import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { MessageStats, hasMessageStats } from './MessageStats'
import type { MessageData, MessageStatus } from '@/stores/chatStore'

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

async function renderStats(
  message: MessageData,
  locale: 'en' | 'ru' = 'en',
  variant: 'inline' | 'popover' = 'inline',
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
        <MessageStats message={message} variant={variant} />
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
  it('полный набор сегментов: duration, in/out, cost, cache, tok/s (completed — без префикса)', async () => {
    const container = await renderStats(
      makeMessage({
        usage: {
          input_tokens: 1_700_000,
          output_tokens: 33_300,
          total_tokens: 1_733_300,
          cache_read_tokens: 1_581_000,
        },
        metadata: { duration_ms: 694_000, cost_usd: 0.03, status: 'completed' },
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('11m 34s')
    expect(text).not.toContain('Done in')
    expect(text).toContain('1.7M in')
    expect(text).toContain('33.3k out')
    expect(text).toContain('~$0.03')
    expect(text).toContain('93% cache')
    expect(text).toContain('48 tok/s')
    // 6 сегментов → 5 разделителей; completed не добавляет префикс.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(5)
  })

  it('без duration нет сегмента tok/s', async () => {
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
    expect(text).not.toContain('cache')
    expect(text).toContain('0 in')
    expect(text).toContain('100 out')
  })

  it('duration без usage → только duration, без tok/s и токенов', async () => {
    const container = await renderStats(
      makeMessage({ usage: null, metadata: { duration_ms: 12_000 } }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('12s')
    expect(text).not.toContain('Done in')
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
    expect(text).toContain('1m')
    expect(text).not.toContain('Готово за')
    expect(text).toContain('1.5k вх')
    expect(text).toContain('300 исх')
    expect(text).toContain('~$0.01')
    expect(text).toContain('50% кэш')
    expect(text).toContain('5 tok/s')
  })

  describe('префикс состояния', () => {
    const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }
    const base = { usage, metadata: { duration_ms: 2000 } }

    it.each<[MessageStatus, string]>([
      ['cancelled', 'Stopped'],
      ['stopped', 'Stopped'],
      ['error', 'Error'],
      ['limit', 'Iteration limit'],
    ])('status=%s → «%s» первым сегментом', async (status, label) => {
      const container = await renderStats(
        makeMessage({ ...base, metadata: { ...base.metadata, status } }),
      )
      const text = container.textContent ?? ''
      expect(text).toContain(label)
      // Префикс идёт до duration.
      expect(text.indexOf(label)).toBeLessThan(text.indexOf('2s'))
    })

    it('completed → без префикса', async () => {
      const container = await renderStats(
        makeMessage({ ...base, metadata: { ...base.metadata, status: 'completed' } }),
      )
      const text = container.textContent ?? ''
      expect(text).not.toContain('Stopped')
      expect(text).not.toContain('Error')
      expect(text).not.toContain('Iteration limit')
    })

    it('fallback по metadata.i18n.key для старых сообщений', async () => {
      const error = await renderStats(
        makeMessage({ ...base, metadata: { duration_ms: 2000, i18n: { key: 'session.empty_response' } } }),
      )
      expect(error.textContent).toContain('Error')

      const stopped = await renderStats(
        makeMessage({ ...base, metadata: { duration_ms: 2000, i18n: { key: 'session.stopped' } } }),
      )
      expect(stopped.textContent).toContain('Stopped')

      const limit = await renderStats(
        makeMessage({ ...base, metadata: { duration_ms: 2000, i18n: { key: 'session.max_iterations' } } }),
      )
      expect(limit.textContent).toContain('Iteration limit')
    })

    it('неизвестный статус → без префикса', async () => {
      const container = await renderStats(
        makeMessage({ ...base, metadata: { duration_ms: 2000, status: 'weird' } }),
      )
      expect(container.textContent).not.toContain('Stopped')
    })

    it('ru-локаль: префиксы локализованы', async () => {
      const container = await renderStats(
        makeMessage({ usage, metadata: { duration_ms: 2000, status: 'limit' } }),
        'ru',
      )
      expect(container.textContent).toContain('Лимит итераций')
    })
  })

  it('variant="popover": одна строка без переноса с разделителями `·`', async () => {
    const container = await renderStats(
      makeMessage({
        usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
        metadata: { duration_ms: 2000, cost_usd: 0.01, status: 'stopped' },
      }),
      'en',
      'popover',
    )
    const el = container.querySelector('[data-testid="message-stats"]') as HTMLElement
    expect(el).not.toBeNull()
    // Одна строка без переноса (nowrap), не колонка.
    expect(el.className).toContain('flex-nowrap')
    expect(el.className).toContain('whitespace-nowrap')
    expect(el.className).not.toContain('flex-col')
    expect(el.className).not.toContain('flex-wrap')

    // 7 сегментов → 6 разделителей `·`.
    const separators = container.querySelectorAll('[aria-hidden="true"]')
    expect(separators.length).toBe(6)
    expect([...separators].every((s) => s.textContent === '·')).toBe(true)

    // Порядок сегментов сохранён.
    const segments = [...el.querySelectorAll('span:not([aria-hidden="true"])')].map(
      (s) => s.textContent,
    )
    expect(segments).toEqual(['Stopped', '2s', '1k in', '100 out', '~$0.01', '0% cache', '50 tok/s'])
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

  it('только содержательный status → true', () => {
    expect(hasMessageStats(makeMessage({ usage: null, metadata: { status: 'cancelled' } }))).toBe(true)
  })

  it('completed-статус без метрик → false', () => {
    expect(hasMessageStats(makeMessage({ usage: null, metadata: { status: 'completed' } }))).toBe(false)
  })

  it('нечисловой duration/cost → false', () => {
    expect(
      hasMessageStats(makeMessage({ usage: null, metadata: { duration_ms: '1000', cost_usd: null } })),
    ).toBe(false)
  })
})
