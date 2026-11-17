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
 * Уведомление о переносе сессии между проектами — ровно то, что кладёт ядро
 * (`packages/core/src/sessions/move-service.ts`, PROP-141 Часть D):
 *  - `role: 'user'`, автор — системный `Session`;
 *  - `metadata.type = 'session_moved'` + `from_project_id`/`to_project_id`,
 *    `effects[]` (что остановили/закрыли/отменили) и `moved_sessions`;
 *  - `content` — компактный конверт `<session_moved …>` (его видит модель,
 *    в UI показывается только как фоллбек).
 */
function makeSessionMovedMessage(opts?: {
  effects?: Array<{ kind: string; action: string; id?: string }>
  withEffects?: boolean
}): MessageData {
  const effects = opts?.effects ?? [
    { kind: 'process', action: 'stopped', id: 'proc_1' },
    { kind: 'terminal', action: 'left_in_old_project', id: 'term_2' },
    { kind: 'timer', action: 'cancelled', id: 'tmr_3' },
    { kind: 'schedule', action: 'disabled', id: 'sch_4' },
    { kind: 'worktree', action: 'detached', id: 'wkt_5' },
    { kind: 'session', action: 'moved', id: 'ses_1' },
  ]
  const content =
    '<session_moved from="p1" to="p2">\n' +
    effects.map((e) => `${e.kind}.${e.action}${e.id ? ` ${e.id}` : ''}`).join('\n') +
    '\n</session_moved>'

  return {
    index: 0,
    id: 'msg_moved_1',
    role: 'user',
    author: 'Session',
    content,
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-17T10:00:00Z',
    metadata: {
      type: 'session_moved',
      from_project_id: 'p1',
      to_project_id: 'p2',
      ...(opts?.withEffects === false ? {} : { effects }),
      moved_sessions: ['ses_1'],
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

/** Строки локализованного списка эффектов. */
function effectLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="session-moved-effect"]')].map(
    (node) => node.textContent ?? '',
  )
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

describe('ChatMessage: ветка рендера metadata.type = session_moved (PROP-141, Часть D)', () => {
  beforeEach(() => {
    setLocale('ru')
  })

  it('перенос сессии (RU) → служебный Notice с подписью «Сессия перенесена», эффекты видны', async () => {
    const container = await renderChat(makeSessionMovedMessage())

    // Служебный блок `Notice`, а не правый user-пузырь.
    expect(container.querySelector('[data-bubble]')).toBeNull()
    const group = noticeGroup(container)
    expect(group).not.toBeNull()
    expect(group?.getAttribute('aria-label')).toBe('Сессия перенесена')

    // Иконка переноса — в реестре иконок.
    expect(container.querySelector('[data-icon="arrow-left-right"]')).not.toBeNull()

    // Локализованный список эффектов…
    const lines = effectLines(container)
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('Процесс остановлен')
    expect(lines[0]).toContain('proc_1')
    expect(lines[1]).toContain('Терминал остался в старом проекте')
    expect(lines[2]).toContain('Таймер отменён')
    expect(lines[3]).toContain('Расписание отключено')
    expect(lines[4]).toContain('Рабочая копия отсоединена')
    expect(lines[5]).toContain('сессия перенесена')

    // …а конверт `<session_moved …>` модели в UI не показывается.
    expect(container.textContent).not.toContain('<session_moved')
  })

  it('перенос сессии (EN) → подпись «Session moved» и английские эффекты', async () => {
    setLocale('en')
    const container = await renderChat(makeSessionMovedMessage())

    expect(container.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(container)?.getAttribute('aria-label')).toBe('Session moved')
    const lines = effectLines(container)
    expect(lines[0]).toContain('Process stopped')
    expect(lines[1]).toContain('Terminal left in the old project')
    expect(lines[5]).toContain('session moved')
  })

  it('без эффектов в метаданных — фоллбак на содержимое сообщения', async () => {
    const container = await renderChat(makeSessionMovedMessage({ withEffects: false }))

    expect(container.querySelector('[data-bubble]')).toBeNull()
    expect(noticeGroup(container)?.getAttribute('aria-label')).toBe('Сессия перенесена')
    // Локализованного списка нет — тело взято из `content` (конверт модели).
    expect(effectLines(container)).toHaveLength(0)
    expect(container.textContent).toContain('process.stopped proc_1')
  })
})
