import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PlanBoard } from './PlanBoard'

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

const PLAN = {
  version: 3,
  updatedAt: '2026-11-01T00:00:00.000Z',
  columns: [
    { id: 'col-backlog', name: 'Backlog', order: 0, wipLimit: 5 },
    { id: 'col-doing', name: 'Doing', order: 1 },
  ],
  items: [
    {
      id: 'item-1',
      title: 'Собрать API',
      description: '**важно**',
      columnId: 'col-backlog',
      priority: 'high' as const,
      order: 0,
      dependsOn: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'item-2',
      title: 'Второй пункт',
      columnId: 'col-doing',
      priority: 'low' as const,
      order: 0,
      dependsOn: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
}

/** Минимальный `DataTransfer` для jsdom (настоящего нет). */
function fakeDataTransfer() {
  const store = new Map<string, string>()
  return {
    effectAllowed: '',
    setData: (key: string, value: string) => {
      store.set(key, value)
    },
    getData: (key: string) => store.get(key) ?? '',
  }
}

/** Событие drag/drop с подставленным `dataTransfer`. */
function dragEvent(type: string, dataTransfer: ReturnType<typeof fakeDataTransfer>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

describe('PlanBoard: kanban-доска плана', () => {
  it('рисует колонки горизонтально и раскладывает пункты по колонкам', async () => {
    const container = await render(<PlanBoard plan={PLAN} testId="board" />)
    const columns = container.querySelector('[data-testid="board-columns"]')!
    expect(columns.className).toContain('overflow-x-auto')
    expect(container.querySelector('[data-testid="board-column-col-backlog"]')).not.toBeNull()
    const backlog = container.querySelector('[data-testid="board-column-col-backlog"]')!
    expect(backlog.querySelector('[data-testid="board-item-item-1"]')).not.toBeNull()
    expect(backlog.querySelector('[data-testid="board-item-item-2"]')).toBeNull()
    const doing = container.querySelector('[data-testid="board-column-col-doing"]')!
    expect(doing.querySelector('[data-testid="board-item-item-2"]')).not.toBeNull()
  })

  it('показывает WIP-индикатор колонки', async () => {
    const container = await render(<PlanBoard plan={PLAN} testId="board" />)
    expect(container.querySelector('[data-testid="board-column-col-backlog-wip"]')!.textContent).toBe('1/5')
  })

  it('тач-меню перемещения: выбор колонки зовёт onMoveItem', async () => {
    const onMoveItem = vi.fn()
    const container = await render(<PlanBoard plan={PLAN} onMoveItem={onMoveItem} testId="board" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="board-item-item-1-move"]') as HTMLButtonElement).click()
    })
    const menu = container.querySelector('[data-testid="board-item-item-1-menu"]')!
    expect(menu.getAttribute('role')).toBe('menu')
    await act(async () => {
      ;(container.querySelector('[data-testid="board-item-item-1-move-col-doing"]') as HTMLButtonElement).click()
    })
    expect(onMoveItem).toHaveBeenCalledWith('item-1', 'col-doing')
  })

  it('native HTML5 drag & drop: перетаскивание карточки в колонку', async () => {
    const onMoveItem = vi.fn()
    const container = await render(<PlanBoard plan={PLAN} onMoveItem={onMoveItem} testId="board" />)
    const card = container.querySelector('[data-testid="board-item-item-1"]') as HTMLElement
    const target = container.querySelector('[data-testid="board-column-col-doing"]') as HTMLElement
    const dataTransfer = fakeDataTransfer()

    await act(async () => {
      card.dispatchEvent(dragEvent('dragstart', dataTransfer))
    })
    expect(dataTransfer.getData('text/plain')).toBe('item-1')

    await act(async () => {
      target.dispatchEvent(dragEvent('dragover', dataTransfer))
      target.dispatchEvent(dragEvent('drop', dataTransfer))
    })
    expect(onMoveItem).toHaveBeenCalledWith('item-1', 'col-doing')
  })

  it('read-only: карточки не перетаскиваются, действий нет', async () => {
    const container = await render(<PlanBoard plan={PLAN} readOnly testId="board" />)
    const card = container.querySelector('[data-testid="board-item-item-1"]') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('false')
    expect(container.querySelector('[data-testid="board-item-item-1-move"]')).toBeNull()
  })

  it('быстрое добавление: ввод названия и Enter зовут onAddItem', async () => {
    const onAddItem = vi.fn()
    const container = await render(<PlanBoard plan={PLAN} onAddItem={onAddItem} testId="board" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="board-column-col-doing-add"]') as HTMLButtonElement).click()
    })
    const input = container.querySelector('[data-testid="board-column-col-doing-quick-input"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Новый пункт')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onAddItem).toHaveBeenCalledWith('col-doing', 'Новый пункт')
  })

  it('удаление колонки зовёт onDeleteColumn', async () => {
    const onDeleteColumn = vi.fn()
    const container = await render(
      <PlanBoard plan={PLAN} onDeleteColumn={onDeleteColumn} testId="board" />,
    )
    const button = container.querySelector('[data-testid="board-column-col-backlog-delete"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => {
      button.click()
    })
    expect(onDeleteColumn).toHaveBeenCalledWith('col-backlog')
  })

  it('пустой план показывает пустое состояние', async () => {
    const container = await render(<PlanBoard plan={null} testId="board" />)
    expect(container.querySelector('[data-testid="board-empty"]')).not.toBeNull()
  })
})
