import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
// Заглушку ставим до импорта стора (vi.hoisted выполняется раньше импортов).
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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// MessageList сам создаёт ResizeObserver, а ScrollableOverlay/OverlayScrollbar
// проверяют его наличие — в jsdom его нет. Стаб без колбэков.
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { MessageList } from './MessageList'
import type { MessageData, StreamState } from '@/stores/chatStore'

/**
 * Регресс-тест на восстановление React.memo(ChatMessage).
 *
 * Первопричина: MessageList на каждый рендер вызывала `chatMsgProps(msg)`,
 * которая возвращала НОВЫЕ замыкания `onCopy: () => onCopy(msg)` и т.п.,
 * поэтому поверхностное сравнение memo всегда давало false и перерисовывались
 * все сообщения (в т.ч. на каждый чанк стрима).
 *
 * Маркер перерисовки: геттер `content` на объекте сообщения. MessageList его
 * не читает (читает только role/metadata/index), а ChatMessageInner — читает
 * (`displayContent = ... ?? message.content`). Значит рост счётчика чтений
 * означает именно повторный рендер ChatMessageInner.
 */

const EMPTY_STREAMS: Record<string, StreamState> = {}

const noop = () => {}
const noopMsg: (msg: MessageData) => void = noop
const stableToggleSelect = (_index: number, _shiftKey: boolean) => {}

function baseMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'user',
    content: 'Привет',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

/** Оборачивает сообщение геттером content, считающим чтения при рендере ChatMessageInner. */
function withContentProbe(base: MessageData): { message: MessageData; reads: () => number } {
  let reads = 0
  const probed = { ...base }
  Object.defineProperty(probed, 'content', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1
      return base.content
    },
  })
  return { message: probed as MessageData, reads: () => reads }
}

interface Scenario {
  /** Меняется, чтобы гарантированно перерисовать родителя. */
  tick: number
  messages: MessageData[]
}

let setScenario: ((updater: (prev: Scenario) => Scenario) => void) | null = null
let harnessRenders = 0

function Harness({ initialMessages }: { initialMessages: MessageData[] }) {
  const [scenario, setScenarioState] = React.useState<Scenario>({ tick: 0, messages: initialMessages })
  setScenario = setScenarioState
  harnessRenders += 1
  return (
    <I18nProvider>
      <MessageList
        messages={scenario.messages}
        streams={EMPTY_STREAMS}
        onCopy={noopMsg}
        onToggle={noopMsg}
        onPin={noopMsg}
        onDelete={noopMsg}
        onRetry={noopMsg}
        onDebug={noopMsg}
        onFork={noopMsg}
        onStop={noop}
        onToggleSelect={stableToggleSelect}
      />
    </I18nProvider>
  )
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderHarness(initialMessages: MessageData[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<Harness initialMessages={initialMessages} />)
  })
  return container
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
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
  setScenario = null
  harnessRenders = 0
})

describe('ChatMessage: React.memo через MessageList', () => {
  it('не перерисовывается при ре-рендере родителя с теми же пропсами', async () => {
    const probe = withContentProbe(baseMessage({}))
    await renderHarness([probe.message])

    const readsAfterMount = probe.reads()
    expect(readsAfterMount).toBeGreaterThan(0)
    const rendersAfterMount = harnessRenders

    await act(async () => {
      setScenario!((prev) => ({ ...prev, tick: prev.tick + 1 }))
    })

    // Родитель действительно перерисовался...
    expect(harnessRenders).toBeGreaterThan(rendersAfterMount)
    // ...но ChatMessage с теми же пропсами — нет.
    expect(probe.reads()).toBe(readsAfterMount)
  })

  it('перерисовывается, когда меняется объект сообщения (проверка чувствительности)', async () => {
    const first = withContentProbe(baseMessage({}))
    const second = withContentProbe(baseMessage({ content: 'Другое сообщение' }))
    await renderHarness([first.message])

    const firstReads = first.reads()

    await act(async () => {
      setScenario!((prev) => ({ ...prev, tick: prev.tick + 1, messages: [second.message] }))
    })

    // Новый объект сообщения → memo не может пропустить рендер.
    expect(second.reads()).toBeGreaterThan(0)
    expect(first.reads()).toBe(firstReads)
  })
})
