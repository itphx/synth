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
  getProjectsPage: vi.fn(),
  getProject: vi.fn(),
  listSshKeys: vi.fn(),
  scanGitRepos: vi.fn(),
  initGitRepo: vi.fn(),
  cloneGitRepo: vi.fn(),
  registerGitRepo: vi.fn(),
  removeGitRepo: vi.fn(),
  fetchGitRepo: vi.fn(),
  deleteEntry: vi.fn(),
  moveEntry: vi.fn(),
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
  // Список проектов пагинирован: страница повторяет данные списка.
  mocks.getProjectsPage.mockImplementation(async () => ({
    projects: (await mocks.getProjects()) as never[],
    total: 0,
    offset: 0,
    limit: 100,
    next_offset: null,
  }))
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
    // Список проектов пагинирован: страница повторяет данные списка.
    mocks.getProjectsPage.mockImplementation(async () => ({
      projects: (await mocks.getProjects()) as never[],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }))
    useProjectsStore.setState({ projects: [{ ...PROJECT, repos: [] }] as never })

    const container = await renderGitTab()
    expect(container.textContent ?? '').not.toContain('VendorLib')
  })
})

// ---------------------------------------------------------------------------
// Busy-состояния, отмена клона, защита от двойного сабмита и 409 «путь занят»
// ---------------------------------------------------------------------------

/** Доводит отложенные промисы эффектов/обработчиков до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Значение контролируемого input (React 19 слушает нативный setter). */
async function setInput(testId: string, value: string): Promise<void> {
  const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null
  expect(input, `поле ${testId} не найдено`).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input!, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Клик по элементу с `data-testid` (поповер рендерится в портал → `document`). */
async function clickTestId(testId: string): Promise<void> {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  expect(el, `элемент ${testId} не найден`).toBeTruthy()
  await act(async () => {
    el!.click()
  })
  await flush()
}

/** Открывает поповер «Добавить репозиторий» (режим клона выбран по умолчанию). */
async function openAddRepoPopover(container: HTMLElement): Promise<void> {
  const add = container.querySelector('button[title="Add repository"]') as HTMLElement | null
  expect(add, 'кнопка «Добавить репозиторий» не найдена').toBeTruthy()
  await act(async () => {
    add!.click()
  })
  await flush()
  expect(document.querySelector('[data-testid="git-clone-url"]')).not.toBeNull()
}

/** Клон, который «идёт» до явной отмены (`AbortSignal`) — как реальная сеть. */
function cloneUntilAborted(): void {
  mocks.cloneGitRepo.mockImplementation(
    (_p: string, _u: string, _path?: string, _b?: string, _n?: string, _k?: string, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }),
  )
}

describe('GitTab — индикация, отмена и защита от двойного сабмита', () => {
  it('повторный клик по «Клонировать» не отправляет второй запрос', async () => {
    cloneUntilAborted()

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')

    const submit = document.querySelector('[data-testid="git-clone-submit"]') as HTMLElement
    // Два клика в одном тике: перерисовки между ними нет, спасает только ref-guard.
    await act(async () => {
      submit.click()
      submit.click()
    })
    await flush()

    expect(mocks.cloneGitRepo).toHaveBeenCalledTimes(1)
  })

  it('во время клона: спиннер, подпись «Cloning…», кнопка «Отмена»', async () => {
    cloneUntilAborted()

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    const submit = document.querySelector('[data-testid="git-clone-submit"]') as HTMLElement
    expect(submit.textContent).toContain('Cloning…')
    expect(submit.getAttribute('aria-busy')).toBe('true')
    expect(submit.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-testid="git-clone-cancel"]')).not.toBeNull()
    // Подсказка про длительность сетевой операции.
    expect(document.body.textContent).toContain('may take several minutes')
  })

  it('«Отмена» прерывает клон: нейтральное уведомление, не ошибка, форма жива', async () => {
    cloneUntilAborted()

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')
    await clickTestId('git-clone-cancel')

    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', text: 'Clone cancelled' }))
    expect(document.querySelector('[data-testid="git-action-error"]')).toBeNull()
    // Состояние сброшено: кнопка снова «Clone», поле ввода на месте.
    expect((document.querySelector('[data-testid="git-clone-submit"]') as HTMLElement).textContent).toContain('Clone')
    expect((document.querySelector('[data-testid="git-clone-submit"]') as HTMLElement).hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('[data-testid="git-clone-url"]')).not.toBeNull()
    expect(useGitStore.getState().error).toBeNull()
  })

  it('закрытие поповера прерывает клон и сбрасывает busy-состояние', async () => {
    cloneUntilAborted()

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    // Повторный клик по «Добавить репозиторий» закрывает поповер (openAddRepo → closePopover).
    const add = container.querySelector('button[title="Add repository"]') as HTMLElement
    await act(async () => {
      add.click()
    })
    await flush()

    expect(document.querySelector('[data-testid="git-clone-submit"]')).toBeNull()
    await openAddRepoPopover(container)
    expect((document.querySelector('[data-testid="git-clone-submit"]') as HTMLElement).textContent).toContain('Clone')
    expect(mocks.cloneGitRepo).toHaveBeenCalledTimes(1)
  })

  it('fetch: спиннер в строке репозитория и блокировка остальных сетевых действий', async () => {
    const second = { ...REPO, id: 'r2', path: 'vendor/two', name: 'VendorTwo' }
    mocks.getProjects.mockResolvedValue([{ ...PROJECT, repos: [REPO, second] }])
    // Список проектов пагинирован: страница повторяет данные списка.
    mocks.getProjectsPage.mockImplementation(async () => ({
      projects: (await mocks.getProjects()) as never[],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }))
    useProjectsStore.setState({ projects: [{ ...PROJECT, repos: [REPO, second] }] as never })

    let finishFetch: (value: unknown) => void = () => {}
    mocks.fetchGitRepo.mockImplementation(
      () => new Promise((resolve) => {
        finishFetch = resolve
      }),
    )

    const container = await renderGitTab()
    const fetchButtons = Array.from(container.querySelectorAll('button[title="Fetch"]')) as HTMLElement[]
    expect(fetchButtons).toHaveLength(2)

    await act(async () => {
      fetchButtons[0]!.click()
    })
    await flush()

    const busy = container.querySelector('[data-testid="git-busy-p1::vendor/lib"]')
    expect(busy).not.toBeNull()
    expect(busy?.textContent).toContain('Fetching…')

    // Второй fetch во время первого не уходит в API.
    await act(async () => {
      fetchButtons[1]!.click()
    })
    await flush()
    expect(mocks.fetchGitRepo).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishFetch({ path: 'vendor/lib', lastFetch: '2026-03-03T00:00:00Z' })
    })
    await flush()
    expect(container.querySelector('[data-testid="git-busy-p1::vendor/lib"]')).toBeNull()
  })
})

