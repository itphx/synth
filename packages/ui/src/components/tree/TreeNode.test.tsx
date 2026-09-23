import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TreeNode } from './TreeNode'
import type { TreeAction } from './types'

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
