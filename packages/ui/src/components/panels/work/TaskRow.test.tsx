import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TaskRow } from './TaskRow'

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

describe('TaskRow: строка пункта (план/ToDo)', () => {
  it('рисует статус, заголовок и приоритет', async () => {
    const container = await render(
      <TaskRow title="Собрать API" status="In progress" priority="high" testId="row" />,
    )
    expect(container.querySelector('[data-testid="row-title"]')!.textContent).toBe('Собрать API')
    expect(container.querySelector('[data-testid="row-status"]')!.textContent).toBe('In progress')
    expect(container.querySelector('[data-testid="row-priority"]')!.textContent).toBe('High')
  })

  it('свёрнутый пункт: описание — plain-превью (без разметки)', async () => {
    const container = await render(
      <TaskRow title="Пункт" body={'**жирный** описание'} testId="row" />,
    )
    const preview = container.querySelector('[data-testid="row-preview"]')!
    expect(preview.getAttribute('data-markdown-mode')).toBe('plain')
    expect(preview.textContent).toContain('жирный описание')
    expect(preview.textContent).not.toContain('**')
  })

  it('showPreview=false: свёрнутая строка не дублирует body (ToDo)', async () => {
    const container = await render(
      <TaskRow title="Текст задачи" body="Текст задачи" showPreview={false} testId="row" />,
    )
    expect(container.querySelector('[data-testid="row-preview"]')).toBeNull()
    expect(container.querySelector('[data-testid="row-title"]')!.textContent).toBe('Текст задачи')
  })

  it('раскрытый пункт: описание рендерится markdown-ом', async () => {
    const container = await render(
      <TaskRow title="Пункт" body={'**жирный** описание'} testId="row" />,
    )
    const toggle = container.querySelector('[data-testid="row-expand"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = container.querySelector('[data-testid="row-body"]')!
    expect(body.querySelector('strong')?.textContent).toBe('жирный')
  })

  it('действия: изменить/переместить/удалить зовут обработчики', async () => {
    const onEdit = vi.fn()
    const onMove = vi.fn()
    const onDelete = vi.fn()
    const container = await render(
      <TaskRow title="Пункт" onEdit={onEdit} onMove={onMove} onDelete={onDelete} testId="row" />,
    )
    await act(async () => {
      ;(container.querySelector('[data-testid="row-edit"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="row-move"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="row-delete"]') as HTMLButtonElement).click()
    })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('read-only: действий нет', async () => {
    const container = await render(
      <TaskRow title="Пункт" onEdit={() => {}} onDelete={() => {}} readOnly testId="row" />,
    )
    expect(container.querySelector('[data-testid="row-actions"]')).toBeNull()
  })

  it('тач-меню перемещения: список целей, выбор зовёт onMoveTo', async () => {
    const onMoveTo = vi.fn()
    const container = await render(
      <TaskRow
        title="Пункт"
        moveTargets={[
          { id: 'col-1', label: 'Backlog' },
          { id: 'col-2', label: 'Done' },
        ]}
        onMoveTo={onMoveTo}
        testId="row"
      />,
    )
    await act(async () => {
      ;(container.querySelector('[data-testid="row-move"]') as HTMLButtonElement).click()
    })
    const menu = container.querySelector('[data-testid="row-move-menu"]')!
    expect(menu.getAttribute('role')).toBe('menu')
    await act(async () => {
      ;(container.querySelector('[data-testid="row-move-col-2"]') as HTMLButtonElement).click()
    })
    expect(onMoveTo).toHaveBeenCalledWith('col-2')
    expect(container.querySelector('[data-testid="row-move-menu"]')).toBeNull()
  })

  it('без описания и деталей кнопки раскрытия нет', async () => {
    const container = await render(<TaskRow title="Пункт" testId="row" />)
    expect(container.querySelector('[data-testid="row-expand"]')).toBeNull()
  })
})
