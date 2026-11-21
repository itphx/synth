/**
 * Развёрнутый композер: после успешной отправки он сворачивается.
 *
 * Требование владельца: «после отправки развёрнутое поле ввода должно
 * сворачиваться» — экран возвращается к ленте, а не остаётся занятым полем
 * ввода на всю высоту. При ошибке отправки черновик и развёрнутый режим
 * сохраняются (повтор без потерь).
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
  onToggleExpand: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getCommands: mocks.getCommands } }))
vi.mock('@/lib/attachments/prepare', () => ({ prepareAttachmentFiles: vi.fn(async () => []) }))
vi.mock('@/lib/api/attachments', () => ({
  uploadSessionAttachment: vi.fn(),
  attachmentContentUrl: () => '',
  attachmentThumbnailUrl: () => '',
  attachmentContentUrlFromThumb: () => undefined,
}))
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
import { clearAllComposerDrafts } from '@/lib/composer-drafts'
import { ChatInput } from './ChatInput'
import { useChatStore } from '@/stores/chatStore'
import { useSkillsStore } from '@/stores/skillsStore'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { useProvidersStore } from '@/stores/providersStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderInput(options: { expanded: boolean }): Promise<HTMLElement> {
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
          expanded={options.expanded}
          onToggleExpand={mocks.onToggleExpand}
        />
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {})
  }
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pressEnter(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

/** vitest/jsdom в пакете не даёт localStorage — ставим in-memory заглушку. */
function installLocalStorage(): void {
  const data = new Map<string, string>()
  const storage = {
    get length(): number {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value))
    },
  } as Storage
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: [], diagnostics: [] })
  mocks.onSend.mockResolvedValue(undefined)
  useChatStore.setState({ retryInputBySession: {} })
  useSkillsStore.setState({ commands: null, commandsLoading: false, commandsError: null })
  useAttachmentsStore.setState({ bySession: {} })
  useProvidersStore.setState({
    models: [],
    selectedProviderName: null,
    selectedModelName: null,
    modelGroups: [],
  })
  installLocalStorage()
  clearAllComposerDrafts()
  useComposerDraftsStore.setState({ textBySession: {} })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  useAttachmentsStore.setState({ bySession: {} })
  clearAllComposerDrafts()
  useComposerDraftsStore.setState({ textBySession: {} })
  vi.clearAllMocks()
})

describe('ChatInput — развёрнутый композер сворачивается после отправки', () => {
  it('успешная отправка в развёрнутом режиме вызывает onToggleExpand', async () => {
    const container = await renderInput({ expanded: true })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    setTextareaValue(textarea, 'привет')
    await flush()
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(mocks.onToggleExpand).toHaveBeenCalledTimes(1)
  })

  it('ошибка отправки сохраняет развёрнутый режим и текст', async () => {
    mocks.onSend.mockRejectedValueOnce(new Error('network'))
    const container = await renderInput({ expanded: true })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    setTextareaValue(textarea, 'важное')
    await flush()
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(mocks.onToggleExpand).not.toHaveBeenCalled()
    expect(textarea.value).toBe('важное')
  })

  it('в обычном режиме onToggleExpand не вызывается', async () => {
    const container = await renderInput({ expanded: false })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    setTextareaValue(textarea, 'обычное')
    await flush()
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(mocks.onToggleExpand).not.toHaveBeenCalled()
  })
})
