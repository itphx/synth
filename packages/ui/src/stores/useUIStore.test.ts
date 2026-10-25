import { describe, it, expect, beforeEach, vi } from 'vitest'

// persist (zustand) захватывает localStorage при импорте стора, а Node/vitest без
// --localstorage-file его не даёт — ставим заглушку до импорта useUIStore.
const storage = vi.hoisted(() => {
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
  return ls
})

import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY, type CenterTab } from './useUIStore'
import { useFilesStore } from './filesStore'

const tab = (id: string, title = id): CenterTab => ({
  id,
  type: 'chat',
  title,
  data: { sessionId: id },
})

describe('useUIStore.openTab', () => {
  beforeEach(() => {
    storage.clear()
    useUIStore.setState({
      centerTabs: [],
      activeCenterTabId: null,
      mobileLeftOpen: true,
      mobileRightOpen: true,
    })
  })

  it('новая вкладка: активирует её и сворачивает мобильную левую панель', () => {
    useUIStore.getState().openTab(tab('chat-1'))

    const s = useUIStore.getState()
    expect(s.centerTabs.map((t) => t.id)).toEqual(['chat-1'])
    expect(s.activeCenterTabId).toBe('chat-1')
    expect(s.mobileLeftOpen).toBe(false)
    // правая панель не затрагивается
    expect(s.mobileRightOpen).toBe(true)
  })

  it('существующая вкладка: обновляет title, активирует и сворачивает левую панель', () => {
    useUIStore.setState({ centerTabs: [tab('chat-1', 'Старое')] })
    useUIStore.getState().openTab(tab('chat-1', 'Новое'))

    const s = useUIStore.getState()
    expect(s.centerTabs).toHaveLength(1)
    expect(s.centerTabs[0].title).toBe('Новое')
    expect(s.activeCenterTabId).toBe('chat-1')
    expect(s.mobileLeftOpen).toBe(false)
    expect(s.mobileRightOpen).toBe(true)
  })
})

describe('useUIStore.onlyActiveProject (variant C)', () => {
  beforeEach(() => {
    storage.clear()
    useUIStore.setState({ onlyActiveProject: false })
  })

  it('OTHER_PROJECTS_COLLAPSE_KEY экспортируется', () => {
    expect(OTHER_PROJECTS_COLLAPSE_KEY).toBe('__others__')
  })

  it('setOnlyActiveProject меняет значение', () => {
    useUIStore.getState().setOnlyActiveProject(true)
    expect(useUIStore.getState().onlyActiveProject).toBe(true)
    useUIStore.getState().setOnlyActiveProject(false)
    expect(useUIStore.getState().onlyActiveProject).toBe(false)
  })

  it('partialize включает onlyActiveProject', () => {
    useUIStore.setState({ onlyActiveProject: true })
    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persisted = partialize!(useUIStore.getState()) as Record<string, unknown>
    expect(persisted.onlyActiveProject).toBe(true)
  })

  it('persist: значение переживает rehydrate', async () => {
    useUIStore.setState({ onlyActiveProject: true })
    await useUIStore.persist.rehydrate()
    expect(useUIStore.getState().onlyActiveProject).toBe(true)
  })

  it('merge старого persisted без поля → false (аддитивность)', async () => {
    useUIStore.setState({ onlyActiveProject: false })
    storage.clear()
    storage.setItem('synth-ui-settings', JSON.stringify({ state: { leftPanelTab: 'files' }, version: 0 }))
    await useUIStore.persist.rehydrate()
    expect(useUIStore.getState().onlyActiveProject).toBe(false)
    expect(useUIStore.getState().leftPanelTab).toBe('files')
  })
})

