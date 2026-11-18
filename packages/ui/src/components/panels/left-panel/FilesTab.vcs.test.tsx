/**
 * Дерево Files: подсветка изменений рабочего дерева (ADR-076, этап 1) —
 * точка и цвет названия по виду изменения, агрегат по каталогу и счётчик
 * изменений в шапке проекта.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

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
  if (typeof (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  }
})

const i18nMock = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(() => '/api/v2/fs/download'),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { downloadFile: mocks.downloadFile } }))

vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('@/hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectId: 'p1', source: 'session' }),
}))
// Поллинг статуса — настоящий хук: сеть замокана через `gitState.loadStatus`,
// поэтому проверяем реальный набор проектов, который он получает.
/** Стор Git: снимок статуса и приёмник вызовов поллинга. */
const gitState = vi.hoisted(() => ({
  statusByProject: {} as Record<string, unknown[]>,
  loadStatus: vi.fn(async (_projectId: string, _opts?: { force?: boolean }) => {}),
}))

vi.mock('@/stores/gitStore', () => ({
  useGitStore: Object.assign(
    (selector: (s: typeof gitState) => unknown) => selector(gitState),
    { getState: () => gitState },
  ),
}))

import { FilesTab } from './FilesTab'
import { useUIStore } from '@/stores/useUIStore'
import { useFilesStore } from '@/stores/filesStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function renderTree(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<FilesTab />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container
}

