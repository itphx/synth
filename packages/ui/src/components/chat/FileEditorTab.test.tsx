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
  writeFile: vi.fn(),
  downloadFile: vi.fn(
    (projectId: string, path: string) =>
      `/api/v2/fs/download?project_id=${projectId}&path=${path}`,
  ),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    downloadFile: mocks.downloadFile,
  },
}))

/**
 * CodeMirror в jsdom не гоняем: мок — управляемый `<textarea>`, поэтому
 * проверки черновика/сохранения остаются прежними и не зависят от редактора.
 */
vi.mock('@/components/chat/CodeEditor', () => ({
  CodeEditor: ({
    value,
    filePath,
    onChange,
    testId,
  }: {
    value: string
    filePath: string
    onChange?: (value: string) => void
    testId?: string
  }) =>
    React.createElement('textarea', {
      'data-testid': testId ?? 'code-editor',
      'data-file-path': filePath,
      value,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value),
    }),
}))

import { FileEditorTab } from './FileEditorTab'
import { useFilesStore } from '@/stores/filesStore'
import { useUIStore } from '@/stores/useUIStore'
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
    useFilesStore.setState({ fileRevisions: {}, deletedFiles: {}, draftContents: {} })
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    mocks.readFile.mockResolvedValue({ content: 'hello', encoding: 'text', size: 5 })
    mocks.writeFile.mockResolvedValue({ content: 'hello', encoding: 'text', size: 5 })
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

  it('404/NOT_FOUND (удаление широким тулом) → пометка deletedFiles и экран «файл удалён»', async () => {
    useFilesStore.setState({ deletedFiles: {}, fileRevisions: {} })
    mocks.readFile.mockRejectedValue(
      Object.assign(new Error('Файл не найден'), { status: 404, code: 'NOT_FOUND' }),
    )

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('file.deletedOnDisk')
    expect(container.textContent).not.toContain('Файл не найден')
    expect(container.querySelector('textarea')).toBeNull()
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBe(true)
  })

  it('ошибка 500 (не 404) → экран ошибки, не удаление', async () => {
    useFilesStore.setState({ deletedFiles: {}, fileRevisions: {} })
    mocks.readFile.mockRejectedValue(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    )

    const container = await render(<FileEditorTab tab={tab} />)

    expect(container.textContent).toContain('Internal Server Error')
    expect(container.textContent).not.toContain('file.deletedOnDisk')
    expect(container.querySelector('textarea')).toBeNull()
    expect(useFilesStore.getState().deletedFiles['p1::a.txt']).toBeUndefined()
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

  it('восстанавливает черновик при монтировании (файл остаётся грязным)', async () => {
    useFilesStore.setState({ draftContents: { 'p1::a.txt': 'draft text' } })

    const container = await render(<FileEditorTab tab={tab} />)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe('draft text')
    // Черновик не потерян и остаётся в сторе.
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBe('draft text')
  })

  it('onChange пишет черновик в стор', async () => {
    const container = await render(<FileEditorTab tab={tab} />)
    const textarea = container.querySelector('textarea')!

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )!.set!
      setValue.call(textarea, 'edited')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBe('edited')
  })

  it('успешное сохранение очищает черновик', async () => {
    useFilesStore.setState({ draftContents: { 'p1::a.txt': 'edited' } })
    await render(<FileEditorTab tab={tab} />)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    })

    expect(mocks.writeFile).toHaveBeenCalledWith('p1', 'a.txt', 'edited')
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBeUndefined()
  })

  it('панель: «Сохранить» (disabled без изменений), «Скачать», «Закрыть», статус', async () => {
    const container = await render(<FileEditorTab tab={tab} />)

    const save = container.querySelector<HTMLButtonElement>('[data-testid="file-save"]')
    expect(save).not.toBeNull()
    // Изменений нет — сохранение недоступно.
    expect(save!.disabled).toBe(true)

    const download = container.querySelector<HTMLAnchorElement>('[data-testid="file-download"]')
    expect(download).not.toBeNull()
    expect(download!.getAttribute('href')).toContain('/fs/download')
    expect(download!.hasAttribute('download')).toBe(true)

    expect(container.querySelector('[data-testid="file-close"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="file-editor-status"]')?.textContent).toBe('')
  })

  it('панель: после правки Save активен, статус — «изменён»', async () => {
    const container = await render(<FileEditorTab tab={tab} />)
    const textarea = container.querySelector('textarea')!

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )!.set!
      setValue.call(textarea, 'edited')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = container.querySelector<HTMLButtonElement>('[data-testid="file-save"]')
    expect(save!.disabled).toBe(false)
    expect(container.querySelector('[data-testid="file-editor-status"]')?.textContent).toBe(
      'common.modified',
    )
  })

  it('CodeMirror получает содержимое файла и путь', async () => {
    const container = await render(<FileEditorTab tab={tab} />)

    const code = container.querySelector<HTMLTextAreaElement>('[data-testid="file-editor-code"]')
    expect(code).not.toBeNull()
    expect(code!.value).toBe('hello')
    expect(code!.getAttribute('data-file-path')).toBe('a.txt')
  })

  it('«Закрыть» закрывает вкладку', async () => {
    useUIStore.setState({
      centerTabs: [tab],
      activeCenterTabId: tab.id,
    })

    const container = await render(<FileEditorTab tab={tab} />)
    const close = container.querySelector<HTMLButtonElement>('[data-testid="file-close"]')
    await act(async () => {
      close!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useUIStore.getState().centerTabs).toHaveLength(0)
  })
})