describe('useUIStore.remapFileTabs', () => {
  const fileViewer = (projectId: string, filePath: string): CenterTab => ({
    id: `file-${projectId}/${filePath}`,
    type: 'file-viewer',
    title: filePath.split('/').pop() ?? filePath,
    data: { projectId, filePath },
  })

  const fileEditor = (projectId: string, filePath: string): CenterTab => ({
    id: `edit-${projectId}/${filePath}`,
    type: 'file-editor',
    title: filePath.split('/').pop() ?? filePath,
    data: { projectId, filePath },
    editingState: 'dirty',
  })

  beforeEach(() => {
    storage.clear()
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  })

  it('viewer: переименование файла, ремап активной вкладки', () => {
    useUIStore.setState({
      centerTabs: [fileViewer('p1', 'a.txt')],
      activeCenterTabId: 'file-p1/a.txt',
    })

    useUIStore.getState().remapFileTabs('p1', 'a.txt', 'p1', 'b.txt')

    const s = useUIStore.getState()
    expect(s.centerTabs[0].id).toBe('file-p1/b.txt')
    expect(s.centerTabs[0].title).toBe('b.txt')
    expect(s.centerTabs[0].data.filePath).toBe('b.txt')
    expect(s.activeCenterTabId).toBe('file-p1/b.txt')
  })

  it('editor: смена проекта, префикс edit- и сохранение editingState', () => {
    useUIStore.setState({ centerTabs: [fileEditor('p1', 'a.txt')], activeCenterTabId: null })

    useUIStore.getState().remapFileTabs('p1', 'a.txt', 'p2', 'a.txt')

    const s = useUIStore.getState()
    expect(s.centerTabs[0].id).toBe('edit-p2/a.txt')
    expect(s.centerTabs[0].data.projectId).toBe('p2')
    expect(s.centerTabs[0].data.filePath).toBe('a.txt')
    expect(s.centerTabs[0].editingState).toBe('dirty')
  })

  it('каталог: перемап вкладок-потомков, посторонняя вкладка не тронута', () => {
    useUIStore.setState({
      centerTabs: [
        fileViewer('p1', 'src/a.ts'),
        fileEditor('p1', 'src/nested/b.ts'),
        fileViewer('p1', 'other/c.ts'),
      ],
      activeCenterTabId: 'file-p1/src/a.ts',
    })

    useUIStore.getState().remapFileTabs('p1', 'src', 'p1', 'lib')

    const s = useUIStore.getState()
    expect(s.centerTabs.map((t) => t.id)).toEqual([
      'file-p1/lib/a.ts',
      'edit-p1/lib/nested/b.ts',
      'file-p1/other/c.ts',
    ])
    expect(s.centerTabs[1].data.filePath).toBe('lib/nested/b.ts')
    expect(s.centerTabs[1].title).toBe('b.ts')
    expect(s.activeCenterTabId).toBe('file-p1/lib/a.ts')
  })

  it('нерелевантный путь не меняет состояние (та же ссылка)', () => {
    const tabs = [fileViewer('p1', 'a.txt'), tab('chat-x')]
    useUIStore.setState({ centerTabs: tabs, activeCenterTabId: 'chat-x' })

    useUIStore.getState().remapFileTabs('p1', 'missing.txt', 'p2', 'x.txt')

    expect(useUIStore.getState().centerTabs).toBe(tabs)
    expect(useUIStore.getState().activeCenterTabId).toBe('chat-x')
  })

  it('ремап неактивной вкладки не меняет activeCenterTabId', () => {
    useUIStore.setState({
      centerTabs: [fileViewer('p1', 'a.txt'), fileViewer('p1', 'b.txt')],
      activeCenterTabId: 'file-p1/b.txt',
    })

    useUIStore.getState().remapFileTabs('p1', 'a.txt', 'p1', 'c.txt')

    const s = useUIStore.getState()
    expect(s.activeCenterTabId).toBe('file-p1/b.txt')
    expect(s.centerTabs[0].id).toBe('file-p1/c.txt')
  })

  it('коллизия id: чужая вкладка удаляется, перемапленная остаётся с editingState', () => {
    useUIStore.setState({
      centerTabs: [fileEditor('p1', 'a.txt'), fileEditor('p1', 'b.txt')],
      activeCenterTabId: 'edit-p1/b.txt',
    })

    useUIStore.getState().remapFileTabs('p1', 'a.txt', 'p1', 'b.txt')

    const s = useUIStore.getState()
    expect(s.centerTabs).toHaveLength(1)
    expect(s.centerTabs[0].id).toBe('edit-p1/b.txt')
    expect(s.centerTabs[0].data.filePath).toBe('b.txt')
    expect(s.centerTabs[0].editingState).toBe('dirty')
    // Активной была удалённая чужая — ею стала перемапленная с тем же id.
    expect(s.activeCenterTabId).toBe('edit-p1/b.txt')
  })

  it('коллизия id: активная посторонняя вкладка сохраняется', () => {
    useUIStore.setState({
      centerTabs: [fileViewer('p1', 'a.txt'), fileViewer('p1', 'b.txt'), fileViewer('p1', 'c.txt')],
      activeCenterTabId: 'file-p1/c.txt',
    })

    useUIStore.getState().remapFileTabs('p1', 'a.txt', 'p1', 'b.txt')

    const s = useUIStore.getState()
    expect(s.centerTabs.map((t) => t.id)).toEqual(['file-p1/b.txt', 'file-p1/c.txt'])
    expect(s.activeCenterTabId).toBe('file-p1/c.txt')
  })
})