/** Название узла дерева (span с текстом имени, не точка и не бейдж). */
function nodeLabel(container: HTMLElement, nodeSuffix: string, label = nodeSuffix): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-tree-node$="::${nodeSuffix}"]`)!
  const span = [...node.querySelectorAll('span')].find(
    (s) => s.textContent === label && s.className.includes('truncate'),
  )
  return span as HTMLElement
}

/** Снимок статуса: один репозиторий в корне workspace. */
function status(files: Array<Record<string, unknown>>) {
  return { path: '', branch: 'main', files }
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    projects: [{ id: 'p1', name: 'Project', workspace: '/w' }] as never,
    loadProjects: vi.fn(async () => {}),
  })
  useSessionsStore.setState({ loadSessions: vi.fn(async () => {}) })
  useUIStore.setState({ centerTabs: [], activeCenterTabId: null })
  useFilesStore.setState({
    treesByProject: {
      p1: [
        { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 3, modifiedAt: 0 },
        { name: 'b.ts', path: 'b.ts', isDirectory: false, size: 3, modifiedAt: 0 },
        { name: 'c.ts', path: 'c.ts', isDirectory: false, size: 3, modifiedAt: 0 },
        { name: 'dir', path: 'dir', isDirectory: true, size: 0, modifiedAt: 0 },
        { name: 'Test', path: 'Test', isDirectory: true, size: 0, modifiedAt: 0 },
        { name: 'synth', path: 'synth', isDirectory: true, size: 0, modifiedAt: 0 },
      ],
      'p1/Test': [
        { name: 'Test.txt', path: 'Test/Test.txt', isDirectory: false, size: 3, modifiedAt: 0 },
      ],
      'p1/synth': [
        {
          name: 'node_modules',
          path: 'synth/node_modules',
          isDirectory: true,
          size: 0,
          modifiedAt: 0,
        },
      ],
    },
    expandedProjects: new Set(['p1']),
    expandedDirs: new Set(['p1/Test', 'p1/synth']),
    showHidden: false,
  })
  gitState.statusByProject = {
    p1: [
      status([
        { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
        { path: 'b.ts', kind: 'added', staged: true, unstaged: false },
        { path: 'c.ts', kind: 'untracked', staged: false, unstaged: false },
        { path: 'dir/x.ts', kind: 'modified', staged: false, unstaged: true },
        // Новый каталог с файлом: `--untracked-files=all` отдаёт файл поимённо.
        { path: 'Test/Test.txt', kind: 'untracked', staged: false, unstaged: false },
        // Игнорируемый каталог — одной записью.
        { path: 'synth/node_modules/', kind: 'ignored', staged: false, unstaged: false },
      ]),
    ],
  }
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  document.body.innerHTML = ''
})

describe('FilesTab — подсветка изменений рабочего дерева', () => {
  it('modified: точка и оранжевое название', async () => {
    const container = await renderTree()

    const dot = container.querySelector('[data-tree-node="p1::a.txt"] [data-vcs-dot="modified"]')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('bg-status-caution')
    expect(nodeLabel(container, 'a.txt').className).toContain('text-status-caution')
  })

  it('added: зелёная точка и зелёное название', async () => {
    const container = await renderTree()

    const dot = container.querySelector('[data-tree-node="p1::b.ts"] [data-vcs-dot="added"]')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('bg-status-success')
    expect(nodeLabel(container, 'b.ts').className).toContain('text-status-success')
  })

  it('untracked: зелёное название без точки', async () => {
    const container = await renderTree()

    expect(container.querySelector('[data-tree-node="p1::c.ts"] [data-vcs-dot]')).toBeNull()
    const label = nodeLabel(container, 'c.ts')
    expect(label.className).toContain('text-status-success')
    expect(label.className).not.toContain('text-muted-foreground')
  })

  it('новый каталог и файл в нём: оба untracked — зелёные, без точек', async () => {
    const container = await renderTree()

    const dir = container.querySelector<HTMLElement>('[data-tree-node="p1::Test"]')
    expect(dir).not.toBeNull()
    expect(dir!.querySelector('[data-vcs-dot]')).toBeNull()
    expect(nodeLabel(container, 'Test').className).toContain('text-status-success')

    const file = container.querySelector<HTMLElement>('[data-tree-node="p1::Test/Test.txt"]')
    expect(file).not.toBeNull()
    expect(file!.querySelector('[data-vcs-dot]')).toBeNull()
    expect(nodeLabel(container, 'Test/Test.txt', 'Test.txt').className).toContain(
      'text-status-success',
    )
  })

  it('игнорируемый каталог приглушён, родитель — нет', async () => {
    const container = await renderTree()

    const ignored = container.querySelector<HTMLElement>('[data-tree-node="p1::synth/node_modules"]')
    expect(ignored).not.toBeNull()
    expect(ignored!.querySelector('[data-vcs-dot]')).toBeNull()
    expect(nodeLabel(container, 'synth/node_modules', 'node_modules').className).toContain(
      'text-muted-foreground/50',
    )

    // `synth` не приглушается из-за игнорируемого `synth/node_modules`.
    const parent = container.querySelector<HTMLElement>('[data-tree-node="p1::synth"]')
    expect(parent).not.toBeNull()
    expect(parent!.querySelector('[data-vcs-dot]')).toBeNull()
    const parentLabel = nodeLabel(container, 'synth')
    expect(parentLabel.className).not.toContain('text-muted-foreground')
    expect(parentLabel.className).toContain('text-foreground')
  })

  it('каталог с изменениями внутри получает точку-агрегат', async () => {
    const container = await renderTree()

    const dirNode = container.querySelector<HTMLElement>('[data-tree-node="p1::dir"]')
    expect(dirNode).not.toBeNull()
    const dot = dirNode!.querySelector('[data-vcs-dot]')
    expect(dot).not.toBeNull()
    expect(dot!.getAttribute('data-vcs-dot')).toBe('modified')
  })

  it('шапка проекта показывает число tracked-изменений', async () => {
    const container = await renderTree()

    const badge = container.querySelector<HTMLElement>('[data-testid="file-project-changes-p1"]')
    expect(badge).not.toBeNull()
    // modified + added + dir/x.ts (untracked в счётчик не входит).
    expect(badge!.textContent).toBe('3')
    expect(badge!.getAttribute('title')).toBe('git.changes.count')
  })

  it('у tracked-файла в меню есть «Показать изменения»', async () => {
    const container = await renderTree()

    const node = container.querySelector<HTMLElement>('[data-tree-node="p1::a.txt"]')!
    const buttons = node.querySelectorAll('button')
    await act(async () => {
      ;(buttons[buttons.length - 1] as HTMLButtonElement).click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], button')].map(
      (b) => (b.textContent ?? '').trim(),
    )
    expect(items).toContain('git.changes.showDiff')
  })

  it('«Показать изменения» открывает ту же вкладку файла в режиме diff', async () => {
    const container = await renderTree()

    const node = container.querySelector<HTMLElement>('[data-tree-node="p1::a.txt"]')!
    const buttons = node.querySelectorAll('button')
    await act(async () => {
      ;(buttons[buttons.length - 1] as HTMLButtonElement).click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (b) => (b.textContent ?? '').trim() === 'git.changes.showDiff',
    )!
    await act(async () => {
      item.click()
    })

    const tabs = useUIStore.getState().centerTabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({
      id: 'file-p1/a.txt',
      type: 'file-viewer',
      title: 'a.txt',
      data: { projectId: 'p1', filePath: 'a.txt', viewMode: 'diff' },
    })
  })

  it('у untracked-файла пункта «Показать изменения» нет', async () => {
    const container = await renderTree()

    const node = container.querySelector<HTMLElement>('[data-tree-node="p1::c.ts"]')!
    const buttons = node.querySelectorAll('button')
    await act(async () => {
      ;(buttons[buttons.length - 1] as HTMLButtonElement).click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], button')].map(
      (b) => (b.textContent ?? '').trim(),
    )
    // Меню открылось (есть пункты), но diff у untracked бессмысленен.
    expect(items).toContain('file.move')
    expect(items).not.toContain('git.changes.showDiff')
  })
})

describe('FilesTab — поллинг статуса рабочего дерева', () => {
  it('опрашивает только раскрытые проекты с зарегистрированными репозиториями', async () => {
    // p1 — раскрыт и с репозиториями (текущий проект);
    // p2 — с репозиториями, но не раскрыт; p3 — раскрыт, репозиториев нет;
    // p4 — раскрыт, `repos: null`.
    useProjectsStore.setState({
      projects: [
        { id: 'p1', name: 'P1', workspace: '/w1', repos: [{ path: '' }] },
        { id: 'p2', name: 'P2', workspace: '/w2', repos: [{ path: '' }] },
        { id: 'p3', name: 'P3', workspace: '/w3', repos: [] },
        { id: 'p4', name: 'P4', workspace: '/w4', repos: null },
      ] as never,
      loadProjects: vi.fn(async () => {}),
    })
    useFilesStore.setState({ expandedProjects: new Set(['p1', 'p3', 'p4']) })

    await renderTree()

    const called = new Set(gitState.loadStatus.mock.calls.map((call) => call[0]))
    expect(called).toEqual(new Set(['p1']))
  })
})
