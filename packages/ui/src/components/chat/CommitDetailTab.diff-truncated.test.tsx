import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

const i18nMock = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: i18nMock.t, locale: 'ru', locales: ['ru'], setLocale: () => {} }),
}))

const mocks = vi.hoisted(() => ({
  loadCommitDetail: vi.fn(),
}))

vi.mock('@/stores/gitStore', () => ({
  useGitStore: (selector: (s: { loadCommitDetail: typeof mocks.loadCommitDetail }) => unknown) =>
    selector({ loadCommitDetail: mocks.loadCommitDetail }),
}))

import { CommitDetailTab } from './CommitDetailTab'
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

const tab: CenterTab = {
  id: 'tab-1',
  type: 'commit-detail',
  title: 'commit',
  data: { projectId: 'p1', repoPath: '', commitHash: 'abc123' },
}

/** Деталь коммита с заданным числом строк diff. */
function commitWithDiff(lines: number, diffTruncated?: boolean) {
  const diff = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')
  return {
    hash: 'abc123',
    shortHash: 'abc123',
    subject: 'subject',
    message: 'message',
    author: 'author',
    authorEmail: 'a@b.c',
    date: '2026-01-01T00:00:00.000Z',
    relativeDate: 'сейчас',
    branch: 'main',
    files: [],
    diff,
    ...(diffTruncated ? { diff_truncated: true } : {}),
  }
}

describe('CommitDetailTab — обрезанный diff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('при diff_truncated показывает плашку «diff обрезан»', async () => {
    mocks.loadCommitDetail.mockResolvedValue(commitWithDiff(10, true))

    const container = await render(<CommitDetailTab tab={tab} />)

    expect(container.querySelector('[data-testid="commit-diff-truncated"]')).not.toBeNull()
    expect(container.textContent).toContain('commit.diffTruncated')
  })

  it('обрезанный diff рисуется ограниченным числом строк', async () => {
    mocks.loadCommitDetail.mockResolvedValue(commitWithDiff(5000, true))

    const container = await render(<CommitDetailTab tab={tab} />)

    const pre = container.querySelectorAll('pre')[1]!
    // В DOM — не мегабайты: предел 500 строк.
    expect(pre.textContent!.split('\n').filter(Boolean).length).toBeLessThanOrEqual(500)
    expect(pre.textContent).toContain('+line 0')
  })

  it('целый diff (без флага) рисуется полностью и без плашки', async () => {
    mocks.loadCommitDetail.mockResolvedValue(commitWithDiff(600, false))

    const container = await render(<CommitDetailTab tab={tab} />)

    expect(container.querySelector('[data-testid="commit-diff-truncated"]')).toBeNull()
    const pre = container.querySelectorAll('pre')[1]!
    expect(pre.textContent!.split('\n').filter(Boolean).length).toBe(600)
  })
})