describe('useUIStore.closeTab — очистка черновика', () => {  beforeEach(() => {
    storage.clear()
    useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
    useFilesStore.setState({ draftContents: {} })
  })

  it('file-editor: закрытие очищает черновик', () => {
    const editor: CenterTab = {
      id: 'edit-p1/a.txt',
      type: 'file-editor',
      title: 'a.txt',
      data: { projectId: 'p1', filePath: 'a.txt' },
      editingState: 'dirty',
    }
    useUIStore.setState({ centerTabs: [editor], activeCenterTabId: editor.id })
    useFilesStore.setState({ draftContents: { 'p1::a.txt': 'changed' } })

    useUIStore.getState().closeTab(editor.id)

    expect(useUIStore.getState().centerTabs).toHaveLength(0)
    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBeUndefined()
  })

  it('file-viewer: закрытие тоже очищает черновик', () => {
    const viewer: CenterTab = {
      id: 'file-p1/a.txt',
      type: 'file-viewer',
      title: 'a.txt',
      data: { projectId: 'p1', filePath: 'a.txt' },
    }
    useUIStore.setState({ centerTabs: [viewer], activeCenterTabId: viewer.id })
    useFilesStore.setState({ draftContents: { 'p1::a.txt': 'changed' } })

    useUIStore.getState().closeTab(viewer.id)

    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBeUndefined()
  })

  it('chat-вкладка: черновики не затрагиваются', () => {
    useUIStore.setState({ centerTabs: [tab('chat-1')], activeCenterTabId: 'chat-1' })
    useFilesStore.setState({ draftContents: { 'p1::a.txt': 'changed' } })

    useUIStore.getState().closeTab('chat-1')

    expect(useFilesStore.getState().draftContents['p1::a.txt']).toBe('changed')
  })
})

describe('useUIStore.scheduleDraft — deep-link в «Шедулер»', () => {
  const draft = {
    name: 'Memory: reindex project',
    projectId: 'p1',
    pipelineId: 'pl_1',
    payload: { sessionId: 's1' },
    cron: '0 3 * * *',
  }

  beforeEach(() => {
    storage.clear()
    useUIStore.setState({ scheduleDraft: null })
  })

  it('setScheduleDraft меняет значение и очищает', () => {
    useUIStore.getState().setScheduleDraft(draft)
    expect(useUIStore.getState().scheduleDraft).toEqual(draft)

    useUIStore.getState().setScheduleDraft(null)
    expect(useUIStore.getState().scheduleDraft).toBeNull()
  })

  it('runtime-поле не попадает в partialize', () => {
    useUIStore.getState().setScheduleDraft(draft)
    const partialize = useUIStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persisted = partialize!(useUIStore.getState()) as Record<string, unknown>
    expect('scheduleDraft' in persisted).toBe(false)
  })

  it('черновик не пишется в localStorage', () => {
    useUIStore.getState().setScheduleDraft(draft)
    expect(storage.getItem('synth-ui-settings') ?? '').not.toContain('scheduleDraft')
  })
})
