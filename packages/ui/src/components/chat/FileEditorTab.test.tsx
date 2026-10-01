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

const i18nMock = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { readFile: mocks.readFile } }))

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
  return container
}

const tab: CenterTab = {
  id: 'tab-1',
  type: 'file-editor',
  title: 'a.txt',
  data: { projectId: 'p1', filePath: 'a.txt' },
}

describe('FileEditorTab — состояние «файл удалён»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFilesStore.setState({ fileRevisions: {}, deletedFiles: {} })
    mocks.readFile.mockResolvedValue({ content: 'hello', encoding: 'text', size: 5 })
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

  it('renders deleted state when file marked deleted by agent', async () => {
    const container = await render(<FileEditorTab tab={tab} />)
    expect(container.textContent).toContain('hello')

    await act(async () => {
      useFilesStore.setState((s) => ({
        fileRevisions: { ...s.fileRevisions, 'p1::a.txt': 1 },
        deletedFiles: { ...s.deletedFiles, 'p1::a.txt': true },
      }))
    })

    expect(container.textContent).toContain('file.deletedOnDisk')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('показывает «файл удалён», а не экран ошибки, если перечитывание падает', async () => {
    useFilesStore.setState({ deletedFiles: { 'p1::a.txt': true }, fileRevisions: {} })
    mocks.readFile.mockRejectedValue(new Error('ENOENT: no such file'))

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('file.deletedOnDisk')
    expect(container.textContent).not.toContain('ENOENT')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('при успешном перечитывании (файл пересоздан) снимает пометку и возвращает редактор', async () => {
    useFilesStore.setState({ deletedFiles: { 'p1::a.txt': true }, fileRevisions: {} })
    mocks.readFile.mockResolvedValue({ content: 'restored', encoding: 'text', size: 8 })

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('restored')
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBeUndefined()
  })

  it('keeps dirty content and shows changed-on-disk banner for a live file revision', async () => {
    mocks.readFile.mockResolvedValue({ content: 'disk', encoding: 'text', size: 4 })
    const container = await render(<FileEditorTab tab={tab} />)

    // Правим файл локально → грязный.
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )!.set!
      setValue.call(textarea, 'local edit')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      useFilesStore.setState((s) => ({
        fileRevisions: { ...s.fileRevisions, 'p1::a.txt': 1 },
      }))
    })

    expect(container.textContent).toContain('file.changedOnDisk')
    expect(container.textContent).toContain('local edit')
  })
})
