import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TreeNode } from './TreeNode'
import type { TreeAction, TreeStatus } from './types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderNode(actions: TreeAction[]): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TreeNode id="proj-1" label="Project" actions={actions} />
      </I18nProvider>,
    )
  })
  return container
}

/** Узел с произвольным статусом и счётчиком непрочитанных. */
async function renderStatusNode(props: {
  status?: TreeStatus
  unreadCount?: number
}): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TreeNode id="session:s1" label="Session" {...props} />
      </I18nProvider>,
    )
  })
  return container
}

/** Точка-индикатор статуса в строке дерева. */
function statusDot(container: ParentNode): HTMLElement | null {
  return container.querySelector<HTMLElement>('span[role="img"]')
}

/** Span с названием узла (внутри строки). */
function labelSpan(container: ParentNode): HTMLElement | null {
  const node = container.querySelector('[data-tree-node]')
  if (!node) return null
  return [...node.querySelectorAll('span')].find(
    (el) => el.textContent === 'Session' && !el.querySelector('svg'),
  ) ?? null
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
})

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('TreeNode — ActionButton с menuItems: попап не «убегает»', () => {
  const menuAction = (): TreeAction => ({
    id: 'new-session',
    icon: 'add',
    title: 'New session',
    menuItems: [
      { label: 'Create locally', icon: 'server', onClick: () => {} },
      { label: 'Create on server', icon: 'server', onClick: () => {} },
    ],
  })

  it('до клика триггер hover-only (класс hidden)', async () => {
    const container = await renderNode([menuAction()])
    const trigger = container.querySelector('button[title="New session"]')
    expect(trigger).not.toBeNull()
    expect(trigger!.classList.contains('hidden')).toBe(true)
  })

  it('пока меню открыто — триггер остаётся видимым (без класса hidden)', async () => {
    const container = await renderNode([menuAction()])
    const trigger = container.querySelector('button[title="New session"]') as HTMLButtonElement
    expect(trigger.classList.contains('hidden')).toBe(true)

    await click(trigger)

    // Пункты меню появились (рендерятся в портале, вне строки).
    expect(document.body.textContent).toContain('Create locally')
    expect(document.body.textContent).toContain('Create on server')

    // Ключевая регрессия: триггер не должен стать display:none, иначе
    // Radix Popper теряет якорь (rect = 0,0) и попап уезжает вверх/в угол.
    expect(trigger.classList.contains('hidden')).toBe(false)
  })

  it('закрытие по Escape возвращает hover-only состояние', async () => {
    const container = await renderNode([menuAction()])
    const trigger = container.querySelector('button[title="New session"]') as HTMLButtonElement

    await click(trigger)
    expect(trigger.classList.contains('hidden')).toBe(false)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(trigger.classList.contains('hidden')).toBe(true)
  })

  it('обычное действие без menuItems: hover-only и onClick срабатывает', async () => {
    const onClick = vi.fn()
    const container = await renderNode([
      { id: 'plain', icon: 'add', title: 'Plain action', onClick },
    ])
    const trigger = container.querySelector('button[title="Plain action"]') as HTMLButtonElement
    expect(trigger.classList.contains('hidden')).toBe(true)

    await click(trigger)
    expect(onClick).toHaveBeenCalledTimes(1)
    // Поведение обычного действия не меняется — остаётся hover-only.
    expect(trigger.classList.contains('hidden')).toBe(true)
  })
})

describe('TreeNode — индикатор статуса', () => {
  it('точки статуса нет, когда статус не задан', async () => {
    const container = await renderStatusNode({})
    expect(statusDot(container)).toBeNull()
  })

  it('«ждёт подтверждения прав»: точка оранжевая из темы, название тоже оранжевое', async () => {
    const container = await renderStatusNode({ status: 'approval' })

    const dot = statusDot(container)
    expect(dot).not.toBeNull()
    expect(dot!.classList.contains('bg-status-caution')).toBe(true)

    const label = labelSpan(container)
    expect(label).not.toBeNull()
    expect(label!.classList.contains('text-status-caution')).toBe(true)
    // Палитра Tailwind в статусех не используется.
    expect(container.innerHTML).not.toContain('orange-400')
  })

  it('у точки статуса есть текстовая подпись (доступность: цвет не единственный сигнал)', async () => {
    const container = await renderStatusNode({ status: 'approval' })
    const dot = statusDot(container)!
    // Ключ `leftPanel.approvalNeeded` — текстовый дубль оранжевого цвета.
    // Отдельный от `attentionNeeded` («очередь зависла»).
    expect(dot.getAttribute('aria-label')).toBe('Approval needed')
    expect(dot.getAttribute('title')).toBe('Approval needed')
  })

  it('«ждёт подтверждения прав» перекрывает непрочитанное', async () => {
    const container = await renderStatusNode({ status: 'approval', unreadCount: 3 })

    const label = labelSpan(container)!
    expect(label.classList.contains('text-status-caution')).toBe(true)
    expect(label.classList.contains('text-orange-400')).toBe(false)
  })

  it('непрочитанное без подтверждения остаётся оранжевым (хардкод не тронут)', async () => {
    const container = await renderStatusNode({ unreadCount: 2 })

    const label = labelSpan(container)!
    expect(label.classList.contains('text-orange-400')).toBe(true)
    expect(statusDot(container)).toBeNull()
  })

  it('у существующих статусов точка окрашена токеном темы и подписана', async () => {
    const streaming = await renderStatusNode({ status: 'streaming' })
    const streamingDot = statusDot(streaming)!
    expect(streamingDot.classList.contains('bg-status-info')).toBe(true)
    expect(streamingDot.getAttribute('aria-label')).toBe('Streaming')

    const blocked = await renderStatusNode({ status: 'blocked' })
    const blockedDot = statusDot(blocked)!
    expect(blockedDot.classList.contains('bg-destructive')).toBe(true)
    expect(blockedDot.getAttribute('aria-label')).toBe('Blocked')
  })
})
