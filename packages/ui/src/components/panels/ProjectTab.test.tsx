import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore пишет в localStorage — в Node/vitest его нет.
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
  updateProject: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
// Стабильный notify: попадает в deps эффекта ProjectTab, иначе бесконечный ререндер.
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectTab } from './ProjectTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'

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

const REGISTRY = [
  { name: 'sys', origin: 'instance', trust: 'builtin', config: { type: 'http', url: 'http://x' } },
  { name: 'srvB', origin: 'user', trust: 'community', config: { type: 'http', url: 'http://y' } },
]

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

beforeEach(() => {
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: [], knownServers: ['sys', 'srvB'] })
  mocks.updateProjectMcp.mockResolvedValue({ enabled: ['srvB'], defaultOn: ['srvB'], knownServers: ['sys', 'srvB'] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: REGISTRY })
  mocks.updateProject.mockResolvedValue(PROJECT)
  mocks.getWorkspaceRoot.mockResolvedValue({ root: '/ws', entries: [] })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', engine: 'synth', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] }, deployment: null } as never)
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

describe('ProjectTab — проектный MCP-скоуп (AD-071 §2.4)', () => {
  it('owner видит управление; системный сервер тоже управляется проектом', async () => {
    const container = await renderTab()
    expect(container.querySelector('[data-testid="project-mcp-list"]')).not.toBeNull()

    const sysRow = container.querySelector('[data-testid="project-mcp-sys"]')!
    expect(sysRow.textContent).toContain('system')
    expect(sysRow.textContent).not.toContain('the project can also disable access')
    // Системный сервер теперь тоже можно гасить на уровне проекта: два тумблера.
    expect(sysRow.querySelectorAll('button[role="switch"]')).toHaveLength(2)

    // Подсказка для системного сервера скрыта под катом.
    const sysCat = sysRow.querySelector('[data-testid="project-mcp-sys-details-toggle"]') as HTMLButtonElement
    expect(sysCat).toBeTruthy()
    expect(sysCat.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      sysCat.click()
    })
    expect(sysCat.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="project-mcp-sys-details-content"]')!.textContent).toContain('the project can also disable access')

    const srvRow = container.querySelector('[data-testid="project-mcp-srvB"]')!
    expect(srvRow.querySelectorAll('button[role="switch"]')).toHaveLength(2)
    // У обычного сервера ката нет.
    expect(srvRow.querySelector('[data-testid="project-mcp-srvB-details-toggle"]')).toBeNull()
  })

  it('owner задаёт defaultOn → PUT /projects/:id/mcp', async () => {
    const container = await renderTab()
    const srvRow = container.querySelector('[data-testid="project-mcp-srvB"]')!
    const toggles = srvRow.querySelectorAll('button[role="switch"]')
    // Второй тумблер — «По умолчанию».
    const defaultToggle = toggles[1] as HTMLButtonElement
    expect(defaultToggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      defaultToggle.click()
    })

    expect(mocks.updateProjectMcp).toHaveBeenCalledWith('p1', {
      enabled: ['srvB'],
      defaultOn: ['srvB'],
    })
    const updated = container.querySelector('[data-testid="project-mcp-srvB"]')!
    expect((updated.querySelectorAll('button[role="switch"]')[1] as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('editor/viewer не видит секцию управления', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'viewer', roles: [] } as never })
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u2: 'viewer' } })
    const container = await renderTab()
    expect(container.querySelector('[data-testid="project-mcp-list"]')).toBeNull()
    expect(mocks.getProjectMcp).not.toHaveBeenCalled()
  })

  it('LEAD видит управление независимо от владения проектом', async () => {
    useAuthStore.setState({ user: { id: 'u3', username: 'lead', roles: ['LEAD'] } as never })
    const container = await renderTab()
    expect(container.querySelector('[data-testid="project-mcp-list"]')).not.toBeNull()
  })
})

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

const apiError = (status: number, code: string, message = 'error'): Error =>
  Object.assign(new Error(message), { status, code })

