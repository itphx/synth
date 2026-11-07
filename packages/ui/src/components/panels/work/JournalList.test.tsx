import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { JournalList } from './JournalList'
import type { ProjectLogEntryDto } from '@/lib/api/synthApi'

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

const ENTRY: ProjectLogEntryDto = {
  id: 'e1',
  text: 'Первая запись',
  created_at: '2026-11-01T10:00:00.000Z',
  session_id: 's1',
  author: 'leader',
}

describe('JournalList: журнал проекта', () => {
  it('пустое состояние, когда записей нет', async () => {
    const container = await render(<JournalList entries={[]} testId="jl" />)
    expect(container.querySelector('[data-testid="jl"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="journal-empty"]')!.textContent).toBe('No entries')
  })

  it('запись показывает автора, дату и текст', async () => {
    const container = await render(<JournalList entries={[ENTRY]} total={1} testId="jl" />)
    const entry = container.querySelector('[data-testid="journal-entry-e1"]')!
    expect(entry.textContent).toContain('leader')
    expect(entry.textContent).toContain('11/01/2026')
    expect(container.querySelector('[data-testid="journal-entry-e1-text"]')!.textContent).toContain('Первая запись')
  })

  it('пагинация: кнопка «Показать ещё» зовёт onLoadMore', async () => {
    const onLoadMore = vi.fn()
    const container = await render(
      <JournalList entries={[ENTRY]} total={120} hasMore onLoadMore={onLoadMore} testId="jl" />,
    )
    const button = container.querySelector('[data-testid="journal-load-more"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => {
      button.click()
    })
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('без hasMore кнопки пагинации нет', async () => {
    const container = await render(
      <JournalList entries={[ENTRY]} total={1} hasMore={false} onLoadMore={() => {}} testId="jl" />,
    )
    expect(container.querySelector('[data-testid="journal-load-more"]')).toBeNull()
  })

  it('добавление: форма → текст → onAdd', async () => {
    const onAdd = vi.fn()
    const container = await render(<JournalList entries={[]} onAdd={onAdd} testId="jl" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="journal-add"]') as HTMLButtonElement).click()
    })
    const textarea = container.querySelector('[data-testid="journal-add-textarea"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Новая запись')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="journal-add-save"]') as HTMLButtonElement).click()
    })
    expect(onAdd).toHaveBeenCalledWith('Новая запись')
  })

  it('правка: форма правки → onEdit с id и текстом', async () => {
    const onEdit = vi.fn()
    const container = await render(<JournalList entries={[ENTRY]} onEdit={onEdit} testId="jl" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="journal-entry-e1-edit"]') as HTMLButtonElement).click()
    })
    const textarea = container.querySelector('[data-testid="journal-entry-e1-textarea"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Исправленная запись')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="journal-entry-e1-save"]') as HTMLButtonElement).click()
    })
    expect(onEdit).toHaveBeenCalledWith('e1', 'Исправленная запись')
  })

  it('удаление зовёт onDelete с id', async () => {
    const onDelete = vi.fn()
    const container = await render(<JournalList entries={[ENTRY]} onDelete={onDelete} testId="jl" />)
    await act(async () => {
      ;(container.querySelector('[data-testid="journal-entry-e1-delete"]') as HTMLButtonElement).click()
    })
    expect(onDelete).toHaveBeenCalledWith('e1')
  })

  it('фильтры: смена автора зовёт onFiltersChange', async () => {
    const onFiltersChange = vi.fn()
    const container = await render(
      <JournalList
        entries={[]}
        authors={['leader', 'fixer']}
        filters={{}}
        onFiltersChange={onFiltersChange}
        testId="jl"
      />,
    )
    const select = container.querySelector('[data-testid="journal-filter-author"]') as HTMLSelectElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'fixer')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onFiltersChange).toHaveBeenCalledWith({ author: 'fixer' })
  })

  it('read-only: действий над записями нет', async () => {
    const container = await render(
      <JournalList entries={[ENTRY]} onEdit={() => {}} onDelete={() => {}} onAdd={() => {}} readOnly testId="jl" />,
    )
    expect(container.querySelector('[data-testid="journal-entry-e1-edit"]')).toBeNull()
    expect(container.querySelector('[data-testid="journal-add"]')).toBeNull()
  })
})
