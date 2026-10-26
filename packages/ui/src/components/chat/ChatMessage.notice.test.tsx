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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'info',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-09-19T00:00:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(message: MessageData, props: Partial<React.ComponentProps<typeof ChatMessage>> = {}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
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
          {...props}
        />
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
  document.body.innerHTML = ''
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useAuthStore.setState({ user: null, profile: null } as never)
})

function actionTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.message-actions button')).map(
    (b) => b.getAttribute('title') || '',
  )
}

describe('ChatMessage: единый Notice служебных сообщений', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  it('summary → шапка «Summary», модель и полный набор действий', async () => {
    const container = await renderChat(
      makeMessage({ role: 'summary', content: 'Итог сессии', model: 'gpt-x' }),
    )
    expect(container.textContent).toContain('Summary')
    expect(container.textContent).toContain('Итог сессии')
    expect(container.textContent).toContain('gpt-x')
    const titles = actionTitles(container)
    // Копия — из Notice, остальное — встроенный MessageActions.
    expect(titles).toContain('Copy')
    expect(titles).toContain('Create branch')
    expect(titles).toContain('Pin')
    expect(titles).toContain('Delete')
    // Дублирующей кнопки копирования нет.
    expect(titles.filter((t) => t === 'Copy')).toHaveLength(1)
  })

  it('debug → шапка «Debug» и действия', async () => {
    const container = await renderChat(
      makeMessage({ role: 'debug', content: 'dbg', model: 'gpt-x' }),
    )
    expect(container.textContent).toContain('Debug')
    const titles = actionTitles(container)
    expect(titles).toContain('Copy')
    expect(titles).toContain('Create branch')
  })

  it('error → шапка «Ошибка», только копирование', async () => {
    const container = await renderChat(makeMessage({ role: 'error', content: 'boom' }))
    expect(container.textContent).toContain('Error')
    const titles = actionTitles(container)
    expect(titles).toEqual(['Copy'])
  })

  it('info → шапка «Info», только копирование, компактный кегль', async () => {
    const container = await renderChat(makeMessage({ role: 'info', content: 'note' }))
    expect(container.textContent).toContain('Info')
    expect(container.textContent).toContain('note')
    expect(actionTitles(container)).toEqual(['Copy'])
    const box = container.querySelector('[role="group"]') as HTMLElement
    expect(box.className).toContain('text-xs')
  })

  it('info c session_reference → карточка ссылки на сессию сохранена', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'info',
        content: 'Ссылка',
        metadata: { type: 'session_reference', session_id: 'abcdef12-3456', label: 'Ref' },
      }),
    )
    expect(container.textContent).toContain('Ref')
    expect(container.textContent).toContain('Открыть сессию')
  })

  it('summary с reasoning-блоками → блоки сохраняются внутри Notice', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'summary',
        content: 'Итог',
        reasoning_blocks: [{ text: 'размышление', iteration: 0 }],
      }),
    )
    expect(container.textContent).toContain('Reasoning')
  })

  it('selectionMode → чекбокс выбора сохранён для Notice', async () => {
    const container = await renderChat(
      makeMessage({ role: 'info', content: 'note' }),
      { selectionMode: true, isSelected: true },
    )
    const checkbox = container.querySelector('input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })

  it('summary в selectionMode: и чекбокс, и Notice', async () => {
    const container = await renderChat(
      makeMessage({ role: 'summary', content: 'Итог' }),
      { selectionMode: true },
    )
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(container.textContent).toContain('Summary')
  })
})

describe('ChatMessage: уведомление о завершении фонового прогона (ADR-111/ADR-113)', () => {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })

  beforeEach(() => {
    // Текущий залогиненный пользователь — чтобы убедиться, что в блоке фонового
    // прогона не рисуется userBadge с его именем.
    useAuthStore.setState({
      user: { id: 'u1', username: 'alice', roles: [] } as never,
      profile: { display_name: 'Alice' } as never,
    })
  })

  /** Клик по шапке карточки результата (раскрытие/сворачивание). */
  function toggleCard(container: HTMLElement): void {
    const header = container.querySelector('[data-tool-call-toggle]') as HTMLButtonElement
    expect(header).not.toBeNull()
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  /** Иконка в шапке системного блока (`Notice`). */
  function noticeIcon(container: HTMLElement): string | null {
    const group = container.querySelector('[role="group"]') as HTMLElement | null
    const header = group?.firstElementChild as HTMLElement | null
    return header?.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null
  }

  it('процесс → системный Notice «Background process · <команда> · completed», карточка внутри свёрнута', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: [
          '<process processID="proc_1" state="exited" command="npm test">',
          '5 passed',
          '</process>',
        ].join('\n'),
        metadata: {
          type: 'background_run_result',
          kind: 'process',
          state: 'completed',
          command: 'npm test',
        },
      }),
    )

    // Внешний системный блок: подпись в шапке и иконка прогона.
    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Background process · npm test · completed')
    expect(container.textContent).toContain('Background process · npm test · completed')
    expect(noticeIcon(container)).toBe('terminal-box')
    // Внутри блока — карточка результата, свёрнута: тело прогона не видно.
    expect(container.querySelector('[data-tool-call-toggle]')).not.toBeNull()
    expect(container.textContent).not.toContain('5 passed')
    // Служебных тегов модели в тексте нет.
    expect(container.textContent).not.toContain('<process')
    expect(container.textContent).not.toContain('</process>')
    // Не рисуем правый user-пузырь и userBadge текущего пользователя.
    expect(container.querySelector('.items-end')).toBeNull()
    expect(container.textContent).not.toContain('Alice')
  })

  it('процесс → после раскрытия карточки видно тело (лог) без конверта', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: [
          '<process processID="proc_1" state="exited" command="npm test">',
          '5 passed',
          '</process>',
        ].join('\n'),
        metadata: {
          type: 'background_run_result',
          kind: 'process',
          state: 'completed',
          command: 'npm test',
        },
      }),
    )

    await act(async () => {
      toggleCard(container)
    })

    expect(container.textContent).toContain('5 passed')
    expect(container.textContent).not.toContain('<process')
    expect(container.textContent).not.toContain('</process>')
  })

  it('процесс → в шапке карточки длительность прогона (по меткам старта/финиша)', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: '<process processID="proc_1" state="exited" command="npm test">\nok\n</process>',
        metadata: {
          type: 'background_run_result',
          kind: 'process',
          state: 'completed',
          command: 'npm test',
          started_at: '2026-10-20T10:00:00.000Z',
          finished_at: '2026-10-20T10:00:02.500Z',
        },
      }),
    )

    expect(container.textContent).toContain('2.5s')
  })

  it('саб-агент → подпись «Background subagent», иконка робота и тело без конверта', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: [
          '<subagent sessionID="child-1" state="failed" description="собрать отчёт">',
          '<summary>',
          'отчёт не собран',
          '</subagent>',
        ].join('\n'),
        metadata: {
          type: 'background_run_result',
          kind: 'subagent',
          state: 'failed',
          description: 'собрать отчёт',
        },
      }),
    )

    expect(container.textContent).toContain('Background subagent · собрать отчёт · failed')
    expect(noticeIcon(container)).toBe('robot-2')
    expect(container.textContent).not.toContain('<subagent')
    expect(container.textContent).not.toContain('</subagent>')
    expect(container.textContent).not.toContain('<summary>')

    await act(async () => {
      toggleCard(container)
    })

    expect(container.textContent).toContain('отчёт не собран')
    expect(container.textContent).not.toContain('<summary>')
  })

  it('отменённый процесс → состояние «stopped»', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: '<process processID="proc_1" state="killed" command="sleep 100">\n</process>',
        metadata: {
          type: 'background_run_result',
          kind: 'process',
          state: 'cancelled',
          command: 'sleep 100',
        },
      }),
    )
    expect(container.textContent).toContain('Background process · sleep 100 · stopped')
  })

  it('уведомление → полный набор действий как у user-сообщения', async () => {
    const container = await renderChat(
      makeMessage({
        role: 'user',
        content: '<process processID="proc_1" state="exited" command="npm test">\nok\n</process>',
        metadata: {
          type: 'background_run_result',
          kind: 'process',
          state: 'completed',
          command: 'npm test',
        },
      }),
    )
    const titles = actionTitles(container)
    expect(titles).toContain('Copy')
    expect(titles).toContain('Create branch')
    expect(titles).toContain('Pin')
    expect(titles).toContain('Delete')
    // Копия — одна (карточка сама копию не рисует).
    expect(titles.filter((t) => t === 'Copy')).toHaveLength(1)
  })

  it('обычное user-сообщение → user-пузырь сохранён (фоновый блок не ломает обычные)', async () => {
    const container = await renderChat(makeMessage({ role: 'user', content: 'Hello' }))
    expect(container.querySelector('.items-end')).not.toBeNull()
    expect(container.querySelector('[role="group"]')).toBeNull()
  })
})
