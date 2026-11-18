import { describe, it, expect, vi } from 'vitest'
import {
  defaultFileViewMode,
  fileEditorTabId,
  fileViewerTabId,
  openFileDiffTab,
  openFileEditorTab,
  openFileTab,
  parseFileViewMode,
} from './fileTabs'

describe('lib/fileTabs — id и открытие файловых вкладок', () => {
  it('id вкладок: просмотр и редактор — разные префиксы, один путь', () => {
    expect(fileViewerTabId('p1', 'src/a.ts')).toBe('file-p1/src/a.ts')
    expect(fileEditorTabId('p1', 'src/a.ts')).toBe('edit-p1/src/a.ts')
  })

  it('режим по умолчанию: разметка — превью, текст/код/неизвестное — исходник', () => {
    expect(defaultFileViewMode('markdown')).toBe('preview')
    expect(defaultFileViewMode('html')).toBe('preview')
    expect(defaultFileViewMode('code')).toBe('source')
    expect(defaultFileViewMode('text')).toBe('source')
    expect(defaultFileViewMode('binary')).toBe('source')
  })

  it('parseFileViewMode отбрасывает неизвестные значения', () => {
    expect(parseFileViewMode('diff')).toBe('diff')
    expect(parseFileViewMode('preview')).toBe('preview')
    expect(parseFileViewMode('nope')).toBeNull()
    expect(parseFileViewMode(undefined)).toBeNull()
    expect(parseFileViewMode(42)).toBeNull()
  })

  it('openFileTab: один id на файл, заголовок — имя файла', () => {
    const openTab = vi.fn()
    openFileTab(openTab, { projectId: 'p1', filePath: 'docs/README.md' })

    expect(openTab).toHaveBeenCalledWith({
      id: 'file-p1/docs/README.md',
      type: 'file-viewer',
      title: 'README.md',
      data: { projectId: 'p1', filePath: 'docs/README.md' },
    })
  })

  it('openFileDiffTab: та же вкладка file-viewer с viewMode=diff', () => {
    const openTab = vi.fn()
    openFileDiffTab(openTab, { projectId: 'p1', filePath: 'src/a.ts' })

    expect(openTab).toHaveBeenCalledWith({
      id: 'file-p1/src/a.ts',
      type: 'file-viewer',
      title: 'a.ts',
      data: { projectId: 'p1', filePath: 'src/a.ts', viewMode: 'diff' },
    })
  })

  it('openFileEditorTab: вкладка редактора', () => {
    const openTab = vi.fn()
    openFileEditorTab(openTab, { projectId: 'p1', filePath: 'src/a.ts' })

    expect(openTab).toHaveBeenCalledWith({
      id: 'edit-p1/src/a.ts',
      type: 'file-editor',
      title: 'a.ts',
      data: { projectId: 'p1', filePath: 'src/a.ts' },
    })
  })
})
