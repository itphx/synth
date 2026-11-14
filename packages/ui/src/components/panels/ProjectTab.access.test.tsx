import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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
})

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  getProjectMcp: vi.fn(),
  updateProjectMcp: vi.fn(),
  getMcpRegistry: vi.fn(),
  getProjectSkills: vi.fn(),
  updateProjectSkills: vi.fn(),
  getExecutionProfiles: vi.fn(),
  getDirectory: vi.fn(),
  getInstanceCapabilities: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({ useNotification: () => ({ notify: mocks.notify }) }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProjectTab } from './ProjectTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAuthStore } from '@/stores/authStore'
import { useUIStore } from '@/stores/useUIStore'
import { useInstanceCapabilitiesStore } from '@/stores/instanceCapabilitiesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
  id: 'p1',
  name: 'P',
  owner_id: 'u1',
  members: { u1: 'owner' },
  group_members: null,
  everyone_role: null,
  visibility: 'author',
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: null,
  repos: null,
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

const DIRECTORY = {
  users: [
    { id: 'u2', username: 'ivan', display_name: 'Иван' },
    { id: 'u3', username: 'petr', display_name: null },
  ],
  total: 2,
  offset: 0,
  limit: 100,
  next_offset: null,
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

const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${id}"]`)

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/**
 * Радио проекции доступа — нативный `<input type="radio">` по значению
 * (PROP-133 §4: контрол `ProjectAccessProjectionField`). Контракт контрола:
 * группа — `data-testid="project-access-group"`, радио — `project-access-<value>`.
 */
const projectionRadio = (value: string): HTMLInputElement | null =>
  document.body.querySelector(
    `[data-testid="project-access-group"] input[type="radio"][data-testid="project-access-${value}"]`,
  ) as HTMLInputElement | null

/** Все радио проекций (в порядке объявления). */
const projectionRadios = (): HTMLInputElement[] =>
  [
    ...document.body.querySelectorAll(
      '[data-testid="project-access-group"] input[type="radio"]',
    ),
  ] as HTMLInputElement[]

/** Подпись радио (текст обёртки `<label>`). */
const projectionLabel = (radio: HTMLInputElement): string =>
  radio.closest('label')?.textContent?.trim() ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.updateProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [] })
  mocks.getProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: [], defaultOn: [] })
  mocks.getExecutionProfiles.mockResolvedValue({ provider: 'remote', profiles: [], defaultProfile: '' })
  mocks.getDirectory.mockResolvedValue(DIRECTORY)
  mocks.getInstanceCapabilities.mockResolvedValue({
    messageModel: 2,
    eventSeq: true,
    replay: true,
    version: '0.13.9',
    features: { users: true },
  })
  useInstanceCapabilitiesStore.getState().resetForTests()

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
  })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: 'p1', settings: { model: 'm' } }],
  } as never)
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAuthStore.setState({ user: { id: 'u1', username: 'owner', roles: [] } as never })
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
  useInstanceCapabilitiesStore.getState().resetForTests()
})

describe('ProjectTab — блок «Доступ» (PROP-133 §4)', () => {
  it('рендерит три проекции; текущая — из DTO `visibility`', async () => {
    await renderTab()

    const radios = projectionRadios()
    expect(radios).toHaveLength(3)
    expect(radios.map((r) => r.value)).toEqual(['author', 'selected', 'all'])
    expect(radios.map(projectionLabel)).toEqual([
      enDict['project.access.author'],
      enDict['project.access.selected'],
      enDict['project.access.all'],
    ])
    expect(projectionRadio('author')?.checked).toBe(true)
    expect(projectionRadio('selected')?.checked).toBe(false)
    expect(projectionRadio('all')?.checked).toBe(false)
  })

  it('«Только выбранным»: выбор участника и роли уходит одним запросом', async () => {
    await renderTab()

    await click(projectionRadio('selected'))
    await act(async () => {})

    await click(byTestId('project-access-user-u2'))
    await act(async () => {})

    const roleSelect = byTestId('project-access-role-u2') as HTMLSelectElement
    expect(roleSelect).toBeTruthy()
    expect(roleSelect.value).toBe('viewer')

    await click(byTestId('project-access-save'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledTimes(1)
    expect(mocks.updateProject).toHaveBeenCalledWith('p1', {
      members: { u2: 'viewer' },
      everyone_role: null,
    })
  })

  it('«Только выбранным»: роль участника меняется на editor', async () => {
    await renderTab()

    await click(projectionRadio('selected'))
    await act(async () => {})
    await click(byTestId('project-access-user-u2'))
    await act(async () => {})

    const roleSelect = byTestId('project-access-role-u2') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(roleSelect, 'editor')
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await click(byTestId('project-access-save'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledWith('p1', {
      members: { u2: 'editor' },
      everyone_role: null,
    })
  })

  it('«Всем пользователям»: по умолчанию viewer, редактирование — только явным выбором', async () => {
    await renderTab()

    await click(projectionRadio('all'))
    await act(async () => {})

    const toggle = document.body.querySelector(
      '[data-testid="project-access-all-editor"] button[role="switch"]',
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await click(byTestId('project-access-save'))
    await act(async () => {})
    expect(mocks.updateProject).toHaveBeenLastCalledWith('p1', {
      members: {},
      everyone_role: 'viewer',
    })

    await click(toggle)
    await act(async () => {})
    await click(byTestId('project-access-save'))
    await act(async () => {})
    expect(mocks.updateProject).toHaveBeenLastCalledWith('p1', {
      members: {},
      everyone_role: 'editor',
    })
  })

  it('смена проекции на «Только автору» сбрасывает список участников', async () => {
    await renderTab()

    await click(projectionRadio('selected'))
    await act(async () => {})
    await click(byTestId('project-access-user-u2'))
    await act(async () => {})
    await click(projectionRadio('author'))
    await act(async () => {})
    await click(byTestId('project-access-save'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledWith('p1', {
      members: {},
      everyone_role: null,
    })
  })

  it('403 — понятное уведомление, состояние не «залипает»', async () => {
    mocks.updateProject.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    await renderTab()

    await click(projectionRadio('all'))
    await act(async () => {})
    await click(byTestId('project-access-save'))
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(enDict['project.access.forbidden']),
        type: 'error',
      }),
    )
  })

  it('400 — понятное уведомление о недопустимом состоянии', async () => {
    mocks.updateProject.mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }))
    await renderTab()

    await click(projectionRadio('all'))
    await act(async () => {})
    await click(byTestId('project-access-save'))
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(enDict['project.access.invalid']),
        type: 'error',
      }),
    )
  })

  it('EDITOR блока не видит и каталог пользователей не грузит', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'editor', roles: [] } as never })
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u2: 'editor' } })

    await renderTab()

    expect(byTestId('project-access')).toBeNull()
    expect(mocks.getDirectory).not.toHaveBeenCalled()
  })

  it('без features.users предлагается только «Только автору» (read-only)', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue({
      messageModel: 2,
      eventSeq: true,
      replay: true,
      version: '0.13.9',
      features: { users: false },
    })

    await renderTab()

    const radios = projectionRadios()
    expect(radios).toHaveLength(1)
    expect(projectionLabel(radios[0])).toBe(enDict['project.access.author'])
    expect(byTestId('project-access-save')).toBeNull()
    expect(byTestId('project-access-single-user')).not.toBeNull()
    expect(mocks.getDirectory).not.toHaveBeenCalled()
  })
})
