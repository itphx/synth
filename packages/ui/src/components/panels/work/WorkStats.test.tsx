import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { InvariantsEditor } from './InvariantsEditor'
import { WorkStats } from './WorkStats'

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

describe('InvariantsEditor: правка инвариантов', () => {
  it('рисует Markdown-редактор с текущим текстом и лимитом', async () => {
    const container = await render(<InvariantsEditor value="Правило" onSave={() => {}} testId="inv" />)
    const textarea = container.querySelector('[data-testid="inv-markdown-textarea"]') as HTMLTextAreaElement
    expect(textarea.value).toBe('Правило')
    const counter = container.querySelector('[data-testid="inv-markdown-counter"]')!
    expect(counter.textContent).toContain('65536')
  })

  it('сохранение отдаёт изменённый текст', async () => {
    const saved: string[] = []
    const container = await render(
      <InvariantsEditor value="старое" onSave={(v) => saved.push(v)} testId="inv" />,
    )
    const textarea = container.querySelector('[data-testid="inv-markdown-textarea"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'новое')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="inv-markdown-save"]') as HTMLButtonElement).click()
    })
    expect(saved).toEqual(['новое'])
  })

  it('read-only: сохранение недоступно', async () => {
    const container = await render(
      <InvariantsEditor value="текст" onSave={() => {}} readOnly testId="inv" />,
    )
    expect((container.querySelector('[data-testid="inv-markdown-save"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('WorkStats: счётчики плана, ToDo и журнала', () => {
  const plan = {
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
    columns: [
      { id: 'c1', name: 'Backlog', order: 0 },
      { id: 'c2', name: 'Done', order: 1 },
    ],
    items: [
      {
        id: 'i1',
        title: 'a',
        columnId: 'c1',
        priority: 'high' as const,
        order: 0,
        dependsOn: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        id: 'i2',
        title: 'b',
        columnId: 'c2',
        priority: 'low' as const,
        order: 0,
        dependsOn: [],
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  }

  it('план: всего, по колонкам и по приоритетам', async () => {
    const container = await render(<WorkStats plan={plan} testId="stats" />)
    expect(container.querySelector('[data-testid="work-stats-plan-total"]')!.textContent).toContain('2')
    expect(container.querySelector('[data-testid="work-stats-plan-column-c1"]')!.textContent).toContain('1')
    expect(container.querySelector('[data-testid="work-stats-plan-priority-high"]')!.textContent).toContain('1')
    // Прогресс: один пункт в «Done» из двух → 50 %.
    expect(container.querySelector('[data-testid="work-stats-plan-progress"]')!.textContent).toContain('50')
  })

  it('ToDo: счётчики по статусам', async () => {
    const container = await render(
      <WorkStats
        todos={[
          { id: 't1', content: 'a', status: 'pending', priority: 'medium' },
          { id: 't2', content: 'b', status: 'completed', priority: 'medium' },
        ]}
        testId="stats"
      />,
    )
    expect(container.querySelector('[data-testid="work-stats-todos-total"]')!.textContent).toContain('2')
    expect(container.querySelector('[data-testid="work-stats-todos-status-completed"]')!.textContent).toContain('1')
    expect(container.querySelector('[data-testid="work-stats-todos-priority-medium"]')!.textContent).toContain('2')
  })

  it('журнал: записи по авторам и дням', async () => {
    const container = await render(
      <WorkStats
        journalEntries={[
          { id: 'e1', text: 'a', created_at: '2026-11-01T10:00:00.000Z', author: 'leader' },
          { id: 'e2', text: 'b', created_at: '2026-11-02T10:00:00.000Z', author: 'leader' },
        ]}
        journalTotal={2}
        testId="stats"
      />,
    )
    expect(container.querySelector('[data-testid="work-stats-journal-total"]')!.textContent).toContain('2')
    expect(container.querySelector('[data-testid="work-stats-journal-author-leader"]')!.textContent).toContain('2')
    expect(container.querySelector('[data-testid="work-stats-journal-day-2026-11-01"]')!.textContent).toContain('1')
  })
})
