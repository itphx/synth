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
  attachmentThumbnailUrl: (sessionId: string, partId: string) =>
    `/api/v2/sessions/${sessionId}/attachments/${partId}?variant=thumb`,
  attachmentContentUrlFromThumb: (thumbUrl: string) => {
    const suffix = '?variant=thumb'
    return thumbUrl.endsWith(suffix) ? thumbUrl.slice(0, -suffix.length) : undefined
  },
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { AttachedFilesList, attachmentFileIcon } from './AttachedFilesList'
import { useAttachmentsStore, type DraftAttachment } from '@/stores/attachmentsStore'
import { DEFAULT_ATTACHMENT_LIMITS } from '@/lib/attachments/limits'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 's1'
const roots: Array<{ root: Root; container: HTMLElement }> = []

function draft(overrides: Partial<DraftAttachment> & { name: string }): DraftAttachment {
  const name = overrides.name
  const base: DraftAttachment = {
    id: `att_${name}`,
    file: new File(['x'], name),
    name,
    mimeType: 'text/plain',
    size: 1024,
    previewUrl: '',
    upload: 'ready',
    partId: `srv_${name}`,
  }
  return { ...base, ...overrides }
}

async function renderList(props: { onOpenImage?: (index: number) => void; onRemove?: (names: string[]) => void } = {}): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <AttachedFilesList sessionId={SESSION} onOpenImage={props.onOpenImage} onRemove={props.onRemove} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.uploadSessionAttachment.mockImplementation(async (_sessionId: string, file: File) => ({
    id: `srv_${file.name}`,
    blobPath: `attachments/ab/${file.name}`,
    sha256: 'sha',
    mime: 'text/plain',
    size: 1024,
  }))
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
  useAttachmentsStore.setState({ bySession: {}, limits: DEFAULT_ATTACHMENT_LIMITS })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  useAttachmentsStore.setState({ bySession: {}, limits: DEFAULT_ATTACHMENT_LIMITS })
})

