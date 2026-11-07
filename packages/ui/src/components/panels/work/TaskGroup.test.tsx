import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TaskGroup } from './TaskGroup'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
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

describe('TaskGroup: группа пунктов (колонка/статус)', () => {
  it('рисует название, счётчик и WIP', async () => {
    const container = await render(
      <TaskGroup title="Backlog" count={3} wip={{ current: 3, limit: 5 }} testId="grp">
        <div>item</div>
      </TaskGroup>,
    )
    expect(container.querySelector('[data-testid="grp-title"]')!.textContent).toBe('Backlog')
    expect(container.querySelector('[data-testid="grp-count"]')!.textContent).toBe('(3)')
    expect(container.querySelector('[data-testid="grp-wip"]')!.textContent).toBe('3/5')
  })

  it('свёрнутая группа не показывает содержимое', async () => {
    const container = await render(
      <TaskGroup title="Backlog" count={1} defaultCollapsed testId="grp">
        <div>item</div>
      </TaskGroup>,
    )
    expect(container.querySelector('[data-testid="grp-body"]')).toBeNull()
    const toggle = container.querySelector('[data-testid="grp-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('кнопка раскрытия показывает содержимое и зовёт onToggle', async () => {
    const onToggle = vi.fn()
    const container = await render(
      <TaskGroup title="Backlog" count={1} defaultCollapsed onToggle={onToggle} testId="grp">
        <div>item</div>
      </TaskGroup>,
    )
    expect(container.querySelector('[data-testid="grp-body"]')).toBeNull()
    const toggle = container.querySelector('[data-testid="grp-toggle"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    expect(onToggle).toHaveBeenCalledWith(false)
    expect(container.querySelector('[data-testid="grp-body"]')!.textContent).toContain('item')
  })

  it('пустая группа показывает подпись «пунктов нет» и не занимает место', async () => {
    const container = await render(<TaskGroup title="Backlog" count={0} testId="grp" />)
    expect(container.querySelector('[data-testid="grp-empty"]')!.textContent).toBe('No items')
  })

  it('кнопка «+» зовёт onAdd', async () => {
    const onAdd = vi.fn()
    const container = await render(<TaskGroup title="Backlog" count={0} onAdd={onAdd} testId="grp" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="grp-add"]') as HTMLButtonElement).click()
    })
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})
