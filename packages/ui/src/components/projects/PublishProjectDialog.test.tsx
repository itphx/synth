import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

/**
 * Прогресс публикации проекта: пока идёт POST `/projects/:id/publish`, диалог
 * опрашивает `GET /projects/:id/publish/progress` (600 мс), показывает процент,
 * фазу и счётчики, а на старом ядре (`404`) молча остаётся спиннер.
 */

const mocks = vi.hoisted(() => ({
  publishProject: vi.fn(),
  getPublishProgress: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { getPublishProgress: mocks.getPublishProgress },
}))
vi.mock('@/hooks/useNotification', () => ({ notifyMessage: mocks.notifyMessage }))
vi.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (selector: (state: { publishProject: typeof mocks.publishProject }) => unknown) =>
    selector({ publishProject: mocks.publishProject }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PublishProjectDialog, PUBLISH_PROGRESS_POLL_MS, formatBytes } from './PublishProjectDialog'
import {
  emptyPublishProgress,
  normalizePublishProgress,
  type ProjectData,
  type PublishProgress,
} from '@/lib/api/projects'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = {
  id: 'p1',
  name: 'Demo',
  owner_id: 'u1',
  members: { u1: 'owner' },
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: null,
  repos: null,
  status_messages: [],
  created_at: '',
  updated_at: '',
} as unknown as ProjectData

const MiB = 1024 * 1024

function snapshot(patch: Partial<PublishProgress> = {}): PublishProgress {
  return {
    active: true,
    phase: 'sessions',
    percent: 37,
    sessions: { done: 12, total: 45 },
    files: { done: 3, total: 120, bytesDone: 2.1 * MiB, bytesTotal: 50 * MiB },
    startedAt: null,
    updatedAt: null,
    error: null,
    ...patch,
  }
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function mount(open = true): Promise<{
  container: HTMLElement
  onOpenChange: ReturnType<typeof vi.fn>
  rerender: (open: boolean) => Promise<void>
}> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const onOpenChange = vi.fn()

  const render = (isOpen: boolean) =>
    root.render(
      <I18nProvider>
        <PublishProjectDialog
          open={isOpen}
          onOpenChange={onOpenChange}
          project={PROJECT}
          remoteProjects={[]}
        />
      </I18nProvider>,
    )

  await act(async () => {
    render(open)
  })
  await flush()

  return {
    container,
    onOpenChange,
    rerender: async (isOpen: boolean) => {
      await act(async () => {
        render(isOpen)
      })
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (el) => el.textContent?.trim() === label,
  )
  expect(button, `кнопка «${label}» не найдена`).toBeTruthy()
  return button as HTMLButtonElement
}

async function clickPublish(): Promise<void> {
  const button = findButton('Publish')
  await act(async () => {
    button.click()
  })
  await flush()
}

beforeEach(() => {
  // Фейкуем только таймеры опроса — rAF/Date остаются нативными (Base UI).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.publishProject.mockReset()
  mocks.getPublishProgress.mockReset()
  mocks.notifyMessage.mockReset()
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
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('PublishProjectDialog — прогресс публикации', () => {
  it('показывает процент, фазу и счётчики после первого опроса и продолжает опрос', async () => {
    mocks.publishProject.mockReturnValue(new Promise(() => {}))
    mocks.getPublishProgress
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ percent: 60, phase: 'files' }))

    await mount()
    await clickPublish()

    // Первый опрос — сразу после старта POST, без ожидания таймера.
    expect(mocks.getPublishProgress).toHaveBeenCalledTimes(1)
    expect(mocks.getPublishProgress).toHaveBeenCalledWith('p1')

    const bar = document.body.querySelector('[data-testid="publish-progress"]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('role')).toBe('progressbar')
    expect(bar!.getAttribute('aria-valuenow')).toBe('37')
    expect(document.body.textContent).toContain('37%')
    expect(document.body.textContent).toContain('Sessions')
    expect(document.body.textContent).toContain('12/45')
    expect(document.body.textContent).toContain('Files')
    expect(document.body.textContent).toContain('3/120 · 2.1 MiB / 50 MiB')

    // Цепочка setTimeout: следующий опрос через 600 мс, не параллельно.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLISH_PROGRESS_POLL_MS)
    })
    expect(mocks.getPublishProgress).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="publish-progress"]')!.getAttribute('aria-valuenow')).toBe('60')
    expect(document.body.textContent).toContain('60%')
  })

  it('после успешного POST закрывает диалог и прекращает опрос', async () => {
    mocks.publishProject.mockResolvedValue({
      ok: true,
      project_id: 'remote:r1',
      created: true,
      sessions_imported: 1,
      files_uploaded: 1,
    })
    mocks.getPublishProgress.mockResolvedValue(snapshot({ percent: 100, phase: 'done' }))

    const { onOpenChange } = await mount()
    await clickPublish()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.body.querySelector('[data-testid="publish-progress"]')).toBeNull()

    const calls = mocks.getPublishProgress.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLISH_PROGRESS_POLL_MS * 3)
    })
    expect(mocks.getPublishProgress.mock.calls.length).toBe(calls)
    expect(mocks.notifyMessage).toHaveBeenCalledTimes(1)
  })

  it('404 от опроса (старое ядро) — бара и ошибки нет, опрос прекращён', async () => {
    mocks.publishProject.mockReturnValue(new Promise(() => {}))
    mocks.getPublishProgress.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))

    await mount()
    await clickPublish()

    expect(mocks.getPublishProgress).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-testid="publish-progress"]')).toBeNull()
    // Спиннер остался, ошибка не показывается, тостов нет.
    expect(document.body.textContent).toContain('Publishing...')
    expect(mocks.notifyMessage).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLISH_PROGRESS_POLL_MS * 3)
    })
    expect(mocks.getPublishProgress).toHaveBeenCalledTimes(1)
  })

  it('переоткрытие сбрасывает прогресс и не продолжает старый опрос', async () => {
    mocks.publishProject.mockReturnValue(new Promise(() => {}))
    mocks.getPublishProgress.mockResolvedValue(snapshot())

    const { rerender } = await mount()
    await clickPublish()
    expect(document.body.querySelector('[data-testid="publish-progress"]')).not.toBeNull()

    await rerender(false)
    expect(document.body.querySelector('[data-testid="publish-progress"]')).toBeNull()

    const calls = mocks.getPublishProgress.mock.calls.length
    await rerender(true)
    // Состояние сброшено: бара нет, опрос не возобновлён без нового POST.
    expect(document.body.querySelector('[data-testid="publish-progress"]')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUBLISH_PROGRESS_POLL_MS * 3)
    })
    expect(mocks.getPublishProgress.mock.calls.length).toBe(calls)
  })

  it('normalizePublishProgress — битый ответ даёт нейтральный снимок', () => {
    expect(normalizePublishProgress(null)).toEqual(emptyPublishProgress())
    expect(normalizePublishProgress('nope')).toEqual(emptyPublishProgress())
    expect(
      normalizePublishProgress({ phase: 'nope', percent: 500, sessions: { done: -3, total: 'x' } }),
    ).toMatchObject({ active: false, phase: 'idle', percent: 100, sessions: { done: 0, total: 0 } })
  })

  it('formatBytes — 1024-основание', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2.1 * MiB)).toBe('2.1 MiB')
    expect(formatBytes(50 * MiB)).toBe('50 MiB')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})