describe('AttachedFilesList', () => {
  it('рисует превью изображения и чип файла', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({ name: 'photo.png', mimeType: 'image/png', previewUrl: 'blob:photo' }),
          draft({ name: 'report.pdf', mimeType: 'application/pdf', size: 2048 }),
        ],
      },
    })

    const container = await renderList()

    const image = container.querySelector('[data-testid="attachment-image"] img')
    expect(image?.getAttribute('src')).toBe('blob:photo')
    expect(container.querySelectorAll('[data-testid="attachment-image"]')).toHaveLength(1)

    const file = container.querySelector('[data-testid="attachment-file"]')
    expect(file?.textContent).toContain('report.pdf')
    expect(file?.textContent).toContain('2.0 KB')
  })

  it('превью восстановленного изображения — миниатюра, при ошибке — оригинал', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({
            name: 'photo.png',
            mimeType: 'image/png',
            previewUrl: '/api/v2/sessions/s1/attachments/part-1?variant=thumb',
          }),
        ],
      },
    })

    const container = await renderList()
    const image = container.querySelector('[data-testid="attachment-image"] img') as HTMLImageElement
    expect(image.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/part-1?variant=thumb')

    await act(async () => {
      image.dispatchEvent(new Event('error'))
    })

    const fallback = container.querySelector('[data-testid="attachment-image"] img') as HTMLImageElement
    expect(fallback.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/part-1')

    // Ошибка оригинала уже не обрабатывается — цикла подмен нет.
    await act(async () => {
      fallback.dispatchEvent(new Event('error'))
    })
    const after = container.querySelector('[data-testid="attachment-image"] img') as HTMLImageElement
    expect(after.getAttribute('src')).toBe('/api/v2/sessions/s1/attachments/part-1')
  })

  it('локальный object URL не подменяется (у свежего черновика миниатюры нет)', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [draft({ name: 'photo.png', mimeType: 'image/png', previewUrl: 'blob:photo' })],
      },
    })

    const container = await renderList()
    const image = container.querySelector('[data-testid="attachment-image"] img') as HTMLImageElement
    await act(async () => {
      image.dispatchEvent(new Event('error'))
    })

    expect(
      container.querySelector('[data-testid="attachment-image"] img')?.getAttribute('src'),
    ).toBe('blob:photo')
  })

  it('освобождает пустое состояние — ничего не рендерит', async () => {
    const container = await renderList()
    expect(container.innerHTML).toBe('')
  })

  it('удаляет файл по кнопке', async () => {
    useAttachmentsStore.setState({
      bySession: { [SESSION]: [draft({ name: 'a.txt' })] },
    })

    const container = await renderList()
    const removeButton = container.querySelector('[aria-label="Remove “a.txt”"]') as HTMLElement | null
    expect(removeButton).toBeTruthy()

    await click(removeButton!)

    expect(useAttachmentsStore.getState().bySession[SESSION]).toHaveLength(0)
  })

  it('сообщает имена удалённых элементов через onRemove', async () => {
    const onRemove = vi.fn()
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({ name: 'photo.png', mimeType: 'image/png', previewUrl: 'blob:photo' }),
          draft({ name: 'a.txt' }),
        ],
      },
    })

    const container = await renderList({ onRemove })
    const removeButton = container.querySelector('[aria-label="Remove “a.txt”"]') as HTMLElement | null
    await click(removeButton!)

    expect(onRemove).toHaveBeenCalledWith(['a.txt'])
  })

  it('при каскаде по groupId сообщает имена всей группы', async () => {
    const onRemove = vi.fn()
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({ name: 'doc.txt', groupId: 'g1', groupSize: 2 }),
          draft({ name: 'page1.png', mimeType: 'image/png', groupId: 'g1', groupSize: 2 }),
          draft({ name: 'other.txt' }),
        ],
      },
    })

    const container = await renderList({ onRemove })
    const removeButton = container.querySelector('[aria-label="Remove “doc.txt”"]') as HTMLElement | null
    await click(removeButton!)

    expect(onRemove).toHaveBeenCalledWith(['doc.txt', 'page1.png'])
    expect(useAttachmentsStore.getState().bySession[SESSION]!.map((item) => item.name)).toEqual([
      'other.txt',
    ])
  })

  it('открывает галерею по клику на превью', async () => {
    const onOpenImage = vi.fn()
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({ name: 'photo.png', mimeType: 'image/png', previewUrl: 'blob:photo' }),
          draft({ name: 'other.png', mimeType: 'image/png', previewUrl: 'blob:other' }),
        ],
      },
    })

    const container = await renderList({ onOpenImage })
    const previews = container.querySelectorAll('[data-testid="attachment-preview"]')
    expect(previews).toHaveLength(2)
    await click(previews[1] as HTMLElement)

    expect(onOpenImage).toHaveBeenCalledWith(1)
  })

  it('показывает состояние загрузки', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({ name: 'photo.png', mimeType: 'image/png', previewUrl: 'blob:photo', upload: 'uploading' }),
          draft({ name: 'slow.txt', upload: 'uploading' }),
        ],
      },
    })

    const container = await renderList()

    expect(container.querySelector('[data-testid="attachment-uploading"]')).toBeTruthy()
    const file = container.querySelector('[data-testid="attachment-file"]')
    expect(file?.getAttribute('data-state')).toBe('uploading')
    expect(file?.getAttribute('class')).toContain('opacity-60')
  })

  it('показывает процент загрузки в чипе, если прогресс известен', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [draft({ name: 'big.mp4', mimeType: 'video/mp4', upload: 'uploading', progress: 0.42 })],
      },
    })

    const container = await renderList()

    const percent = container.querySelector('[data-testid="attachment-uploading-percent"]')
    expect(percent?.textContent).toBe('42%')
    // i18n-ключ `chat.attachments.uploadingPercent` (en) — в aria-label.
    expect(percent?.getAttribute('aria-label')).toBe('Uploading: 42%')
  })

  it('показывает процент на превью изображения и сохраняет спиннер без прогресса', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({
            name: 'photo.png',
            mimeType: 'image/png',
            previewUrl: 'blob:photo',
            upload: 'uploading',
            progress: 0.5,
          }),
          draft({ name: 'unknown.txt', upload: 'uploading' }),
        ],
      },
    })

    const container = await renderList()

    const overlay = container.querySelector('[data-testid="attachment-uploading"]')
    expect(overlay?.textContent).toBe('50%')
    expect(overlay?.querySelector('[aria-label="Uploading: 50%"]')).toBeTruthy()
    // Без прогресса — прежний спиннер (без процента в чипе).
    expect(container.querySelector('[data-testid="attachment-uploading-percent"]')).toBeNull()
  })

  it('показывает ошибку и повторяет загрузку', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [draft({ name: 'broken.txt', upload: 'error', error: 'upload_failed', partId: undefined })],
      },
    })

    const container = await renderList()
    const file = container.querySelector('[data-testid="attachment-file"]')
    expect(file?.getAttribute('data-state')).toBe('error')
    expect(file?.getAttribute('title')).toBe('Failed to upload the file')

    const retryButton = container.querySelector('[aria-label="Retry upload"]') as HTMLElement | null
    expect(retryButton).toBeTruthy()

    await click(retryButton!)

    const item = useAttachmentsStore.getState().bySession[SESSION]![0]!
    expect(item.upload).toBe('ready')
    expect(item.partId).toBe('srv_broken.txt')
  })

  it('ошибка изображения — заметный оверлей с полным текстом и повтором', async () => {
    useAttachmentsStore.setState({
      bySession: {
        [SESSION]: [
          draft({
            name: 'broken.png',
            mimeType: 'image/png',
            previewUrl: 'blob:broken',
            upload: 'error',
            error: 'too_large',
            partId: undefined,
          }),
        ],
      },
    })

    const container = await renderList()

    // Превью и тач-таргет остаются на месте.
    expect(container.querySelector('[data-testid="attachment-preview"] img')?.getAttribute('src')).toBe(
      'blob:broken',
    )

    const overlay = container.querySelector('[data-testid="attachment-image-error"]')
    expect(overlay).toBeTruthy()
    expect(overlay?.getAttribute('title')).toBe('File is larger than 100.0 MB')
    expect(overlay?.textContent).toContain('File is larger than 100.0 MB')

    const retryButton = overlay?.querySelector('[aria-label="Retry upload"]') as HTMLElement | null
    expect(retryButton).toBeTruthy()

    await click(retryButton!)

    const item = useAttachmentsStore.getState().bySession[SESSION]![0]!
    expect(item.upload).toBe('ready')
    expect(item.partId).toBe('srv_broken.png')
  })

  it('текст too_large берёт предел из 413 элемента, иначе — из лимитов стора', async () => {
    useAttachmentsStore.setState({
      limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxBytesPerFile: 25 * 1024 * 1024 },
      bySession: {
        [SESSION]: [
          draft({
            name: 'server-limit.pdf',
            mimeType: 'application/pdf',
            upload: 'error',
            error: 'too_large',
            partId: undefined,
          }),
          draft({
            name: 'echoed-limit.pdf',
            mimeType: 'application/pdf',
            upload: 'error',
            error: 'too_large',
            maxBytes: 5 * 1024 * 1024,
            partId: undefined,
          }),
        ],
      },
    })

    const container = await renderList()
    const titles = Array.from(container.querySelectorAll('[data-testid="attachment-file"]')).map(
      (element) => element.getAttribute('title'),
    )

    expect(titles).toEqual([
      'File is larger than 25.0 MB',
      'File is larger than 5.0 MB',
    ])
  })

  it('видео получает иконку file-video, аудио — file-music', () => {
    expect(attachmentFileIcon({ mimeType: 'video/mp4' })).toBe('file-video')
    expect(attachmentFileIcon({ mimeType: 'audio/mpeg' })).toBe('file-music')
  })
})
