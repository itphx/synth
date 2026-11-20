import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * `#`-пикер сниппетов и событие шины `snippets.updated` (ADR-126 §4).
 *
 * Баг: «создал сниппет — а в подсказках композера его нет, пока не
 * перезагрузишь страницу». Причина — реестр тянулся один раз (эффект только по
 * `projectId`); после первой загрузки пикер больше не перечитывал список.
 */
const mocks = vi.hoisted(() => ({
  listSnippets: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SnippetAutocomplete } from './SnippetAutocomplete'
import { useSnippetsStore } from '@/stores/snippetsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function snippet(name: string) {
  return {
    name,
    description: `${name} description`,
    aliases: [],
    body: `${name} text`,
    scope: 'user' as const,
    file: `/data/snippets/${name}.md`,
    trusted: true,
  }
}

async function renderPicker(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SnippetAutocomplete
          query=""
          position={{ left: 0 }}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  useSnippetsStore.setState({ revision: 0 })
  mocks.listSnippets.mockResolvedValue({ snippets: [snippet('signoff')] })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('SnippetAutocomplete — живое обновление реестра', () => {
  it('после события snippets.updated список перечитывается без перезагрузки', async () => {
    const container = await renderPicker()
    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-signoff"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-signature"]'),
    ).toBeNull()
    const callsBefore = mocks.listSnippets.mock.calls.length

    // Сниппет создан в настройках или тулом из чата: шина подняла revision.
    mocks.listSnippets.mockResolvedValue({
      snippets: [snippet('signoff'), snippet('signature')],
    })
    await act(async () => {
      useSnippetsStore.getState().applyEvent()
    })
    await act(async () => {})

    expect(mocks.listSnippets.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-signature"]'),
    ).not.toBeNull()
  })

  it('удалённый сниппет исчезает из подсказок по событию', async () => {
    mocks.listSnippets.mockResolvedValue({
      snippets: [snippet('signoff'), snippet('signature')],
    })
    const container = await renderPicker()
    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-signature"]'),
    ).not.toBeNull()

    mocks.listSnippets.mockResolvedValue({ snippets: [snippet('signoff')] })
    await act(async () => {
      useSnippetsStore.getState().applyEvent()
    })
    await act(async () => {})

    expect(
      container.querySelector('[data-testid="snippet-autocomplete-item-signature"]'),
    ).toBeNull()
  })

  it('проект сессии уходит в запрос реестра', async () => {
    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, container })
    await act(async () => {
      root.render(
        <I18nProvider>
          <SnippetAutocomplete
            query=""
            position={{ left: 0 }}
            onSelect={() => {}}
            onClose={() => {}}
            projectId="proj_1"
          />
        </I18nProvider>,
      )
    })
    await act(async () => {})

    expect(mocks.listSnippets).toHaveBeenCalledWith({ projectId: 'proj_1' })
  })
})