describe('GitTab — 409 «путь занят»: actionable-действия по details.occupied', () => {
  it('repo → «Зарегистрировать существующий» вызывает registerGitRepo с путём из details', async () => {
    mocks.cloneGitRepo.mockRejectedValue(
      Object.assign(new Error('Repository is taken'), {
        status: 409,
        code: 'git.repo_exists',
        details: { path: 'taken', occupied: 'repo' },
      }),
    )
    mocks.registerGitRepo.mockResolvedValue({ id: 'r9', path: 'taken' })

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    const errorBlock = document.querySelector('[data-testid="git-action-error"]')
    expect(errorBlock?.textContent).toContain('Repository is taken')

    await clickTestId('git-occupied-register')

    expect(mocks.registerGitRepo).toHaveBeenCalledTimes(1)
    expect(mocks.registerGitRepo).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ path: 'taken', url: 'https://example.com/app.git', type: 'https' }),
    )
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Existing repository registered' }),
    )
  })

  it('stub → «Удалить и повторить» удаляет каталог и повторяет клон', async () => {
    mocks.cloneGitRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('Incomplete clone'), {
          status: 409,
          code: 'git.repo_exists',
          details: { path: 'half', occupied: 'stub' },
        }),
      )
      .mockResolvedValueOnce({ path: 'half', isRepo: true })
    mocks.deleteEntry.mockResolvedValue({ deleted: true, path: 'half' })

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    expect(document.querySelector('[data-testid="git-occupied-delete-retry"]')).not.toBeNull()

    await clickTestId('git-occupied-delete-retry')

    expect(mocks.deleteEntry).toHaveBeenCalledWith('p1', 'half')
    expect(mocks.cloneGitRepo).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text: 'Repository cloned' }),
    )
  })

  it('stub с непустым каталогом: удаление невозможно → каталог отложен, клон повторён', async () => {
    mocks.cloneGitRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('Incomplete clone'), {
          status: 409,
          code: 'git.repo_exists',
          details: { path: 'half', occupied: 'stub' },
        }),
      )
      .mockResolvedValueOnce({ path: 'half', isRepo: true })
    // `DELETE /fs` не сносит непустой каталог (рекурсивного удаления в API нет).
    mocks.deleteEntry.mockRejectedValueOnce(Object.assign(new Error('Directory is not empty'), { status: 400 }))
    mocks.moveEntry.mockResolvedValueOnce({ moved: true, sourcePath: 'half', targetPath: 'half.incomplete' })

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')
    await clickTestId('git-occupied-delete-retry')

    expect(mocks.moveEntry).toHaveBeenCalledWith('p1', 'half', 'half.incomplete')
    expect(mocks.cloneGitRepo).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text: 'Incomplete clone kept at "half.incomplete"' }),
    )
  })

  it('dir → «Указать другой путь» фокусирует поле и не закрывает поповер', async () => {
    mocks.cloneGitRepo.mockRejectedValue(
      Object.assign(new Error('Directory is not empty'), {
        status: 409,
        code: 'git.repo_exists',
        details: { path: 'busy', occupied: 'dir', entries: 2 },
      }),
    )

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    await clickTestId('git-occupied-choose-path')

    const pathInput = document.querySelector('[data-testid="git-clone-path"]')
    expect(pathInput).not.toBeNull()
    expect(document.activeElement).toBe(pathInput)
    expect(document.querySelector('[data-testid="git-clone-submit"]')).not.toBeNull()
    // Повторного клона действие не запускает.
    expect(mocks.cloneGitRepo).toHaveBeenCalledTimes(1)
  })

  it('409 без details → прежний текст без actionable-кнопок', async () => {
    mocks.cloneGitRepo.mockRejectedValue(
      Object.assign(new Error('Conflict'), { status: 409, code: 'git.repo_exists' }),
    )

    const container = await renderGitTab()
    await openAddRepoPopover(container)
    await setInput('git-clone-url', 'https://example.com/app.git')
    await clickTestId('git-clone-submit')

    expect(document.querySelector('[data-testid="git-action-error"]')?.textContent).toContain('Conflict')
    expect(document.querySelector('[data-testid="git-occupied-register"]')).toBeNull()
    expect(document.querySelector('[data-testid="git-occupied-delete-retry"]')).toBeNull()
    expect(document.querySelector('[data-testid="git-occupied-choose-path"]')).toBeNull()
  })
})
