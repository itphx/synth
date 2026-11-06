/**
 * Ошибка саб-агента в **его** истории — центрированное системное сообщение
 * (ADR-111): как завершение фонового прогона (`Notice` variant `process`), но
 * красное. Подпись «Ошибка саб-агента · <имя>», в шапке — модель/время, тело —
 * локализованный текст ошибки; ответом агента (пузырём) это не рисуется.
 *
 * Основная сессия таких сообщений не создаёт (§8.14), поэтому ветка нужна
 * именно для дочерней (`isSubagent`).
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
import { useAgentsStore } from '@/stores/agentsStore'
import type { MessageData } from '@/stores/chatStore'

function makeMessage(partial: Partial<MessageData>): MessageData {
  return {
    index: 0,
    role: 'error',
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
  useAgentsStore.setState({ agents: [] })
})

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

describe('ChatMessage: ошибка саб-агента — центрированный красный Notice', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'ru', dictionary: ruDict, loadingLocale: null })
    useAgentsStore.setState({ agents: [] })
  })

  it('role:error + isSubagent → системный блок с подписью, иконкой робота, моделью/временем и текстом', async () => {
    const container = await renderChat(
      makeMessage({
        id: 'e1',
        role: 'error',
        agent_role: 'fixer',
        model: 'gpt-x',
        content: 'raw fallback',
        metadata: {
          i18n: {
            key: 'task.subagent_exec_error',
            params: { type: 'fixer', error: 'boom' },
          },
        },
      }),
      { isSubagent: true },
    )

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Ошибка саб-агента · fixer')
    expect(container.textContent).toContain('Ошибка саб-агента · fixer')
    // Красная палитра варианта `error`.
    expect(group.className).toContain('bg-destructive/10')
    expect(group.className).toContain('border-destructive/30')
    // Иконка — как у фонового саб-агента.
    const icon = group.querySelector('[data-icon]')
    expect(icon?.getAttribute('data-icon')).toBe('robot-2')
    // Шапка Notice — модель и время (как у `background_run_result`).
    expect(container.textContent).toContain('gpt-x')
    expect(container.textContent).toContain(timeOf('2026-11-06T01:03:00Z'))
    // Текст ошибки локализован по `metadata.i18n`, сырой content не показывается.
    expect(container.textContent).toContain('Ошибка выполнения сабагента «fixer»: boom')
    expect(container.textContent).not.toContain('raw fallback')
    // Центрирование: блок по центру, пузыря ответа/правого выравнивания нет.
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('items-center')
    expect(container.querySelector('[data-bubble]')).toBeNull()
    expect(container.querySelector('.items-end')).toBeNull()
  })

  it('имя берётся из реестра агентов (display_name), fallback — agent_role', async () => {
    useAgentsStore.setState({
      agents: [{ id: 'fixer', display_name: 'Фиксер', icon: 'bug', color: null } as never],
    })

    const container = await renderChat(
      makeMessage({
        id: 'e2',
        role: 'error',
        agent_role: 'fixer',
        content: 'boom',
        metadata: { i18n: { key: 'task.subagent_exec_error', params: { type: 'fixer', error: 'boom' } } },
      }),
      { isSubagent: true },
    )

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group.getAttribute('aria-label')).toBe('Ошибка саб-агента · Фиксер')
  })

  it('без agent_role — общая подпись «Ошибка»', async () => {
    const container = await renderChat(
      makeMessage({ id: 'e3', role: 'error', content: 'boom' }),
      { isSubagent: true },
    )

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Ошибка')
    expect(container.textContent).toContain('boom')
  })

  it('основная сессия (legacy role:error) — прежний Notice «Ошибка» без подписи саб-агента', async () => {
    const container = await renderChat(
      makeMessage({ id: 'e4', role: 'error', agent_role: 'fixer', content: 'boom' }),
    )

    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.getAttribute('aria-label')).toBe('Ошибка')
    expect(container.textContent).not.toContain('Ошибка саб-агента')
  })
})
