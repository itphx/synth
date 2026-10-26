import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — мок для детерминизма.
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
})

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectMcp: vi.fn(),
  updateProjectMcp: vi.fn(),
  getMcpRegistry: vi.fn(),
  getProjectSkills: vi.fn(),
  updateProjectSkills: vi.fn(),
  updateProject: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  bindWorktree: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
// Стабильный notify: попадает в deps эффекта ProjectTab, иначе бесконечный ререндер.
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
// Подтверждения (ADR-044): диалог рендерится в App, здесь мок ответа.
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
// Пикер живёт в Popover: для теста логики сохранения раскрываем содержимое.
vi.mock('@/components/ui/popover', async () => {
  const ReactMod = await import('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactMod.createElement(ReactMod.Fragment, null, children)
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough }
})

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectTab } from './ProjectTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useEntityEditStore } from '@/stores/entityEditStore'
import { useWorktreesStore } from '@/stores/worktreesStore'
import type { WorktreeSummary } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
  id: 'p1',
  name: 'P',
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
  log: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

function makeWorktree(id: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id,
    projectId: 'p1',
    directory: `/ws/.worktrees/p1/${id}`,
    branch: 'feature/x',
    name: id,
    strategy: 'git',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as WorktreeSummary
}

async function renderTab(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProjectTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

/** Установить значение в React-инпут (native setter + input event). */
const setInputValue = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickEl = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.updateProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [] })
  mocks.getProjectSkills.mockResolvedValue({
    project_id: 'p1',
    skills: [],
    enabled: [],
    defaultOn: [],
  })
  mocks.updateProjectSkills.mockResolvedValue({
    project_id: 'p1',
    skills: [],
    enabled: [],
    defaultOn: [],
  })
  mocks.updateProject.mockResolvedValue(PROJECT)
  mocks.getWorkspaceRoot.mockResolvedValue({ root: '/ws', entries: [] })
  mocks.listWorktrees.mockResolvedValue([])
  mocks.createWorktree.mockResolvedValue({ worktree: makeWorktree('w2') })
  mocks.removeWorktree.mockResolvedValue(undefined)
  mocks.pruneWorktrees.mockResolvedValue({ recordsRemoved: 1, gitPruned: true })
  mocks.bindWorktree.mockResolvedValue({ id: 's1', worktree: { worktree_id: 'w1' } })
  mocks.confirm.mockResolvedValue(true)

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] }, deployment: null } as never)
  useEntityEditStore.setState({ target: null })
  useWorktreesStore.setState({ byProject: {}, loadingByProject: {}, error: null })
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

describe('ProjectTab — инвентарь worktree' + "'ов (ADR-114 §9)", () => {
  it('пустое состояние, если worktree' + "'ов нет", async () => {
    const container = await renderTab()

    expect(container.querySelector('[data-testid="project-worktrees"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="worktrees-empty"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="worktrees-list"]')).toBeNull()
  })

  it('список показывает имя, ветку и бейджи', async () => {
    mocks.listWorktrees.mockResolvedValue([
      makeWorktree('w1', { name: 'feature-x', dirty: true, attachedSessionId: 's1' }),
    ])

    const container = await renderTab()

    const row = container.querySelector('[data-testid="worktree-w1"]')!
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('feature-x')
    expect(row.textContent).toContain('feature/x')
    // Бейджи: изменения + привязан.
    expect(row.textContent).toContain(enDict['worktrees.badge.dirty'])
    expect(row.textContent).toContain(enDict['worktrees.badge.attached'])
  })

  it('создание: форма → POST /projects/:id/worktrees', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="worktrees-create-toggle"]'))
    const branch = container.querySelector('[data-testid="worktrees-branch-input"]') as HTMLInputElement
    const name = container.querySelector('[data-testid="worktrees-name-input"]') as HTMLInputElement
    expect(branch).toBeTruthy()

    await setInputValue(branch, 'feature/new')
    await setInputValue(name, 'wt-new')
    await clickEl(container.querySelector('[data-testid="worktrees-create-submit"]'))
    await act(async () => {})

    expect(mocks.createWorktree).toHaveBeenCalledWith('p1', {
      branch: 'feature/new',
      name: 'wt-new',
    })
  })

  it('удаление: 409 forceRequired → второй confirm → повтор с force', async () => {
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])
    const dirty = Object.assign(new Error('dirty'), {
      status: 409,
      code: 'WORKTREE_DIRTY',
      forceRequired: true,
    })
    mocks.removeWorktree.mockRejectedValueOnce(dirty).mockResolvedValueOnce(undefined)

    const container = await renderTab()
    await clickEl(container.querySelector('[data-testid="worktree-w1-remove"]'))
    await act(async () => {})
    await act(async () => {})

    // Первый запрос — без force; после отказа 409 — второе подтверждение.
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(1, 'p1', 'w1', {})
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(2, 'p1', 'w1', { force: true })
  })

  it('удаление: отказ на втором подтверждении ничего не удаляет', async () => {
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])
    const dirty = Object.assign(new Error('dirty'), {
      status: 409,
      code: 'WORKTREE_DIRTY',
      forceRequired: true,
    })
    mocks.removeWorktree.mockRejectedValueOnce(dirty)
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const container = await renderTab()
    await clickEl(container.querySelector('[data-testid="worktree-w1-remove"]'))
    await act(async () => {})
    await act(async () => {})

    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.confirm).toHaveBeenCalledTimes(2)
  })

  it('удаление: обычная ошибка без forceRequired — один confirm', async () => {
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])
    mocks.removeWorktree.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 409, code: 'WORKTREE_BUSY' }))

    const container = await renderTab()
    await clickEl(container.querySelector('[data-testid="worktree-w1-remove"]'))
    await act(async () => {})
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    )
  })

  it('кнопка «Привязать» привязывает worktree к сессии', async () => {
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])

    const container = await renderTab()
    expect(container.querySelector('[data-testid="worktree-w1-attach"]')).not.toBeNull()

    await clickEl(container.querySelector('[data-testid="worktree-w1-attach"]'))
    await act(async () => {})

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', 'w1')
  })

  it('кнопка «Отвязать» снимает привязку (bind с null)', async () => {
    mocks.listWorktrees.mockResolvedValue([makeWorktree('w1')])
    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          name: 'S',
          project_id: 'p1',
          settings: { model: 'm' },
          worktree: {
            worktree_id: 'w1',
            project_id: 'p1',
            repo_path: null,
            directory: '/ws/.worktrees/p1/w1',
            branch: 'feature/x',
          },
        },
      ],
    } as never)

    const container = await renderTab()
    expect(container.querySelector('[data-testid="worktree-w1-detach"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="worktree-w1-attach"]')).toBeNull()

    await clickEl(container.querySelector('[data-testid="worktree-w1-detach"]'))
    await act(async () => {})

    expect(mocks.bindWorktree).toHaveBeenCalledWith('s1', null)
  })

  it('очистка (prune) — с подтверждением', async () => {
    const container = await renderTab()

    await clickEl(container.querySelector('[data-testid="worktrees-prune"]'))
    await act(async () => {})
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.pruneWorktrees).toHaveBeenCalledWith('p1')
  })
})
