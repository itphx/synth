/**
 * ChatInput: instance-wide лимиты заметок.
 *
 * Слишком длинная заметка не создаётся локально (сервер ответил бы 400), а у
 * предела количества кнопка «Создать заметку» гаснет. Лимиты приходят из
 * `useStickyNotesLimitsState` (кэш на модуль, деградация к дефолту 50/2000).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCreateNote: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getCommands: mocks.getCommands } }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notifyMessage,
  useNotification: () => ({ notify: vi.fn() }),
}))
vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('../ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./AgentModeSelector', () => ({ AgentModeSelector: () => null }))
vi.mock('./PlanActModeToggle', () => ({ PlanActModeToggle: () => null }))
vi.mock('./ReasoningLevelSelector', () => ({ ReasoningLevelSelector: () => null }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ChatInput } from './ChatInput'
import { useChatStore } from '@/stores/chatStore'
import { useSkillsStore } from '@/stores/skillsStore'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useProvidersStore } from '@/stores/providersStore'
import { resetStickyNotesLimitsCache } from '@/lib/api/stickyNotesLimits'
import type { StickyNoteData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderInput(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatInput
          sessionId={SESSION}
          agents={[]}
          isStreaming={false}
          onSend={mocks.onSend}
          onStop={mocks.onStop}
          onCreateNote={mocks.onCreateNote}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function noteButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    (element.getAttribute('title') ?? '').startsWith('Create note') ||
    (element.getAttribute('title') ?? '').startsWith('Note limit reached'),
  )
  return button as HTMLButtonElement
}

function note(id: string, disabled = false): StickyNoteData {
  return {
    id,
    content: `заметка ${id}`,
    created_at: '2026-11-02T00:00:00.000Z',
    updated_at: '2026-11-02T00:00:00.000Z',
    disabled,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: [], diagnostics: [] })
  useChatStore.setState({ retryInputBySession: {}, stickyNotesBySession: {} })
  useSkillsStore.setState({ commands: null, commandsLoading: false, commandsError: null })
  useProvidersStore.setState({
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
    modelGroups: [],
  })
  useAttachmentsStore.setState({ bySession: {} })
  resetStickyNotesLimitsCache({ maxCount: 2, maxChars: 10 })
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

describe('ChatInput — лимиты заметок', () => {
  it('заметка длиннее maxChars не создаётся и сопровождается сообщением', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'слишком длинная заметка')
    })

    await act(async () => {
      noteButton(container).click()
    })

    expect(mocks.onCreateNote).not.toHaveBeenCalled()
    expect(mocks.notifyMessage).toHaveBeenCalledTimes(1)
    expect(mocks.notifyMessage.mock.calls[0]![0]).toMatchObject({
      text: 'The note is too long: maximum 10 characters',
      type: 'warning',
    })
    // Ввод не теряется — пользователь может сократить заметку.
    expect(textarea.value).toBe('слишком длинная заметка')
  })

  it('в пределах maxChars заметка создаётся', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'коротко')
    })
    await act(async () => {
      noteButton(container).click()
    })

    expect(mocks.onCreateNote).toHaveBeenCalledWith('коротко')
    expect(mocks.notifyMessage).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
  })

  it('ровно maxChars — граница включительная, заметка создаётся', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, '0123456789')
    })
    await act(async () => {
      noteButton(container).click()
    })

    expect(mocks.onCreateNote).toHaveBeenCalledWith('0123456789')
    expect(mocks.notifyMessage).not.toHaveBeenCalled()
  })

  it('при достигнутом лимите количества кнопка disabled с лимитом в title', async () => {
    useChatStore.setState({
      stickyNotesBySession: { [SESSION]: [note('n1'), note('n2', true)] },
    })
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'ещё одна')
    })

    const button = noteButton(container)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Note limit reached (2)')

    await act(async () => {
      button.click()
    })
    expect(mocks.onCreateNote).not.toHaveBeenCalled()
  })
})
