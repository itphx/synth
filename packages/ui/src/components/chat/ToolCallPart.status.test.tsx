/**
 * Три состояния карточки вызова инструмента (ADR-118, addendum MESSAGE_FLOW §8.2).
 *
 * Ядро публикует `tool_call.started` в момент **фактического** старта вызова, а
 * `tool_call.result` — как только готов исход этого вызова. Поэтому у карточки
 * есть третье состояние:
 * - `queued` — вызов ещё не стартовал (стоит за барьером, ждёт подтверждения
 *   или медленного соседа по батчу): нейтральный вид, без индикатора работы
 *   (`animate-tool-pulse`), без длительности, с подписью «ожидает запуска»;
 * - `running` — исполняется (спиннер/пульс), после старта;
 * - `done` — исход известен (результат в карточке).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ToolCallPart } from './ToolCallPart'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(toolCall: Record<string, unknown>): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ToolCallPart toolCall={toolCall as never} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

/** Вызов `read_file` в заданном состоянии. */
function call(status: 'queued' | 'running' | 'done', extra: Record<string, unknown> = {}) {
  return {
    name: 'read_file',
    args: { path: 'a.ts' },
    callId: 'call-1',
    iteration: 0,
    status,
    ...extra,
  }
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => root.unmount())
    container.remove()
  }
})

describe('ToolCallPart: состояние `queued` (вызов ещё не стартовал)', () => {
  it('подпись «ожидает запуска», без пульса и без длительности', async () => {
    // Метки времени заведомо есть — длительность всё равно не показывается.
    const container = await render(call('queued', {
      startedAt: '2026-11-18T00:00:00Z',
      completedAt: '2026-11-18T00:00:02Z',
    }))

    const label = container.querySelector('[data-testid="tool-call-queued"]')
    expect(label?.textContent).toBe('ожидает запуска')

    // Нейтральный вид: карточка знает своё состояние, индикатора работы нет.
    expect(container.querySelector('[data-tool-status]')?.getAttribute('data-tool-status')).toBe('queued')
    expect(container.querySelector('.animate-tool-pulse')).toBeNull()

    // Длительность не показывается.
    expect(container.textContent ?? '').not.toContain('2.0s')
  })

  it('раскрытие показывает аргументы (не пустую карточку)', async () => {
    const container = await render(call('queued'))
    const toggle = container.querySelector('[data-tool-call-toggle="1"]') as HTMLElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Аргументы')
    expect(text).toContain('a.ts')
  })
})

describe('ToolCallPart: состояния `running` и `done`', () => {
  it('`running`: индикатор работы есть, подписи «ожидает запуска» нет', async () => {
    const container = await render(call('running', { startedAt: '2026-11-18T00:00:00Z' }))

    expect(container.querySelector('.animate-tool-pulse')).not.toBeNull()
    expect(container.querySelector('[data-testid="tool-call-queued"]')).toBeNull()
    expect(container.querySelector('[data-tool-status]')?.getAttribute('data-tool-status')).toBe('running')
  })

  it('`done`: результат в карточке, индикатора работы и подписи ожидания нет', async () => {
    const container = await render(call('done', {
      startedAt: '2026-11-18T00:00:00Z',
      completedAt: '2026-11-18T00:00:02Z',
      result: { content: 'file body' },
    }))

    expect(container.querySelector('.animate-tool-pulse')).toBeNull()
    expect(container.querySelector('[data-testid="tool-call-queued"]')).toBeNull()
    expect(container.querySelector('[data-tool-status]')?.getAttribute('data-tool-status')).toBe('done')
    // Длительность завершённого вызова показывается.
    expect(container.textContent ?? '').toContain('2.0s')

    const toggle = container.querySelector('[data-tool-call-toggle="1"]') as HTMLElement
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const resultTab = Array.from(container.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '') === 'Результат')
    expect(resultTab).toBeDefined()
  })
})
