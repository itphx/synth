/**
 * ADR-118 §3: отправка сообщения — один раз на попытку.
 *
 * Симптом (репорт владельца): интерфейс «молчал» во время отправки, пользователь
 * жал «Отправить» ещё 2–3 раза — в чат приходило несколько одинаковых сообщений.
 * Композер обязан:
 *   • показывать, что нажатие принято (индикатор + `aria-busy` на кнопке);
 *   • игнорировать повторный клик и повторный Enter во время попытки;
 *   • снимать индикатор в `finally` (в том числе при ошибке — не «залипать»);
 *   • держать **один** `streamId` на неудавшуюся попытку, чтобы повтор после
 *     ошибки не создал второе сообщение (дедуп на сервере — по этому id).
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

interface MountedInput {
  container: HTMLElement
  unmount: () => Promise<void>
}

/** Отложенное обещание: тест управляет моментом завершения отправки. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderInput(opts?: { isStreaming?: boolean }): Promise<MountedInput> {
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
          isStreaming={opts?.isStreaming ?? false}
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

/** Кнопка «Отправить» (в активном ходе — «В очередь»): подпись зависит от состояния. */
function sendButton(container: HTMLElement): HTMLButtonElement {
  const titles = [
    enDict['chat.input.send'],
    enDict['chat.input.enqueue'],
    enDict['chat.attachments.waitUpload'],
    enDict['chat.attachments.fixErrors'],
  ]
  return Array.from(container.querySelectorAll('button')).find((element) =>
    titles.includes(element.getAttribute('title') ?? ''),
  ) as HTMLButtonElement
}

/** `streamId` попытки из N-го вызова `onSend` (пятый аргумент). */
function streamIdOf(callIndex: number): string | undefined {
  const call = mocks.onSend.mock.calls[callIndex] as unknown[] | undefined
  const options = call?.[4] as { streamId?: string } | undefined
  return options?.streamId
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: [], diagnostics: [] })
  mocks.onSend.mockResolvedValue(undefined)
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

describe('ChatInput — отправка один раз на попытку (ADR-118 §3)', () => {
  it('двойной клик по «Отправить»: один onSend, кнопка busy, затем индикатор снят', async () => {
    const send = deferred()
    mocks.onSend.mockImplementation(() => send.promise)

    const { container } = await renderInput()
    const textarea = textareaOf(container)
    setTextareaValue(textarea, 'привет')
    await flush()

    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    // Первый клик принят: индикатор включён, кнопка заблокирована.
    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(sendButton(container).getAttribute('aria-busy')).toBe('true')
    expect(sendButton(container).disabled).toBe(true)
    // Индикатор — крутящаяся иконка, а не «плоская» кнопка.
    expect(sendButton(container).innerHTML).toContain('animate-spin')

    // Второй клик в полёте — no-op (кнопка заблокирована, guard держит и Enter).
    await act(async () => {
      sendButton(container).click()
    })
    await flush()
    expect(mocks.onSend).toHaveBeenCalledTimes(1)

    // Завершение: индикатор снят, черновик очищен (успешная отправка).
    await act(async () => {
      send.resolve()
      await send.promise
    })
    await flush()
    expect(sendButton(container).getAttribute('aria-busy')).toBeNull()
    expect(sendButton(container).innerHTML).not.toContain('animate-spin')
    expect(textareaOf(container).value).toBe('')
  })

  it('повторный Enter во время отправки — no-op, без тоста об ошибке', async () => {
    const send = deferred()
    mocks.onSend.mockImplementation(() => send.promise)

    const { container } = await renderInput()
    const textarea = textareaOf(container)
    setTextareaValue(textarea, 'привет')
    await flush()

    await pressEnter(textarea)
    await flush()
    expect(mocks.onSend).toHaveBeenCalledTimes(1)

    // Два повторных Enter, пока попытка в полёте.
    await pressEnter(textarea)
    await pressEnter(textarea)
    await flush()
    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    // Дублей нет и «тоста» тоже: повтор — молчаливый no-op.
    expect(mocks.notifyMessage).not.toHaveBeenCalled()

    await act(async () => {
      send.resolve()
      await send.promise
    })
    await flush()
    expect(textareaOf(container).value).toBe('')
  })

  it('ошибка отправки: индикатор снят, черновик сохранён, повтор идёт с тем же streamId', async () => {
    mocks.onSend.mockRejectedValueOnce(new Error('boom'))

    const { container } = await renderInput()
    const textarea = textareaOf(container)
    setTextareaValue(textarea, 'не потеряй')
    await flush()

    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    // Ошибка: индикатор снят (интерфейс не «залип»), черновик на месте.
    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(sendButton(container).getAttribute('aria-busy')).toBeNull()
    expect(textareaOf(container).value).toBe('не потеряй')
    expect(sendButton(container).disabled).toBe(false)

    // Повтор: тот же id попытки — сервер узнает сообщение и не создаст второе.
    await act(async () => {
      sendButton(container).click()
    })
    await flush()

    expect(mocks.onSend).toHaveBeenCalledTimes(2)
    expect(streamIdOf(0)).toBeTruthy()
    expect(streamIdOf(1)).toBe(streamIdOf(0))
    // Успешная попытка очищает черновик.
    expect(textareaOf(container).value).toBe('')
  })

  it('после успешной отправки новый текст уходит с новым streamId', async () => {
    const { container } = await renderInput()
    const textarea = textareaOf(container)

    setTextareaValue(textarea, 'первый')
    await flush()
    await pressEnter(textarea)
    await flush()

    setTextareaValue(textarea, 'второй')
    await flush()
    await pressEnter(textarea)
    await flush()

    expect(mocks.onSend).toHaveBeenCalledTimes(2)
    expect(streamIdOf(0)).toBeTruthy()
    expect(streamIdOf(1)).toBeTruthy()
    expect(streamIdOf(1)).not.toBe(streamIdOf(0))
  })

  it('активный ход: двойной клик по «В очередь» тоже даёт один onSend', async () => {
    const send = deferred()
    mocks.onSend.mockImplementation(() => send.promise)

    const { container } = await renderInput({ isStreaming: true })
    const textarea = textareaOf(container)
    setTextareaValue(textarea, 'в очередь')
    await flush()

    const button = sendButton(container)
    expect(button.getAttribute('title')).toBe(enDict['chat.input.enqueue'])

    await act(async () => {
      button.click()
    })
    await flush()
    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(true)

    await act(async () => {
      button.click()
    })
    await flush()
    expect(mocks.onSend).toHaveBeenCalledTimes(1)

    await act(async () => {
      send.resolve()
      await send.promise
    })
    await flush()
    expect(textareaOf(container).value).toBe('')
  })
})
