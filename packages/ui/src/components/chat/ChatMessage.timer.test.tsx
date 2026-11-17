import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'

// Клиентский рендер (createRoot): renderToString не подходит — zustand
// useSyncExternalStore в SSR читает getInitialState (enDict), а не текущий стейт.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Сообщение о срабатывании таймера/будильника — ровно то, что кладёт ядро
 * (`engine/events/request-session.ts`, PROP-141 Часть B):
 *  - `role: 'user'`, автор — системный `Timer`;
 *  - `content` — конверт `<timer …>` (его видит модель, в UI не показывается);
 *  - `metadata.type = 'timer_fired'` + детали срабатывания
 *    (`timer_kind`/`comment`/`timer_name`?).
 */
function makeTimerMessage(opts?: {
  kind?: 'timer' | 'alarm'
  comment?: string
  name?: string
}): MessageData {
  const kind = opts?.kind ?? 'timer'
  const comment = opts?.comment ?? 'позвонить в сервис'
  const content =
    `<timer id="timer_1" kind="${kind}" repeat="once" fired_at="2026-08-28T00:00:00Z">\n` +
    `${comment}\n</timer>`

  return {
    index: 0,
    id: 'msg_timer_1',
    role: 'user',
    author: 'Timer',
    content,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-08-28T00:00:00Z',
    metadata: {
      type: 'timer_fired',
      timer_id: 'timer_1',
      timer_kind: kind,
      repeat: 'once',
      comment,
      scheduled_for: '2026-08-28T00:00:00Z',
      fired_at: '2026-08-28T00:00:00Z',
      ...(opts?.name ? { timer_name: opts.name } : {}),
    },
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

/** Локаль словаря — как `initializeLocale()` после чтения localStorage synth-ui.i18n.v1. */
function setLocale(locale: 'ru' | 'en'): void {
  useI18nStore.setState({
    locale,
    dictionary: locale === 'ru' ? ruDict : enDict,
    loadingLocale: null,
  })
}

/** Блок `Notice` (служебный блок) — `role="group"` c подписью в `aria-label`. */
function noticeGroup(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="group"]')
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

describe('ChatMessage: ветка рендера metadata.type = timer_fired (PROP-141, Часть B)', () => {
  beforeEach(() => {
    setLocale('ru')
  })

  it('таймер (RU) → служебный Notice с подписью «Таймер», комментарий виден, user-пузыря нет', async () => {
    const container = await renderChat(makeTimerMessage())

    // Служебный блок `Notice`, а не правый user-пузырь.
    expect(container.querySelector('[data-bubble]')).toBeNull()
    const group = noticeGroup(container)
    expect(group).not.toBeNull()
    expect(group?.getAttribute('aria-label')).toBe('Таймер')

    // Комментарий таймера виден…
    expect(container.textContent).toContain('позвонить в сервис')
    // …а конверт `<timer …>` модели в UI не показывается.
    expect(container.textContent).not.toContain('<timer')
  })

  it('таймер (EN) → подпись «Timer»', async () => {
    setLocale('en')
    const container = await renderChat(makeTimerMessage())

    expect(container.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(container)?.getAttribute('aria-label')).toBe('Timer')
    expect(container.textContent).toContain('позвонить в сервис')
  })

  it('будильник (timer_kind=alarm) → подпись «Будильник» (RU) / «Alarm» (EN)', async () => {
    const ru = await renderChat(makeTimerMessage({ kind: 'alarm' }))
    expect(ru.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(ru)?.getAttribute('aria-label')).toBe('Будильник')
    // Иконка будильника, а не часов.
    expect(ru.querySelector('[data-icon="alarm"]')).not.toBeNull()
    expect(ru.querySelector('[data-icon="time"]')).toBeNull()

    setLocale('en')
    const en = await renderChat(makeTimerMessage({ kind: 'alarm' }))
    expect(en.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(en)?.getAttribute('aria-label')).toBe('Alarm')
  })

  it('таймер с именем (timer_name) → подпись «Таймер · Звонок»', async () => {
    const container = await renderChat(makeTimerMessage({ name: 'Звонок' }))

    expect(container.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(container)?.getAttribute('aria-label')).toBe('Таймер · Звонок')
    expect(container.textContent).toContain('позвонить в сервис')
  })
})
