import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectAccessBadge } from './ProjectAccessBadge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderBadge(
  visibility?: 'author' | 'selected' | 'all',
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProjectAccessBadge visibility={visibility} />
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

describe('ProjectAccessBadge (PROP-133 §4)', () => {
  it('«Только выбранным»: метка с подписью в aria-label/title', async () => {
    const container = await renderBadge('selected')

    const badge = container.querySelector('[data-testid="project-access-badge-selected"]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('aria-label')).toBe(enDict['project.access.badge.selected'])
    expect(badge?.getAttribute('title')).toBe(enDict['project.access.badge.selected'])
  })

  it('«Всем пользователям»: метка с подписью в aria-label/title', async () => {
    const container = await renderBadge('all')

    const badge = container.querySelector('[data-testid="project-access-badge-all"]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('aria-label')).toBe(enDict['project.access.badge.all'])
    expect(badge?.getAttribute('title')).toBe(enDict['project.access.badge.all'])
  })

  it('«Только автору»: метки нет — режим по умолчанию, шумить нечем', async () => {
    const container = await renderBadge('author')

    expect(container.querySelector('[data-testid^="project-access-badge-"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('без явного режима: метки нет', async () => {
    const container = await renderBadge(undefined)

    expect(container.querySelector('[data-testid^="project-access-badge-"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })
})
