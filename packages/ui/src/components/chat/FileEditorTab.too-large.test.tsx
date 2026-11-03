import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useFilesStore пишет в localStorage — мок для детерминизма.
vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
})

const i18nMock = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  downloadFile: vi.fn(() => '/api/v2/fs/download?project_id=p1&path=big.bin'),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { readFile: mocks.readFile, writeFile: mocks.writeFile, downloadFile: mocks.downloadFile },
}))

import { FileEditorTab } from './FileEditorTab'
import { useFilesStore } from '@/stores/filesStore'
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
  type: 'file-editor',
  title: 'big.bin',
  data: { projectId: 'p1', filePath: 'big.bin' },
}

/** Отказ сервера: файл больше лимита чтения (413 + машинный код). */
function tooLargeError(reason: 'size' | 'binary' = 'size') {
  return Object.assign(new Error('Файл превышает лимит чтения'), {
    status: 413,
    code: 'FILE_TOO_LARGE',
    details: { maxReadBytes: 5 * 1024 * 1024, size: 12 * 1024 * 1024, reason },
  })
}

describe('FileEditorTab — файл больше лимита чтения (413 FILE_TOO_LARGE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFilesStore.setState({ fileRevisions: {}, deletedFiles: {}, draftContents: {} })
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

  it('показывает понятное сообщение с размером и лимитом, а не пустой экран', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('size'))

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('file.tooLarge')
    // Размер и лимит подставлены в текст.
    expect(container.textContent).toContain('12.0 MiB')
    expect(container.textContent).toContain('5.0 MiB')
    // Редактор не показывается (файл не прочитан) — но экран не пустой.
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('[data-testid="file-too-large"]')).not.toBeNull()
  })

  it('бинарный файл — отдельная формулировка', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('binary'))

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('file.binaryNotReadable')
    expect(container.textContent).not.toContain('file.tooLarge')
  })

  it('предлагает скачать файл, а не редактировать его', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('size'))

    const container = await render(<FileEditorTab tab={tab} />)

    const link = container.querySelector('a[download]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/api/v2/fs/download?project_id=p1&path=big.bin')
  })

  it('файл не считается удалённым (это не 404)', async () => {
    mocks.readFile.mockRejectedValue(tooLargeError('size'))

    await render(<FileEditorTab tab={tab} />)

    expect(useFilesStore.getState().deletedFiles['p1::big.bin']).toBeUndefined()
  })
})
