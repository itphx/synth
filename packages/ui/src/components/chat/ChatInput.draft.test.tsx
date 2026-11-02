import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onCreateNote: vi.fn(),
  uploadSessionAttachment: vi.fn(),
  prepareAttachmentFiles: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getCommands: mocks.getCommands } }))
vi.mock('@/lib/attachments/prepare', () => ({
  prepareAttachmentFiles: mocks.prepareAttachmentFiles,
}))
vi.mock('@/lib/api/attachments', () => ({
  uploadSessionAttachment: mocks.uploadSessionAttachment,
  attachmentContentUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}`,
  attachmentThumbnailUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}?variant=thumb`,
  attachmentContentUrlFromThumb: (thumbUrl: string) => {
    const suffix = '?variant=thumb'
    return thumbUrl.endsWith(suffix) ? thumbUrl.slice(0, -suffix.length) : undefined
  },
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
import { COMPOSER_DRAFTS_KEY, clearAllComposerDrafts } from '@/lib/composer-drafts'
import { ChatInput } from './ChatInput'
import { useChatStore } from '@/stores/chatStore'
import { useSkillsStore } from '@/stores/skillsStore'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { useProvidersStore } from '@/stores/providersStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

interface MountedInput {
  container: HTMLElement
  unmount: () => Promise<void>
}

async function renderInput(sessionId = SESSION): Promise<MountedInput> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChatInput
          sessionId={sessionId}
          agents={[]}
          isStreaming={false}
          onSend={mocks.onSend}
          onStop={mocks.onStop}
          onCreateNote={mocks.onCreateNote}
        />
      </I18nProvider>,
    )
  })
  await flush()
  return {
    container,
    unmount: async () => {
      const index = roots.findIndex((entry) => entry.root === root)
      if (index >= 0) roots.splice(index, 1)
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
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

async function uploadFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement
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

/** Кнопка отправки: подпись зависит от состояния вложений. */
function sendButton(container: HTMLElement): HTMLButtonElement {
  const titles = [
    enDict['chat.input.send'],
    enDict['chat.attachments.waitUpload'],
    enDict['chat.attachments.fixErrors'],
  ]
  return Array.from(container.querySelectorAll('button')).find((element) =>
    titles.includes(element.getAttribute('title') ?? ''),
  ) as HTMLButtonElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: [], diagnostics: [] })
  mocks.onSend.mockResolvedValue(undefined)
  mocks.uploadSessionAttachment.mockImplementation(async (_sessionId: string, file: File) => ({
    id: `srv_${file.name}`,
    blobPath: `attachments/ab/${file.name}`,
    sha256: 'sha',
    mime: file.type || 'text/plain',
    size: file.size,
  }))
  mocks.prepareAttachmentFiles.mockImplementation(async (file: File) => [
    { file, mimeType: file.type || 'text/plain' },
  ])
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock'),
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
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

describe('ChatInput — черновик композера', () => {
  it('текст переживает unmount и новое монтирование с тем же sessionId', async () => {
    const first = await renderInput()
    setTextareaValue(textareaOf(first.container), 'черновик')
    await flush()

    await first.unmount()

    const second = await renderInput()
    expect(textareaOf(second.container).value).toBe('черновик')
  })

  it('черновик пишется в localStorage (после flush)', async () => {
    const { container } = await renderInput()
    setTextareaValue(textareaOf(container), 'в хранилище')
    await flush()

    useComposerDraftsStore.getState().flush()

    const raw = localStorage.getItem(COMPOSER_DRAFTS_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).drafts[SESSION].text).toBe('в хранилище')
  })

  it('успешная отправка очищает текст и вложения', async () => {
    const { container } = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = textareaOf(container)

    await uploadFile(input, new File(['hello'], 'a.txt', { type: 'text/plain' }))
    setTextareaValue(textarea, 'отправь')
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBeUndefined()
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(0)
  })

  it('ошибка отправки оставляет текст и вложения в композере', async () => {
    mocks.onSend.mockRejectedValue(new Error('boom'))

    const { container } = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = textareaOf(container)

    await uploadFile(input, new File(['hello'], 'a.txt', { type: 'text/plain' }))
    setTextareaValue(textarea, 'не потеряй')
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('не потеряй')
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBe('не потеряй')
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(1)
  })

  it('ошибка загрузки вложения блокирует отправку и показывает ошибку', async () => {
    mocks.uploadSessionAttachment.mockRejectedValue(new Error('boom'))

    const { container } = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = textareaOf(container)

    await uploadFile(input, new File(['hello'], 'a.txt', { type: 'text/plain' }))
    setTextareaValue(textarea, 'не отправляй')
    await flush()

    expect(useAttachmentsStore.getState().hasFailed(SESSION)).toBe(true)

    const button = sendButton(container)
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe(enDict['chat.attachments.fixErrors'])

    await act(async () => {
      button.click()
    })
    await flush()
    expect(mocks.onSend).not.toHaveBeenCalled()

    // Один тост об ошибке загрузки (ошибка видна и в чипе).
    const errorToasts = mocks.notifyMessage.mock.calls
      .map(([options]) => options as Record<string, unknown>)
      .filter((options) => options.type === 'error')
    expect(errorToasts).toHaveLength(1)
    expect(errorToasts[0]!.text).toBe(enDict['chat.attachments.error.upload'])
    expect(errorToasts[0]!.category).toBe('error')
    expect(errorToasts[0]!.sessionId).toBe(SESSION)
  })
})
