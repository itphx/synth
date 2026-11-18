import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
  i18nText: (key: string) => key,
  useI18nStore: (selector: (s: { dictionary: Record<string, unknown> }) => unknown) =>
    selector({ dictionary: {} }),
}))

/** CodeMirror в jsdom не гоняем: мок отдаёт текст в `<pre>` и режим. */
vi.mock('@/components/chat/CodeEditor', () => ({
  CodeEditor: ({
    value,
    filePath,
    readOnly,
    testId,
  }: {
    value: string
    filePath: string
    readOnly?: boolean
    testId?: string
  }) =>
    React.createElement(
      'pre',
      {
        'data-testid': testId ?? 'code-editor',
        'data-file-path': filePath,
        'data-readonly': readOnly ? 'true' : 'false',
      },
      value,
    ),
}))

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  updateTabData: vi.fn(),
  readFile: vi.fn(),
  getGitDiff: vi.fn(),
  downloadFile: vi.fn(
    (projectId: string, path: string) =>
      `/api/v2/fs/download?project_id=${projectId}&path=${path}`,
  ),
  rawFileUrl: vi.fn(
    (projectId: string, path: string) => `/api/v2/fs/raw?project_id=${projectId}&path=${path}`,
  ),
  probeRawFile: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

/**
 * Стор Git: видимость «Изменений» зависит от снимка статуса (`statusByProject`),
 * а просмотрщик при монтировании запрашивает его принудительно.
 */
const gitState = vi.hoisted(() => ({
  statusByProject: {} as Record<string, unknown[]>,
  loadStatus: vi.fn(async () => {}),
}))

vi.mock('@/stores/gitStore', () => ({
  useGitStore: (selector: (s: typeof gitState) => unknown) => selector(gitState),
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openTab: mocks.openTab,
      updateTabData: mocks.updateTabData,
      fileViewerWidth: 'column',
      setFileViewerWidth: () => {},
    }),
}))

import { FileViewerTab } from './FileViewerTab'
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

function fileTab(filePath: string, viewMode?: 'preview' | 'source' | 'diff'): CenterTab {
  return {
    id: `tab-${filePath}`,
    type: 'file-viewer',
    title: filePath.split('/').pop() ?? filePath,
    data: { projectId: 'p1', filePath, ...(viewMode ? { viewMode } : {}) },
  }
}

/** Снимок статуса: один репозиторий с записями `files`. */
function status(repoPath: string, files: Array<Record<string, unknown>>) {
  return { path: repoPath, branch: 'main', files }
}

const SAMPLE_DIFF = [
  'diff --git a/a.ts b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '+const b = 2',
  '-const c = 3',
].join('\n')

