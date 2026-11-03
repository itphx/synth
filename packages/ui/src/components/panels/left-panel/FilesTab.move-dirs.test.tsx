/**
 * Диалог переноса в дереве Files: каталоги для цели переноса берутся
 * рекурсивным листингом workspace. Сервер жёстко ограничивает глубину
 * (`MAX_FS_LIST_DEPTH` = 3) и обрывает обход по лимиту записей — тогда в
 * ответе `truncated: true`, и UI показывает пометку «список обрезан».
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
  listDirectory: vi.fn(),
  downloadFile: vi.fn(() => '/api/v2/fs/download'),
  moveEntry: vi.fn(async () => true),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listDirectory: mocks.listDirectory,
    downloadFile: mocks.downloadFile,
    moveEntry: mocks.moveEntry,
  },
}))

vi.mock('@/hooks/useDevice', () => ({ useDevice: () => ({ isTouch: false, deviceType: 'desktop' }) }))
vi.mock('@/hooks/useActiveProject', () => ({
  useActiveProject: () => ({ projectId: 'p1', source: 'session' }),
}))

import { FilesTab } from './FilesTab'
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

/** Открыть контекстное меню узла и выбрать пункт «Переместить». */
async function openMoveDialog(container: HTMLElement): Promise<void> {
  const node = container.querySelector('[data-tree-node="p1::a.txt"]')!
  const buttons = node.querySelectorAll('button')
  const trigger = buttons[buttons.length - 1] as HTMLButtonElement
  await act(async () => {
    trigger.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const item = [...document.body.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'file.move',
  ) as HTMLButtonElement | undefined
  expect(item).toBeTruthy()
  await act(async () => {
    item!.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectsStore.setState({
    projects: [{ id: 'p1', name: 'Project', workspace: '/w' }] as never,
    loadProjects: vi.fn(async () => {}),
  })
  useSessionsStore.setState({ loadSessions: vi.fn(async () => {}) })
  useFilesStore.setState({
    treesByProject: {
      p1: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 3, modifiedAt: 0 }],
    },
    expandedProjects: new Set(['p1']),
    expandedDirs: new Set(),
    showHidden: false,
  })
  mocks.listDirectory.mockResolvedValue({
    path: '/',
    entries: [
      { name: 'dir', path: 'dir', isDirectory: true, size: 0, modifiedAt: 0 },
    ],
    truncated: false,
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
  document.body.innerHTML = ''
})

describe('FilesTab — диалог переноса: глубина листинга и обрезка', () => {
  it('глубина рекурсивного листинга — 3 (сервер режет глубже)', async () => {
    const container = await renderTree()
    await openMoveDialog(container)

    expect(mocks.listDirectory).toHaveBeenCalledWith('p1', '', false, 3)
  })

  it('при truncated показывается пометка «список обрезан»', async () => {
    mocks.listDirectory.mockResolvedValue({
      path: '/',
      entries: [
        { name: 'dir', path: 'dir', isDirectory: true, size: 0, modifiedAt: 0 },
      ],
      truncated: true,
    })

    const container = await renderTree()
    await openMoveDialog(container)

    expect(document.body.querySelector('[data-testid="move-dirs-truncated"]')).not.toBeNull()
    expect(document.body.textContent).toContain('file.listTruncated')
  })

  it('без truncated пометки нет', async () => {
    const container = await renderTree()
    await openMoveDialog(container)

    expect(document.body.querySelector('[data-testid="move-dirs-truncated"]')).toBeNull()
  })
})
