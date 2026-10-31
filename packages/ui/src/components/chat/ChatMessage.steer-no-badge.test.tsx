/**
 * ADR-118 §4 / ADR-104: реплика, **вклинившаяся в ход**
 * (`message.enqueued` со `delivery: 'steer'`), рисуется обычным user-пузырём —
 * **без каких-либо пометок**:
 *   • нет бейджа «в очереди»/«вклинивается в ход»;
 *   • нет и прежнего маркера «вмешательство в ход» (`metadata.steer`).
 *
 * Остаются: маркер **прерывания** хода (`metadata.interrupt`) и бейдж
 * «Прервано» (`metadata.status === 'interrupted'`).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Минимальный MessageData-каркас. */
function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'user',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-10-31T00:00:00Z',
    ...partial,
  }
}

function ChatMessageEl(message: MessageData): React.ReactElement {
  return (
    <I18nProvider>
      <ChatMessage
        message={message}
        onCopy={() => {}}
        onToggle={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onRetry={() => {}}
        onDebug={() => {}}
        onFork={() => {}}
      />
    </I18nProvider>
  )
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(ChatMessageEl(message))
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

describe('ChatMessage: вклинивание в ход — без пометок (ADR-118 §4)', () => {
  beforeAll(() => {
    // Локаль ru: как initializeLocale() после чтения localStorage synth-ui.i18n.v1.
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('реплика со steerPending рисуется обычным пузырём — без бейджа', async () => {
    const container = await renderChat(
      makeMessage({ role: 'user', content: 'вмешательство', steerPending: true, ord: null }),
    )

    expect(container.textContent).toContain('вмешательство')
    expect(container.querySelector('[data-testid="message-queued-badge"]')).toBeNull()
    expect(container.querySelector('[data-testid="message-steer-pending-badge"]')).toBeNull()
    expect(container.textContent).not.toContain('В очереди')
    expect(container.textContent).not.toContain('Вклинивается в ход')
  })

  it('маркер «вмешательство в ход» (metadata.steer) больше не рисуется', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: 'вмешательство',
        metadata: { steer: true },
      }),
    )

    expect(container.textContent).toContain('вмешательство')
    expect(container.textContent).not.toContain('Вмешательство в ход')
  })

  it('у обычной реплики тоже нет никаких пометок', async () => {
    const container = await renderChat(
      makeMessage({ role: 'user', content: 'обычная реплика' }),
    )

    expect(container.textContent).toContain('обычная реплика')
    expect(container.textContent).not.toContain('Вмешательство в ход')
    expect(container.textContent).not.toContain('В очереди')
  })

  it('маркер прерывания хода (metadata.interrupt) остался', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: 'стоп и делай',
        metadata: { steer: true, interrupt: true },
      }),
    )

    expect(container.textContent).toContain('Прерывание хода')
  })

  it('бейдж «Прервано» остался', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'assistant',
        content: 'частичный ответ',
        metadata: { status: 'interrupted' },
      }),
    )

    expect(container.textContent).toContain('Прервано')
  })
})
