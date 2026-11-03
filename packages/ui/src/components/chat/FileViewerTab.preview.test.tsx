import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

// `MarkdownContent` берёт из модуля ещё `i18nText`/`useI18nStore` — мок должен
// отдавать и их, иначе реальный markdown-пайплайн упадёт на импорте.
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
  i18nText: (key: string) => key,
  useI18nStore: (selector: (s: { dictionary: Record<string, unknown> }) => unknown) =>
    selector({ dictionary: {} }),
}))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  downloadFile: vi.fn(
    (projectId: string, path: string) =>
      `/api/v2/fs/download?project_id=${projectId}&path=${path}`,
  ),
  rawFileUrl: vi.fn(
    (projectId: string, path: string) => `/api/v2/fs/raw?project_id=${projectId}&path=${path}`,
  ),
  probeRawFile: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { FileViewerTab } from './FileViewerTab'
import type { CenterTab } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  await act(async () => {})
  return container
}

function fileTab(filePath: string): CenterTab {
  return {
    id: `tab-${filePath}`,
    type: 'file-viewer',
    title: filePath.split('/').pop() ?? filePath,
    data: { projectId: 'p1', filePath },
  }
}

function tooLargeError(reason: 'size' | 'binary' | 'preview_size', details?: Record<string, unknown>) {
  return Object.assign(new Error('Файл превышает лимит'), {
    status: 413,
    code: 'FILE_TOO_LARGE',
    details: {
      maxReadBytes: 5 * 1024 * 1024,
      size: 12 * 1024 * 1024,
      reason,
      ...details,
    },
  })
}

describe('FileViewerTab — предпросмотр файла по семейству (fileKind)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readFile.mockResolvedValue({ path: 'x', content: '', size: 0, encoding: 'utf-8' })
    mocks.probeRawFile.mockResolvedValue({ ok: true, status: 200, size: 10 })
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

  it('markdown → рендер через `.markdown-content`, переключатель «Исходник» даёт `<pre>`', async () => {
    mocks.readFile.mockResolvedValue({
      path: 'README.md',
      content: '# Заголовок',
      size: 14,
      encoding: 'utf-8',
    })

    const container = await render(<FileViewerTab tab={fileTab('README.md')} />)

    expect(container.querySelector('.markdown-content')).not.toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Заголовок')

    const sourceButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'file.markdownSource',
    )
    expect(sourceButton).toBeTruthy()
    await act(async () => {
      sourceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('.markdown-content')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('# Заголовок')
  })

  it('image → `<img>` с src из `/fs/raw`', async () => {
    const container = await render(<FileViewerTab tab={fileTab('pictures/cat.png')} />)

    const img = container.querySelector('img') as HTMLImageElement | null
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toContain('/fs/raw')
    expect(img!.getAttribute('src')).toContain('path=pictures/cat.png')
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('video → `<video preload="metadata">`', async () => {
    const container = await render(<FileViewerTab tab={fileTab('clips/demo.mp4')} />)

    const video = container.querySelector('video') as HTMLVideoElement | null
    expect(video).not.toBeNull()
    expect(video!.getAttribute('preload')).toBe('metadata')
    expect(video!.getAttribute('src')).toContain('/fs/raw')
  })

  it('pdf → `<iframe>` с src из `/fs/raw`', async () => {
    const container = await render(<FileViewerTab tab={fileTab('docs/report.pdf')} />)

    const frame = container.querySelector('iframe') as HTMLIFrameElement | null
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('src')).toContain('/fs/raw')
  })

  it('бинарный отказ 413 {reason:"binary"} → видна кнопка «Скачать» (регресс)', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('binary'))

    const container = await render(<FileViewerTab tab={fileTab('data/blob.bin')} />)

    expect(container.textContent).toContain('file.binaryNotReadable')
    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toContain('/fs/download')
  })

  it('413 {reason:"preview_size"} для медиа → сообщение и «Скачать»', async () => {
    mocks.probeRawFile.mockResolvedValue({
      ok: false,
      status: 413,
      size: 150 * 1024 * 1024,
      limit: 100 * 1024 * 1024,
      reason: 'preview_size',
    })

    const container = await render(<FileViewerTab tab={fileTab('video/huge.mp4')} />)

    expect(container.textContent).toContain('file.previewTooLarge')
    expect(container.textContent).toContain('150.0 MiB')
    expect(container.textContent).toContain('100.0 MiB')
    expect(container.querySelector('video')).toBeNull()
    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
  })

  it('ошибка показа изображения → «не удалось показать» + «Скачать»', async () => {
    const container = await render(<FileViewerTab tab={fileTab('broken.png')} />)

    const img = container.querySelector('img') as HTMLImageElement
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })

    expect(container.querySelector('[data-testid="file-preview-failed"]')).not.toBeNull()
    expect(container.querySelector('a[download]')).not.toBeNull()
  })

  it('отказ проверки предпросмотра (404) → текст ошибки и «Скачать»', async () => {
    mocks.probeRawFile.mockResolvedValue({ ok: false, status: 404, size: 0, message: 'Файл не найден' })

    const container = await render(<FileViewerTab tab={fileTab('pictures/missing.png')} />)

    expect(container.textContent).toContain('Файл не найден')
    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toContain('/fs/download')
  })
})
