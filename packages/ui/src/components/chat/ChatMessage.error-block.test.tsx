/**
 * Ошибка **хода** — inline системный блок, а не ответ агента (ADR-041 × ADR-118).
 *
 * Ядро сохраняет терминальную ошибку assistant-сообщением с
 * `metadata.status: 'error'` (шаг = assistant-сообщение). UI обязан показать её
 * системным блоком («Ошибка» + агент/модель/время), но при этом:
 *  - `cancelled`/`interrupted` (частичный ответ после «Стопа»/прерывания) —
 *    обычный ответ с бейджем «Прервано», а не ошибка;
 *  - legacy-сообщение без `status` шага, но с `metadata.status: 'error'` и без
 *    `interrupted` — тоже ошибка;
 *  - истёкшая сессия гибрида (`router.remote_auth_expired`) даёт кнопку
 *    повторного входа.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as ruDict } from '@/lib/i18n/messages/ru'
import { ChatMessage } from './ChatMessage'
import type { MessageData } from '@/stores/chatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'assistant',
    content: '',
    disabled: false,
    pinned: false,
    hidden: false,
    created_at: '2026-11-06T01:03:00Z',
    ...partial,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderChat(
  message: MessageData,
  props: Partial<React.ComponentProps<typeof ChatMessage>> = {},
): Promise<HTMLElement> {
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
  vi.restoreAllMocks()
})

function actionTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.message-actions button')).map(
    (b) => b.getAttribute('title') || '',
  )
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

describe('ChatMessage: ошибка хода — inline системный блок', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
  })

  it('assistant + status:error → блок «Ошибка», шапка агента/модели/времени, локализованный текст и действия', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'e1',
        status: 'error',
        role: 'assistant',
        agent_role: 'leader',
        model: 'deepseek-flash',
        content: 'raw fallback text',
        metadata: {
          status: 'error',
          i18n: { key: 'router.remote_auth_expired' },
        },
        debug_data: { request: true },
      }),
    )

    const block = container.querySelector('[data-testid="turn-error"]') as HTMLElement
    expect(block).not.toBeNull()
    // Подпись системного блока, а не «ответ агента».
    expect(container.textContent).toContain('Ошибка')
    // Текст локализован по `metadata.i18n`, сырой content не показывается.
    expect(container.textContent).toContain('Сессия на сервере истекла — войдите в гибрид заново')
    expect(container.textContent).not.toContain('raw fallback text')
    // Шапка ошибки сохраняет контекст: агент, модель, время.
    expect(container.textContent).toContain('leader')
    expect(container.textContent).toContain('deepseek-flash')
    expect(container.textContent).toContain(timeOf('2026-11-06T01:03:00Z'))
    // Действия — полный набор как у assistant.
    const titles = actionTitles(container)
    expect(titles).toContain('Копировать')
    expect(titles).toContain('Создать ветку')
    expect(titles).toContain('Закрепить')
    expect(titles).toContain('Удалить')
    expect(titles).toContain('Отладка')
  })

  it('status:cancelled + metadata.status:error + interrupted:true → обычный пузырь с бейджем «Прервано», НЕ блок ошибки', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'c1',
        status: 'cancelled',
        role: 'assistant',
        content: 'частичный ответ после стопа',
        metadata: { status: 'error', interrupted: true },
      }),
    )

    expect(container.querySelector('[data-testid="turn-error"]')).toBeNull()
    expect(container.querySelector('[data-bubble]')).not.toBeNull()
    expect(container.textContent).toContain('частичный ответ после стопа')
    expect(container.textContent).toContain('Прервано')
  })

  it('legacy: status отсутствует, metadata.status:error без interrupted → блок ошибки', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'l1',
        status: null,
        role: 'assistant',
        content: 'legacy failure',
        metadata: { status: 'error' },
      }),
    )

    expect(container.querySelector('[data-testid="turn-error"]')).not.toBeNull()
    expect(container.textContent).toContain('Ошибка')
    expect(container.textContent).toContain('legacy failure')
  })

  it('selectionMode → чекбокс выбора есть и у inline-блока ошибки', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'e2',
        status: 'error',
        role: 'assistant',
        content: 'boom',
        metadata: { status: 'error' },
      }),
      { selectionMode: true, isSelected: true },
    )

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(true)
    expect(container.querySelector('[data-testid="turn-error"]')).not.toBeNull()
  })

  it('router.remote_auth_expired → кнопка «Войти в гибрид заново» вызывает logout', async () => {
    const logout = vi.spyOn(useAuthStore.getState(), 'logout').mockResolvedValue(undefined)

    const container = await renderChat(
      makeMessage({
        id: 'e3',
        status: 'error',
        role: 'assistant',
        content: 'raw',
        metadata: {
          status: 'error',
          i18n: { key: 'router.remote_auth_expired' },
        },
      }),
    )

    const button = container.querySelector(
      '[data-testid="turn-error-hybrid-relogin"]',
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('Войти в гибрид заново')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('обычная ошибка провайдера (не гибрид) кнопку входа не показывает', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'e4',
        status: 'error',
        role: 'assistant',
        content: 'provider exploded',
        metadata: {
          status: 'error',
          i18n: { key: 'router.network_error' },
        },
      }),
    )

    expect(container.querySelector('[data-testid="turn-error"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="turn-error-hybrid-relogin"]')).toBeNull()
  })
})
