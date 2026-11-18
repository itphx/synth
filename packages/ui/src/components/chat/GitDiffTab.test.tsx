import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  getGitDiff: vi.fn(),
  openTab: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { getGitDiff: mocks.getGitDiff } }))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (s: { openTab: typeof mocks.openTab }) => unknown) =>
    selector({ openTab: mocks.openTab }),
}))

import { GitDiffTab } from './GitDiffTab'
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

function diffTab(data: CenterTab['data']): CenterTab {
  return { id: 'tab-diff', type: 'git-diff', title: 'Изменения', data }
}

const SAMPLE_DIFF = ['diff --git a/a.ts b/a.ts', '@@ -1,2 +1,3 @@', ' const a = 1', '+const b = 2', '-const c = 3'].join('\n')

describe('GitDiffTab — diff рабочего дерева (ADR-076, этап 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getGitDiff.mockResolvedValue({
      repo_path: '',
      path: 'src/a.ts',
      kind: 'modified',
      diff: SAMPLE_DIFF,
      additions: 1,
      deletions: 1,
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
  })

  it('загружает diff файла и рисует строки', async () => {
    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: 'sub', gitPath: 'src/a.ts' })} />)

    expect(mocks.getGitDiff).toHaveBeenCalledWith('p1', 'sub', { path: 'src/a.ts', staged: false })

    // Заголовок файла — его basename, рядом полный путь.
    expect(container.textContent).toContain('a.ts')
    expect(container.textContent).toContain('sub/src/a.ts')

    const pre = container.querySelector<HTMLElement>('[data-testid="git-diff-content"]')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('+const b = 2')
    expect(pre!.textContent).toContain('-const c = 3')
    expect(pre!.textContent).toContain('@@ -1,2 +1,3 @@')
  })

  it('без пути — заголовок «Все изменения», со staged — «Индекс»', async () => {
    const all = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '' })} />)
    expect(mocks.getGitDiff).toHaveBeenCalledWith('p1', '', { path: undefined, staged: false })
    expect(all.textContent).toContain('git.changes.all')

    const first = roots.pop()!
    await act(async () => {
      first.root.unmount()
    })
    first.container.remove()

    const staged = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '', gitStaged: true })} />)
    expect(mocks.getGitDiff).toHaveBeenLastCalledWith('p1', '', { path: undefined, staged: true })
    expect(staged.textContent).toContain('git.changes.index')
  })

  it('diff_truncated → плашка «diff обрезан»', async () => {
    mocks.getGitDiff.mockResolvedValue({
      repo_path: '',
      path: 'src/big.bin',
      diff: SAMPLE_DIFF,
      diff_truncated: true,
    })

    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '', gitPath: 'src/big.bin' })} />)

    expect(container.querySelector('[data-testid="git-diff-truncated"]')).not.toBeNull()
    expect(container.textContent).toContain('commit.diffTruncated')
  })

  it('binary → бейдж «Бинарный файл»', async () => {
    mocks.getGitDiff.mockResolvedValue({ repo_path: '', path: 'img/logo.png', diff: '', binary: true })

    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '', gitPath: 'img/logo.png' })} />)

    expect(container.querySelector('[data-testid="git-diff-binary"]')).not.toBeNull()
    expect(container.textContent).toContain('diff.binary')
  })

  it('пустой diff → пустое состояние', async () => {
    mocks.getGitDiff.mockResolvedValue({ repo_path: '', path: 'src/a.ts', diff: '' })

    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '', gitPath: 'src/a.ts' })} />)

    expect(container.querySelector('[data-testid="git-diff-content-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('git.changes.emptyDiff')
  })

  it('ошибка API → сообщение вместо diff', async () => {
    mocks.getGitDiff.mockRejectedValue(new Error('Репозиторий не найден'))

    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: 'gone' })} />)

    expect(container.textContent).toContain('Репозиторий не найден')
    expect(container.querySelector('[data-testid="git-diff-content"]')).toBeNull()
  })

  it('«Обновить» перезапрашивает diff', async () => {
    const container = await render(<GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: '', gitPath: 'src/a.ts' })} />)
    expect(mocks.getGitDiff).toHaveBeenCalledTimes(1)

    const refresh = container.querySelector<HTMLElement>('[data-testid="git-diff-refresh"]')
    expect(refresh).not.toBeNull()
    await act(async () => {
      refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.getGitDiff).toHaveBeenCalledTimes(2)
  })

  it('«Открыть файл» открывает вкладку просмотра с путём repoPath/gitPath', async () => {
    const container = await render(
      <GitDiffTab tab={diffTab({ projectId: 'p1', repoPath: 'sub', gitPath: 'src/a.ts' })} />,
    )

    const open = container.querySelector<HTMLElement>('[data-testid="git-diff-open-file"]')
    expect(open).not.toBeNull()
    await act(async () => {
      open!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.openTab).toHaveBeenCalledWith({
      id: 'file-p1/sub/src/a.ts',
      type: 'file-viewer',
      title: 'a.ts',
      data: { projectId: 'p1', filePath: 'sub/src/a.ts' },
    })
  })
})
