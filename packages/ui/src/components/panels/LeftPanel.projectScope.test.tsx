import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) пишет в localStorage, useAdaptiveIcons — ResizeObserver; в jsdom нет.
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
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  }
  return ls
})

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getProject: vi.fn(),
  getSessions: vi.fn(),
  listSshKeys: vi.fn(),
  getFileTree: vi.fn(),
  readFile: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { LeftPanel } from './LeftPanel'
import { FilesTabToolbar } from './FilesTabToolbar'
import { GitTabToolbar } from './GitTabToolbar'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useFilesStore } from '@/stores/filesStore'
import { useGitStore } from '@/stores/gitStore'
import { useUIStore, OTHER_PROJECTS_COLLAPSE_KEY } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION_S1 = { id: 's1', project_id: 'p1', name: 'Sess', updated_at: '2026-01-01T00:00:00Z' }

const P1 = {
  id: 'p1',
  name: 'Proj1',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

const P2 = { ...P1, id: 'p2', name: 'Proj2', workspace: '/ws/p2' }

const FILE_A = { name: 'alpha.txt', path: 'alpha.txt', isDirectory: false, size: 12 }
const FILE_B = { name: 'beta.txt', path: 'beta.txt', isDirectory: false, size: 34 }
const REPO_A = { id: 'r1', path: '', name: 'RepoA' }
const REPO_B = { id: 'r2', path: '', name: 'RepoB' }

async function renderScope(tab: 'files' | 'git'): Promise<HTMLElement> {
  useUIStore.setState({ leftPanelTab: tab })
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <div>
          {tab === 'files' ? <FilesTabToolbar /> : <GitTabToolbar />}
          <LeftPanel />
        </div>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

beforeEach(() => {
  storage.clear()
  mocks.getProjects.mockResolvedValue([P1, P2])
  mocks.getProject.mockResolvedValue(P1)
  mocks.getSessions.mockResolvedValue([SESSION_S1])
  mocks.listSshKeys.mockResolvedValue([])
  mocks.getFileTree.mockResolvedValue({ entries: [] })

  useUIStore.setState({
    leftPanelTab: 'files',
    centerTabs: [{ id: 'chat-s1', type: 'chat', title: 'Sess', data: { sessionId: 's1' } }],
    activeCenterTabId: 'chat-s1',
    onlyActiveProject: false,
    collapsedProjects: new Set(),
  })
  useSessionsStore.setState({ sessions: [SESSION_S1] as never, loading: false, error: null })
  useProjectsStore.setState({ projects: [P1, P2] as never, loading: false, error: null })
  useFilesStore.setState({
    treesByProject: { p1: [FILE_A], p2: [FILE_B] } as never,
    expandedProjects: new Set<string>(),
    expandedDirs: new Set<string>(),
  })
  useGitStore.setState({
    reposByProject: { p1: [REPO_A], p2: [REPO_B] } as never,
    commitsByRepo: {},
    expandedProjects: new Set<string>(),
    expandedRepos: new Set<string>(),
  })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('LeftPanel — контекст-ориентированный показ (variant C), files', () => {
  it('текущий проект закреплён и авто-раскрыт; остальные под «Другие проекты»', async () => {
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Current project')
    expect(text).toContain('Proj1')
    expect(text).toContain('alpha.txt') // авто-раскрытие текущего проекта
    expect(text).toContain('Other projects (1)')
    expect(text).toContain('Proj2')

    // текущий проект идёт до обёртки «Другие проекты»
    expect(text.indexOf('Proj1')).toBeLessThan(text.indexOf('Other projects (1)'))
    expect(text.indexOf('Other projects (1)')).toBeLessThan(text.indexOf('Proj2'))

    expect(useFilesStore.getState().expandedProjects.has('p1')).toBe(true)
  })

  it('onlyActiveProject → только закреплённый текущий', async () => {
    useUIStore.setState({ onlyActiveProject: true })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Proj1')
    expect(text).toContain('alpha.txt')
    expect(text).not.toContain('Other projects')
    expect(text).not.toContain('Proj2')
  })

  it('тумблер скрывает «Другие» и пишет в localStorage', async () => {
    const container = await renderScope('files')
    expect(container.textContent ?? '').toContain('Proj2')

    const toggle = container.querySelector('[data-project-scope-toggle]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.disabled).toBe(false)

    await act(async () => {
      toggle.click()
    })

    expect(useUIStore.getState().onlyActiveProject).toBe(true)
    const raw = storage.getItem('synth-ui-settings') ?? ''
    expect(raw).toContain('"onlyActiveProject":true')

    const text = container.textContent ?? ''
    expect(text).not.toContain('Other projects')
    expect(text).not.toContain('Proj2')
  })

  it('сворачивание обёртки «Другие проекты»', async () => {
    const container = await renderScope('files')
    expect(container.textContent ?? '').toContain('Proj2')

    const row = container.querySelector(`[data-tree-node="group:${OTHER_PROJECTS_COLLAPSE_KEY}"]`) as HTMLElement
    expect(row).toBeTruthy()
    const arrow = row.querySelector('span') as HTMLElement
    await act(async () => {
      arrow.click()
    })

    expect(useUIStore.getState().collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)).toBe(true)
    expect(container.textContent ?? '').not.toContain('Proj2')
  })

  it('сессия без проекта → инфо-строка, плоский список, тумблер disabled', async () => {
    mocks.getSessions.mockResolvedValue([{ ...SESSION_S1, project_id: null }])
    useSessionsStore.setState({ sessions: [{ ...SESSION_S1, project_id: null }] as never })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Active session has no project')
    expect(text).toContain('Proj1')
    expect(text).toContain('Proj2')
    expect(text).not.toContain('Other projects')
    expect(text).not.toContain('Current project')

    const toggle = container.querySelector('[data-project-scope-toggle]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })

  it('fallback: активная file-viewer вкладка задаёт текущий проект', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'f1', type: 'file-viewer', title: 'a', data: { projectId: 'p1', filePath: 'alpha.txt' } }],
      activeCenterTabId: 'f1',
    })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Current project')
    expect(text).toContain('Other projects (1)')
    expect(text).toContain('Proj2')
  })

  it('активный проект без workspace → инфо-строка, плоский список, disabled', async () => {
    useProjectsStore.setState({
      projects: [P1, { ...P2, workspace: '' }] as never,
      loading: false,
      error: null,
    })
    mocks.getProjects.mockResolvedValue([P1, { ...P2, workspace: '' }])
    useUIStore.setState({
      centerTabs: [{ id: 'f1', type: 'file-viewer', title: 'a', data: { projectId: 'p2', filePath: 'beta.txt' } }],
      activeCenterTabId: 'f1',
    })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Active project has no workspace')
    expect(text).toContain('Proj1')
    expect(text).not.toContain('Other projects')

    const toggle = container.querySelector('[data-project-scope-toggle]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })

  it('единственный проект с workspace → нет обёртки «Другие проекты»', async () => {
    mocks.getProjects.mockResolvedValue([P1])
    useProjectsStore.setState({ projects: [P1] as never, loading: false, error: null })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Current project')
    expect(text).toContain('Proj1')
    expect(text).not.toContain('Other projects')
  })

  it('onlyActiveProject=true без валидного контекста → плоский список', async () => {
    mocks.getSessions.mockResolvedValue([{ ...SESSION_S1, project_id: null }])
    useSessionsStore.setState({ sessions: [{ ...SESSION_S1, project_id: null }] as never })
    useUIStore.setState({ onlyActiveProject: true })
    const container = await renderScope('files')
    const text = container.textContent ?? ''

    expect(text).toContain('Proj1')
    expect(text).toContain('Proj2')
    expect(text).not.toContain('Other projects')
  })

  it('ключ обёртки переживает переключение на вкладку Projects', async () => {
    const container = await renderScope('files')
    const row = container.querySelector(`[data-tree-node="group:${OTHER_PROJECTS_COLLAPSE_KEY}"]`) as HTMLElement
    await act(async () => {
      (row.querySelector('span') as HTMLElement).click()
    })
    expect(useUIStore.getState().collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)).toBe(true)

    await act(async () => {
      useUIStore.setState({ leftPanelTab: 'projects' })
    })
    await act(async () => {})
    expect(useUIStore.getState().collapsedProjects.has(OTHER_PROJECTS_COLLAPSE_KEY)).toBe(true)
  })
})

describe('LeftPanel — контекст-ориентированный показ (variant C), git', () => {
  it('текущий проект закреплён (commit-detail) и авто-раскрыт, остальные под «Другие»', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'c1', type: 'commit-detail', title: 'c', data: { projectId: 'p1', repoPath: '', commitHash: 'h' } }],
      activeCenterTabId: 'c1',
    })
    const container = await renderScope('git')
    const text = container.textContent ?? ''

    expect(text).toContain('Current project')
    expect(text).toContain('Proj1')
    expect(text).toContain('RepoA')
    expect(text).toContain('Other projects (1)')
    expect(text).toContain('Proj2')

    expect(useGitStore.getState().expandedProjects.has('p1')).toBe(true)
  })

  it('onlyActiveProject → только текущий проект в git', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'c1', type: 'commit-detail', title: 'c', data: { projectId: 'p1', repoPath: '', commitHash: 'h' } }],
      activeCenterTabId: 'c1',
      onlyActiveProject: true,
    })
    const container = await renderScope('git')
    const text = container.textContent ?? ''

    expect(text).toContain('Proj1')
    expect(text).toContain('RepoA')
    expect(text).not.toContain('Other projects')
    expect(text).not.toContain('Proj2')
  })

  it('expand/collapse-all в git-тулбаре при onlyActiveProject работают только по видимым проектам', async () => {
    useUIStore.setState({
      centerTabs: [{ id: 'c1', type: 'commit-detail', title: 'c', data: { projectId: 'p1', repoPath: '', commitHash: 'h' } }],
      activeCenterTabId: 'c1',
      onlyActiveProject: true,
    })
    const container = await renderScope('git')

    const queryButton = () => container.querySelector('[title="Expand all"], [title="Collapse all"]') as HTMLButtonElement

    // текущий проект авто-раскрыт → кнопка предлагает свернуть
    await act(async () => {
      queryButton().click()
    })
    expect(useGitStore.getState().expandedProjects.has('p1')).toBe(false)

    // теперь кнопка «развернуть всё» раскрывает только видимый p1 (проект + репозиторий)
    await act(async () => {
      queryButton().click()
    })
    const s = useGitStore.getState()
    expect(s.expandedProjects.has('p1')).toBe(true)
    expect(s.expandedRepos.has('p1::')).toBe(true)
    // скрытый p2 остаётся нетронутым
    expect(s.expandedProjects.has('p2')).toBe(false)
    expect(s.expandedRepos.has('p2::')).toBe(false)
  })

  it('сессия без проекта в git → плоский список и disabled', async () => {
    mocks.getSessions.mockResolvedValue([{ ...SESSION_S1, project_id: null }])
    useSessionsStore.setState({ sessions: [{ ...SESSION_S1, project_id: null }] as never })
    const container = await renderScope('git')
    const text = container.textContent ?? ''

    expect(text).toContain('Active session has no project')
    expect(text).toContain('Proj1')
    expect(text).toContain('Proj2')
    expect(text).not.toContain('Other projects')

    const toggle = container.querySelector('[data-project-scope-toggle]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })
})