describe('ProjectTab — рабочий каталог (AD-075)', () => {
  it('сохраняет введённый путь через PUT /projects/:id', async () => {
    const container = await renderTab()
    const input = container.querySelector('[data-testid="project-workspace-input"]') as HTMLInputElement
    expect(input).not.toBeNull()

    await setInputValue(input, '/home/user/ws')
    await clickEl(container.querySelector('[data-testid="project-workspace-save"]'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledWith('p1', {
      workspace: '/home/user/ws',
      confirmOutsideRoot: false,
    })
  })

  it('кнопка «Выбрать» открывает DirectoryPickerDialog по synthApi', async () => {
    const container = await renderTab()
    await clickEl(container.querySelector('[data-testid="project-workspace-browse"]'))
    await act(async () => {})

    expect(mocks.getWorkspaceRoot).toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="workspace-select-current"]')).not.toBeNull()
  })

  it('409 вне корня → ConfirmDialog → повтор с confirmOutsideRoot', async () => {
    mocks.updateProject
      .mockRejectedValueOnce(apiError(409, 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED', 'confirm'))
      .mockResolvedValueOnce({ ...PROJECT, workspace: '/outside/ws' })

    const container = await renderTab()
    const input = container.querySelector('[data-testid="project-workspace-input"]') as HTMLInputElement
    await setInputValue(input, '/outside/ws')
    await clickEl(container.querySelector('[data-testid="project-workspace-save"]'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenNthCalledWith(1, 'p1', {
      workspace: '/outside/ws',
      confirmOutsideRoot: false,
    })

    const dialog = [...document.body.querySelectorAll('[data-slot="dialog-content"]')].find(
      (d) => d.textContent?.includes('Create outside workspace root?'),
    )
    expect(dialog, 'нет ConfirmDialog вне корня').toBeTruthy()
    const confirmButton = [...dialog!.querySelectorAll('button')].find((b) => b.textContent === 'Confirm')
    await clickEl(confirmButton)
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenNthCalledWith(2, 'p1', {
      workspace: '/outside/ws',
      confirmOutsideRoot: true,
    })
  })

  it('403 (deny-политика) показывается ошибкой без повтора', async () => {
    mocks.updateProject.mockRejectedValueOnce(apiError(403, 'WORKSPACE_OUTSIDE_ROOT_DENIED', 'denied'))

    const container = await renderTab()
    const input = container.querySelector('[data-testid="project-workspace-input"]') as HTMLInputElement
    await setInputValue(input, '/outside/ws')
    await clickEl(container.querySelector('[data-testid="project-workspace-save"]'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('denied by policy'), type: 'error' }),
    )
  })

  it('managed-развёртывание — поле read-only, кнопки скрыты', async () => {
    useAuthStore.setState({ deployment: 'managed' } as never)
    const container = await renderTab()
    const input = container.querySelector('[data-testid="project-workspace-input"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(container.querySelector('[data-testid="project-workspace-browse"]')).toBeNull()
    expect(container.querySelector('[data-testid="project-workspace-save"]')).toBeNull()
    expect(container.querySelector('[data-testid="project-workspace-readonly"]')).not.toBeNull()
  })

  it('remote-проект — поле read-only, кнопки скрыты', async () => {
    mocks.getProject.mockResolvedValue({ ...PROJECT, origin: 'remote', id: 'remote:p1' })
    const container = await renderTab()
    const input = container.querySelector('[data-testid="project-workspace-input"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(container.querySelector('[data-testid="project-workspace-browse"]')).toBeNull()
    expect(container.querySelector('[data-testid="project-workspace-save"]')).toBeNull()
  })
})

describe('ProjectTab — порядок секций', () => {
  it('«План проекта» расположен выше «Рабочий каталог»', async () => {
    const container = await renderTab()
    const sectionByTitle = (title: string): HTMLElement | undefined =>
      [...container.querySelectorAll('div')].find(
        (d) => d.firstElementChild?.textContent?.trim() === title,
      ) as HTMLElement | undefined

    const plan = sectionByTitle('Project plan')
    const workspace = sectionByTitle('Working directory')
    expect(plan, 'секция «План проекта»').toBeTruthy()
    expect(workspace, 'секция «Рабочий каталог»').toBeTruthy()
    expect(
      plan!.compareDocumentPosition(workspace!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
