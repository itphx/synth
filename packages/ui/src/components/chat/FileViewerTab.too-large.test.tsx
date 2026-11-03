import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  downloadFile: vi.fn(() => '/api/v2/fs/download?project_id=p1&path=big.bin'),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { readFile: mocks.readFile, downloadFile: mocks.downloadFile },
}))

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

const tab: CenterTab = {
  id: 'tab-1',
  type: 'file-viewer',
  title: 'big.bin',
  data: { projectId: 'p1', filePath: 'big.bin' },
}

function tooLargeError(reason: 'size' | 'binary' = 'size') {
  return Object.assign(new Error('Файл превышает лимит чтения'), {
    status: 413,
    code: 'FILE_TOO_LARGE',
    details: { maxReadBytes: 5 * 1024 * 1024, size: 12 * 1024 * 1024, reason },
  })
}

describe('FileViewerTab — файл больше лимита чтения (413 FILE_TOO_LARGE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('показывает понятное сообщение с размером и лимитом', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('size'))

    const container = await render(<FileViewerTab tab={tab} />)

    expect(container.textContent).toContain('file.tooLarge')
    expect(container.textContent).toContain('12.0 MiB')
    expect(container.textContent).toContain('5.0 MiB')
    expect(container.querySelector('[data-testid="file-too-large"]')).not.toBeNull()
  })

  it('бинарный файл — отдельная формулировка', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('binary'))

    const container = await render(<FileViewerTab tab={tab} />)

    expect(container.textContent).toContain('file.binaryNotReadable')
  })

  it('предлагает скачать файл', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('size'))

    const container = await render(<FileViewerTab tab={tab} />)

    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/api/v2/fs/download?project_id=p1&path=big.bin')
  })
})