describe('FileViewerTab — режим «Изменения» (ADR-076, этап 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readFile.mockResolvedValue({
      path: 'x',
      content: 'const a = 1',
      size: 12,
      encoding: 'utf-8',
    })
    mocks.probeRawFile.mockResolvedValue({ ok: true, status: 200, size: 10 })
    mocks.getGitDiff.mockResolvedValue({
      repo_path: 'sub',
      path: 'src/a.ts',
      kind: 'modified',
      diff: SAMPLE_DIFF,
      additions: 1,
      deletions: 1,
    })
    gitState.statusByProject = {}
    gitState.loadStatus = vi.fn(async () => {})
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

  it('снимок есть: «Изменения» переключают режим той же вкладки (не открывают git-diff)', async () => {
    gitState.statusByProject = {
      p1: [status('sub', [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }])],
    }

    const container = await render(<FileViewerTab tab={fileTab('sub/src/a.ts')} />)

    const button = container.querySelector<HTMLElement>('[data-testid="file-view-mode-diff"]')
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('file.viewMode.diff')

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.updateTabData).toHaveBeenCalledWith('tab-sub/src/a.ts', { viewMode: 'diff' })
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('untracked: «Изменения» есть (diff нового файла полезен), ignored: кнопки нет', async () => {
    gitState.statusByProject = {
      p1: [
        status('', [
          { path: 'new.ts', kind: 'untracked', staged: false, unstaged: false },
          { path: 'tmp.log', kind: 'ignored', staged: false, unstaged: false },
        ]),
      ],
    }

    const untracked = await render(<FileViewerTab tab={fileTab('new.ts')} />)
    expect(untracked.querySelector('[data-testid="file-view-mode-diff"]')).not.toBeNull()

    const ignored = await render(<FileViewerTab tab={fileTab('tmp.log')} />)
    expect(ignored.querySelector('[data-testid="file-view-mode-diff"]')).toBeNull()
  })

  it('файл вне зарегистрированных репозиториев: кнопки нет', async () => {
    gitState.statusByProject = {
      p1: [status('sub', [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true }])],
    }

    const container = await render(<FileViewerTab tab={fileTab('other/b.ts')} />)
    expect(container.querySelector('[data-testid="file-view-mode-diff"]')).toBeNull()
  })

  it('баг владельца: кнопка видна до загрузки снимка, статус запрашивается один раз', async () => {
    const container = await render(<FileViewerTab tab={fileTab('a.ts')} />)

    expect(gitState.loadStatus).toHaveBeenCalledTimes(1)
    expect(gitState.loadStatus).toHaveBeenCalledWith('p1', { force: true })
    // Снимка ещё нет — кнопка не мигает пропажей.
    expect(container.querySelector('[data-testid="file-view-mode-diff"]')).not.toBeNull()
  })

  it('режим diff: грузит getGitDiff с путём относительно репозитория и staged', async () => {
    gitState.statusByProject = {
      p1: [status('sub', [{ path: 'src/a.ts', kind: 'modified', staged: true, unstaged: false }])],
    }

    const container = await render(<FileViewerTab tab={fileTab('sub/src/a.ts', 'diff')} />)
    await act(async () => {})

    expect(mocks.getGitDiff).toHaveBeenCalledWith('p1', 'sub', {
      path: 'src/a.ts',
      staged: true,
    })

    const pre = container.querySelector<HTMLElement>('[data-testid="file-diff-content"]')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('+const b = 2')
    expect(pre!.textContent).toContain('-const c = 3')
    expect(container.querySelector('[data-testid="file-diff-stats"]')?.textContent).toContain('+1')
  })

  it('режим diff: unstaged-правка — staged=false', async () => {
    gitState.statusByProject = {
      p1: [status('', [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true }])],
    }

    await render(<FileViewerTab tab={fileTab('a.ts', 'diff')} />)
    await act(async () => {})

    expect(mocks.getGitDiff).toHaveBeenCalledWith('p1', '', { path: 'a.ts', staged: false })
  })

  it('режим diff: пустой diff — пустое состояние', async () => {
    gitState.statusByProject = {
      p1: [status('', [{ path: 'a.ts', kind: 'untracked', staged: false, unstaged: false }])],
    }
    mocks.getGitDiff.mockResolvedValue({ repo_path: '', path: 'a.ts', diff: '' })

    const container = await render(<FileViewerTab tab={fileTab('a.ts', 'diff')} />)
    await act(async () => {})

    expect(container.querySelector('[data-testid="file-diff-content-empty"]')).not.toBeNull()
  })

  it('режим diff: binary — бейдж, diff_truncated — плашка', async () => {
    gitState.statusByProject = {
      p1: [status('', [{ path: 'img/logo.png', kind: 'modified', staged: false, unstaged: true }])],
    }
    mocks.readFile.mockResolvedValue({ path: 'x', encoding: 'binary', content: '', size: 10 })
    mocks.probeRawFile.mockResolvedValue({ ok: true, status: 200, size: 10 })
    mocks.getGitDiff.mockResolvedValue({
      repo_path: '',
      path: 'img/logo.png',
      diff: SAMPLE_DIFF,
      binary: true,
      diff_truncated: true,
    })

    const container = await render(<FileViewerTab tab={fileTab('img/logo.png', 'diff')} />)
    await act(async () => {})

    expect(container.querySelector('[data-testid="file-diff-binary"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="file-diff-truncated"]')).not.toBeNull()
  })

  it('режим diff: ошибка — понятный текст и повтор', async () => {
    gitState.statusByProject = {
      p1: [status('', [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true }])],
    }
    mocks.getGitDiff.mockRejectedValue(new Error('boom'))

    const container = await render(<FileViewerTab tab={fileTab('a.ts', 'diff')} />)
    await act(async () => {})

    expect(container.querySelector('[data-testid="file-diff-error"]')?.textContent).toContain(
      'file.diffError',
    )

    mocks.getGitDiff.mockResolvedValue({ repo_path: '', path: 'a.ts', diff: SAMPLE_DIFF })
    const retry = container.querySelector<HTMLElement>('[data-testid="file-diff-retry"]')
    expect(retry).not.toBeNull()
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.getGitDiff).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="file-diff-content"]')).not.toBeNull()
  })

  it('кнопка «Обновить» перезапрашивает diff', async () => {
    gitState.statusByProject = {
      p1: [status('', [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true }])],
    }

    const container = await render(<FileViewerTab tab={fileTab('a.ts', 'diff')} />)
    await act(async () => {})
    expect(mocks.getGitDiff).toHaveBeenCalledTimes(1)

    const refresh = container.querySelector<HTMLElement>('[data-testid="file-diff-refresh"]')
    await act(async () => {
      refresh!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.getGitDiff).toHaveBeenCalledTimes(2)
  })

  it('файл вне репозитория в режиме diff — пустое состояние без запроса', async () => {
    gitState.statusByProject = {
      p1: [status('sub', [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true }])],
    }

    const container = await render(<FileViewerTab tab={fileTab('other/b.ts', 'diff')} />)
    await act(async () => {})

    expect(mocks.getGitDiff).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="file-diff-empty"]')).not.toBeNull()
  })
})
