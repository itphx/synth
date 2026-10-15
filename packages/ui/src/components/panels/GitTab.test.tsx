import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в примонтированных сторах пишет в localStorage — в Node/vitest его нет.
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

  // useAdaptiveIcons создаёт ResizeObserver — в jsdom его нет.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, configurable: true })
  }
})

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getProject: vi.fn(),
  listSshKeys: vi.fn(),
  scanGitRepos: vi.fn(),
  initGitRepo: vi.fn(),
  cloneGitRepo: vi.fn(),
  registerGitRepo: vi.fn(),
  removeGitRepo: vi.fn(),
  fetchGitRepo: vi.fn(),
  getCommitLog: vi.fn(),
  getCommitDetail: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { LeftPanel } from './LeftPanel'
import { useProjectsStore } from '@/stores/projectsStore'
import { useGitStore } from '@/stores/gitStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const REPO = {
  id: 'r1',
  path: 'vendor/lib',
  name: 'VendorLib',
  url: 'git@example.com:lib.git',
  type: 'ssh' as const,
  defaultBranch: 'main',
  sshKeyId: 'k1',
  lastFetch: '2026-01-01T00:00:00Z',
}

const PROJECT = {
  id: 'p1',
  name: 'Proj',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [REPO],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

async function renderGitTab(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <LeftPanel />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

beforeEach(() => {
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.listSshKeys.mockResolvedValue([
    { id: 'k1', name: 'deploy-key', type: 'user', agentIds: [], createdAt: '' },
  ])

  useUIStore.setState({ leftPanelTab: 'git', centerTabs: [], activeCenterTabId: null, onlyActiveProject: false })
  useProjectsStore.setState({ projects: [PROJECT] as never, loading: false, error: null })
  useGitStore.setState({
    reposByProject: {},
    commitsByRepo: {},
    expandedProjects: new Set(['p1']),
    expandedRepos: new Set(),
    loading: false,
    error: null,
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

describe('GitTab — реестр репозиториев (ADR-076)', () => {
  it('показывает запись реестра: name, destination (path), type и SSH-ключ', async () => {
    const container = await renderGitTab()
    const text = container.textContent ?? ''

    expect(text).toContain('VendorLib') // name
    expect(text).toContain('vendor/lib') // destination
    expect(text).toContain('ssh') // type badge
    expect(text).toContain('Destination:')
    expect(text).toContain('deploy-key') // имя SSH-ключа
    expect(text).toContain('2026') // lastFetch
  })

  it('не показывает удалённую запись при пустом реестре', async () => {
    mocks.getProjects.mockResolvedValue([{ ...PROJECT, repos: [] }])
    useProjectsStore.setState({ projects: [{ ...PROJECT, repos: [] }] as never })

    const container = await renderGitTab()
    expect(container.textContent ?? '').not.toContain('VendorLib')
  })
})
