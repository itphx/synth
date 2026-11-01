/**
 * StickyNotesPanel: счётчик заметок с лимитом инстанса.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { StickyNotesPanel } from './StickyNotesPanel'
import { resetStickyNotesLimitsCache } from '@/lib/api/stickyNotesLimits'
import type { StickyNoteData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function note(id: string, disabled = false): StickyNoteData {
  return {
    id,
    content: `заметка ${id}`,
    created_at: '2026-11-02T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    disabled,
  }
}

async function renderPanel(notes: StickyNoteData[]): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <StickyNotesPanel
          notes={notes}
          onUpdate={vi.fn()}
          onToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  resetStickyNotesLimitsCache({ maxCount: 3, maxChars: 100 })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  resetStickyNotesLimitsCache()
  document.body.innerHTML = ''
})

describe('StickyNotesPanel — счётчик с лимитом', () => {
  it('показывает активные/лимит (N/max)', async () => {
    const container = await renderPanel([note('n1'), note('n2', true)])
    expect(container.querySelector('[data-testid="sticky-notes-counter"]')?.textContent).toBe(
      'Notes: 1/3',
    )
    expect(container.querySelector('[data-testid="sticky-notes-limit-badge"]')).toBeNull()
  })

  it('при достигнутом лимите показывает бейдж с подсказкой', async () => {
    const container = await renderPanel([note('n1'), note('n2'), note('n3')])
    const badge = container.querySelector('[data-testid="sticky-notes-limit-badge"]')
    expect(badge?.textContent).toBe('limit')
    expect(badge?.getAttribute('title')).toBe('Note limit reached: 3')
  })

  it('без загруженного лимита показывает только количество', async () => {
    resetStickyNotesLimitsCache()
    const container = await renderPanel([note('n1')])
    expect(container.querySelector('[data-testid="sticky-notes-counter"]')?.textContent).toBe(
      'Notes: 1',
    )
    expect(container.querySelector('[data-testid="sticky-notes-limit-badge"]')).toBeNull()
  })
})
