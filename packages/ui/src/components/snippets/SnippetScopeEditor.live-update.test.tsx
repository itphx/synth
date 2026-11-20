import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Редактор сниппетов уровня и событие шины `snippets.updated` (ADR-126 §4).
 *
 * Баг: «создал сниппет в настройках — а в соседней вкладке/панели проекта его
 * нет, пока не перезагрузишь страницу». Причина — список грузился один раз на
 * монтировании и перечитывался только после собственных действий.
 */
const mocks = vi.hoisted(() => ({
  listSnippets: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
}))

vi.mock('@/lib/api/snippets', () => ({ snippetsApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SnippetScopeEditor } from './SnippetScopeEditor'
import { useSnippetsStore } from '@/stores/snippetsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function snippet(name: string, body = `${name} text`) {
  return {
    name,
    description: `${name} description`,
    aliases: [],
    body,
    scope: 'user' as const,
    file: `/data/snippets/${name}.md`,
    trusted: true,
  }
}

const byTestId = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

async function flush(): Promise<void> {
  await act(async () => {})
}

/** Ввод в контролируемое поле: React слушает нативный `input`. */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setValue?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function renderEditor(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SnippetScopeEditor scope="user" canEdit />
      </I18nProvider>,
    )
  })
  await flush()
  await flush()
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
})

describe('SnippetScopeEditor — живое обновление реестра', () => {
  it('рост revision перечитывает список: новый сниппет появляется', async () => {
    const container = await renderEditor()

    expect(mocks.listSnippets).toHaveBeenCalledTimes(1)
    expect(byTestId(container, 'snippet-signoff')).toBeTruthy()
    expect(byTestId(container, 'snippet-signature')).toBeNull()

    // Сниппет создали в соседней вкладке (или тулом из чата) — пришло событие.
    mocks.listSnippets.mockResolvedValue({
      snippets: [snippet('signoff'), snippet('signature')],
    })
    await act(async () => {
      useSnippetsStore.getState().applyEvent()
    })
    await flush()
    await flush()

    expect(mocks.listSnippets).toHaveBeenCalledTimes(2)
    expect(byTestId(container, 'snippet-signature')).toBeTruthy()
  })

  it('удалённый в другом клиенте сниппет исчезает по событию', async () => {
    mocks.listSnippets.mockResolvedValue({
      snippets: [snippet('signoff'), snippet('signature')],
    })
    const container = await renderEditor()
    expect(byTestId(container, 'snippet-signature')).toBeTruthy()

    mocks.listSnippets.mockResolvedValue({ snippets: [snippet('signoff')] })
    await act(async () => {
      useSnippetsStore.getState().applyEvent()
    })
    await flush()
    await flush()

    expect(byTestId(container, 'snippet-signature')).toBeNull()
  })

  it('недописанный сниппет в форме не сбрасывается событием', async () => {
    const container = await renderEditor()

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    const nameField = inputs[0]!
    const bodyField = container.querySelector('textarea') as HTMLTextAreaElement
    await typeInto(nameField, 'draft-name')
    await typeInto(bodyField, 'draft body text')
    expect(nameField.value).toBe('draft-name')

    // Чужая мутация: список перечитан, ввод пользователя на месте.
    mocks.listSnippets.mockResolvedValue({ snippets: [snippet('signoff'), snippet('signature')] })
    await act(async () => {
      useSnippetsStore.getState().applyEvent()
    })
    await flush()
    await flush()

    expect(mocks.listSnippets).toHaveBeenCalledTimes(2)
    expect(byTestId(container, 'snippet-signature')).toBeTruthy()
    expect((container.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('draft-name')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'draft body text',
    )
  })

  it('первый рендер не дублирует загрузку (revision сравнивается со своим значением)', async () => {
    await renderEditor()
    await act(async () => {})

    expect(mocks.listSnippets).toHaveBeenCalledTimes(1)
  })
})
