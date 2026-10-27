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
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getCommands: mocks.getCommands } }))
// Подготовка файла мокается: проверяем, что выбор через `AttachmentButton`
// идёт единым путём (prepare → группы → стор), а не в обход.
vi.mock('@/lib/attachments/prepare', () => ({
  prepareAttachmentFiles: mocks.prepareAttachmentFiles,
}))
vi.mock('@/lib/api/attachments', () => ({
  uploadSessionAttachment: mocks.uploadSessionAttachment,
  attachmentContentUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}`,
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
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
  await flush()
  return container
}

/** Прокрутить микрозадачи подготовки/загрузки вложений. */
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

async function uploadFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

async function pressEnter(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

/** Кнопка отправки: подпись зависит от состояния загрузки вложений. */
function sendButton(container: HTMLElement): HTMLButtonElement {
  const titles = [enDict['chat.input.send'], enDict['chat.attachments.waitUpload']]
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    titles.includes(element.getAttribute('title') ?? ''),
  )
  return button as HTMLButtonElement
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
  // Пропускаем файл как есть — тесты про путь подготовки, а не про её шаги.
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
  vi.clearAllMocks()
})

describe('ChatInput — вложения (ADR-115)', () => {
  it('выбор файла добавляет чип и отправляет partId, после успеха чипы исчезают', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])

    const chip = container.querySelector('[data-testid="attachment-file"]')
    expect(chip?.textContent).toContain('a.txt')

    setTextareaValue(textarea, 'привет')
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledWith('привет', undefined, undefined, ['srv_a.txt'])
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(0)
    expect(container.querySelector('[data-testid="attachment-file"]')).toBeNull()
  })

  it('выбор файла через кнопку идёт через prepareAttachmentFiles', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })

    await uploadFiles(input, [file])

    expect(mocks.prepareAttachmentFiles).toHaveBeenCalledTimes(1)
    expect(mocks.prepareAttachmentFiles).toHaveBeenCalledWith(file, expect.any(Set))
    expect((useAttachmentsStore.getState().bySession[SESSION] ?? []).map((item) => item.name)).toEqual([
      'a.txt',
    ])
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
  })

  it('пока идёт загрузка, отправка заблокирована', async () => {
    let finishUpload: (value: unknown) => void = () => {}
    mocks.uploadSessionAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve
        }),
    )

    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['slow'], 'slow.txt', { type: 'text/plain' })])
    setTextareaValue(textarea, 'подожди')

    const blocked = sendButton(container)
    expect(blocked).toBeTruthy()
    expect(blocked.disabled).toBe(true)
    expect(blocked.getAttribute('title')).toBe(enDict['chat.attachments.waitUpload'])

    await act(async () => {
      blocked.click()
    })
    await flush()
    expect(mocks.onSend).not.toHaveBeenCalled()

    await act(async () => {
      finishUpload({
        id: 'srv_slow.txt',
        blobPath: 'attachments/ab/slow.txt',
        sha256: 'sha',
        mime: 'text/plain',
        size: 4,
      })
    })
    await flush()

    expect(sendButton(container).disabled).toBe(false)
  })

  it('при ошибке отправки вложения остаются в композере', async () => {
    mocks.onSend.mockRejectedValue(new Error('boom'))

    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])
    setTextareaValue(textarea, 'привет')
    await pressEnter(textarea)

    expect(mocks.onSend).toHaveBeenCalledTimes(1)
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(1)
    expect(container.querySelector('[data-testid="attachment-file"]')).not.toBeNull()
  })

  it('drag&drop показывает подсказку и добавляет файлы', async () => {
    const container = await renderInput()
    const composer = container.firstElementChild as HTMLElement
    const dataTransfer = {
      types: ['Files'],
      files: [new File(['drag'], 'd.txt', { type: 'text/plain' })],
    }

    await act(async () => {
      const event = new Event('dragenter', { bubbles: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      composer.dispatchEvent(event)
    })

    const overlay = container.querySelector('[data-testid="attachment-drop-overlay"]')
    expect(overlay?.textContent).toContain(enDict['chat.attachments.dropHint'])

    await act(async () => {
      const event = new Event('drop', { bubbles: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      composer.dispatchEvent(event)
    })
    await flush()

    expect(container.querySelector('[data-testid="attachment-drop-overlay"]')).toBeNull()
    expect((useAttachmentsStore.getState().bySession[SESSION] ?? []).map((item) => item.name)).toEqual([
      'd.txt',
    ])
  })

  it('вставка файла из буфера добавляет вложение', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: {
          types: ['Files'],
          files: [new File(['shot'], 'shot.png', { type: 'image/png' })],
          items: [],
          getData: () => '',
        },
      })
      textarea.dispatchEvent(event)
    })
    await flush()

    expect((useAttachmentsStore.getState().bySession[SESSION] ?? []).map((item) => item.name)).toEqual([
      'shot.png',
    ])
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
  })

  it('выбор файла вставляет маркер вложения в текст', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])

    expect(textarea.value).toBe('[file: a.txt]')
  })

  it('вставка изображения из буфера даёт маркер [image: …]', async () => {
    const container = await renderInput()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', {
        value: {
          types: ['Files'],
          files: [new File(['shot'], 'shot.png', { type: 'image/png' })],
          items: [],
          getData: () => '',
        },
      })
      textarea.dispatchEvent(event)
    })
    await flush()

    expect(textarea.value).toBe('[image: shot.png]')
  })

  it('маркер вставляется на позицию каретки', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    setTextareaValue(textarea, 'привет мир')
    textarea.focus()
    textarea.setSelectionRange(6, 6)

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])
    // Каретка восстанавливается после перерисовки `value` (setTimeout 0).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(textarea.value).toBe('привет [file: a.txt] мир')
    expect(textarea.selectionStart).toBe('привет [file: a.txt]'.length)
  })

  it('повторное прикрепление того же файла не добавляет второй маркер', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])
    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])

    expect(textarea.value).toBe('[file: a.txt]')
  })

  it('удаление чипа убирает маркер из текста', async () => {
    const container = await renderInput()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])
    setTextareaValue(textarea, 'посмотри [file: a.txt]')

    const removeButton = container.querySelector('[aria-label="Remove “a.txt”"]') as HTMLElement | null
    expect(removeButton).toBeTruthy()
    await act(async () => {
      removeButton!.click()
    })
    await flush()

    expect(textarea.value).toBe('посмотри')
  })
})
