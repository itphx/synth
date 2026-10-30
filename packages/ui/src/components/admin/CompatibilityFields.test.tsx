import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  draftFromCompatibility,
  emptyCompatibilityDraft,
  type CompatibilityDraft,
} from '@/lib/api/compatibility'
import { CompatibilityFields } from './CompatibilityFields'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderFields(draft: CompatibilityDraft, saved = true): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <CompatibilityFields draft={draft} onChange={() => {}} saved={saved} />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
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

describe('CompatibilityFields: новые поля (cacheFormat, requireFinishReason)', () => {
  it('в свёрнутом блоке новых контролов нет, в развёрнутом — «авто» по умолчанию', async () => {
    const collapsed = await renderFields(emptyCompatibilityDraft(), false)
    expect(collapsed.querySelector('[data-testid="compatibility-panel"]')).toBeNull()
    expect(collapsed.querySelector('[data-testid="compatibility-cache-format"]')).toBeNull()

    const container = await renderFields(emptyCompatibilityDraft())
    const cacheFormat = container.querySelector('[data-testid="compatibility-cache-format"]')
    const requireFinishReason = container.querySelector(
      '[data-testid="compatibility-require-finish-reason"]',
    )
    expect(cacheFormat).toBeTruthy()
    expect(requireFinishReason).toBeTruthy()
    expect(cacheFormat!.textContent).toContain('Auto (prompt_cache_key)')
    expect(requireFinishReason!.textContent).toContain('Auto (Yes)')
  })

  it('сохранённые значения показываются в триггерах, «сброс» снова даёт «авто»', async () => {
    const saved = draftFromCompatibility({ cacheFormat: 'anthropic', requireFinishReason: false })
    const container = await renderFields(saved)
    expect(
      container.querySelector('[data-testid="compatibility-cache-format"]')!.textContent,
    ).toContain('anthropic')
    expect(
      container.querySelector('[data-testid="compatibility-require-finish-reason"]')!.textContent,
    ).toContain('No')

    const reset = await renderFields(emptyCompatibilityDraft())
    expect(
      reset.querySelector('[data-testid="compatibility-cache-format"]')!.textContent,
    ).toContain('Auto (prompt_cache_key)')
    expect(
      reset.querySelector('[data-testid="compatibility-require-finish-reason"]')!.textContent,
    ).toContain('Auto (Yes)')
  })
})
