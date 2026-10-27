import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const mocks = vi.hoisted(() => ({
  uploadSessionAttachment: vi.fn(),
}))

vi.mock('@/lib/api/attachments', () => ({
  uploadSessionAttachment: mocks.uploadSessionAttachment,
  attachmentContentUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}`,
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AttachmentButton } from './AttachmentButton'
import { useAttachmentsStore } from '@/stores/attachmentsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

/** jsdom не даёт matchMedia — фиксируем десктоп. */
function stubDesktop(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

async function renderButton(
  disabled?: boolean,
  onFiles?: (files: File[]) => void | Promise<void>,
): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AttachmentButton sessionId={SESSION} disabled={disabled} onFiles={onFiles} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

/** Аналог `userEvent.upload`: подставляет файлы в input и шлёт change. */
async function uploadFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  stubDesktop()
  mocks.uploadSessionAttachment.mockImplementation(async (_sessionId: string, file: File) => ({
    id: `srv_${file.name}`,
    blobPath: `attachments/ab/${file.name}`,
    sha256: 'sha',
    mime: file.type || 'text/plain',
    size: file.size,
  }))
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
  vi.unstubAllGlobals()
})

describe('AttachmentButton', () => {
  it('рендерит скрытый input с accept и multiple', async () => {
    const container = await renderButton()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement

    expect(input).toBeTruthy()
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
    expect(input.getAttribute('accept')).toBeTruthy()
    expect(input.getAttribute('accept')).toContain('image/png')
    expect(input.getAttribute('accept')).toContain('.docx')
  })

  it('выбор файла добавляет его в композер и запускает загрузку', async () => {
    const container = await renderButton()
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement

    await uploadFiles(input, [new File(['hello'], 'a.txt', { type: 'text/plain' })])

    const list = useAttachmentsStore.getState().bySession[SESSION] ?? []
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('a.txt')
    expect(list[0]!.upload).toBe('ready')
    expect(mocks.uploadSessionAttachment).toHaveBeenCalledTimes(1)
  })

  it('с переданным onFiles отдаёт файлы наружу и не трогает стор', async () => {
    const onFiles = vi.fn()
    const container = await renderButton(undefined, onFiles)
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })

    await uploadFiles(input, [file])

    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles).toHaveBeenCalledWith([file])
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(0)
    expect(mocks.uploadSessionAttachment).not.toHaveBeenCalled()
  })

  it('не добавляет файлы при disabled', async () => {    const container = await renderButton(true)
    const button = container.querySelector('button') as HTMLButtonElement
    const input = container.querySelector('[data-testid="attachment-input"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click')

    expect(button.disabled).toBe(true)

    await act(async () => {
      button.click()
    })

    expect(clickSpy).not.toHaveBeenCalled()
    expect(useAttachmentsStore.getState().bySession[SESSION] ?? []).toHaveLength(0)
  })
})
