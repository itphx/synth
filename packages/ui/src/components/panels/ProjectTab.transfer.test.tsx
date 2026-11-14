/**
 * ADR-140 Ф3: блок «Владение» — передача владения проектом.
 *
 * Право передачи — **не** «управление содержимым»: текущий владелец или
 * `ADMIN` (`LEAD`, участники с ролью `owner` и `EDITOR` — нет; серверный
 * `canTransfer`). UI лишь прячет недоступное действие.
 */
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
  getGroupsDirectory: vi.fn(),
  getInstanceCapabilities: vi.fn(),
  getProjectLogPage: vi.fn(),
  transferProject: vi.fn(),
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

/** Каталог пользователей: `u1` — текущий владелец, `u2`/`u3` — кандидаты. */
const DIRECTORY = {
  users: [
    { id: 'u1', username: 'owner', display_name: 'Owner' },
    { id: 'u2', username: 'ivan', display_name: 'Ivan' },
    { id: 'u3', username: 'petr', display_name: null },
  ],
  total: 3,
  offset: 0,
  limit: 100,
  next_offset: null,
}

const GROUPS = {
  groups: [],
  total: 0,
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

/** Диалог подтверждения передачи (по заголовку). */
const transferDialog = (): HTMLElement | undefined =>
  [...document.body.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')].find((d) =>
    d.textContent?.includes(enDict['project.access.transfer.confirmTitle']),
  )

/** Кнопка диалога по подписи. */
const dialogButton = (dialog: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === label) as
    | HTMLButtonElement
    | undefined

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProject.mockResolvedValue(PROJECT)
  mocks.updateProject.mockResolvedValue(PROJECT)
  mocks.getProjectMcp.mockResolvedValue({ enabled: [], defaultOn: [], knownServers: [] })
  mocks.getMcpRegistry.mockResolvedValue({ entries: [] })
  mocks.getProjectSkills.mockResolvedValue({ project_id: 'p1', skills: [], enabled: [], defaultOn: [] })
  mocks.getExecutionProfiles.mockResolvedValue({ provider: 'remote', profiles: [], defaultProfile: '' })
  mocks.getDirectory.mockResolvedValue(DIRECTORY)
  mocks.getGroupsDirectory.mockResolvedValue(GROUPS)
  mocks.getProjectLogPage.mockResolvedValue({ entries: [], total: 0, offset: 0, limit: 50, next_offset: null })
  mocks.getInstanceCapabilities.mockResolvedValue({
    messageModel: 2,
    eventSeq: true,
    replay: true,
    version: '0.13.9',
    features: { users: true },
  })
  mocks.transferProject.mockResolvedValue({
    ...PROJECT,
    owner_id: 'u2',
    members: { u2: 'owner', u1: 'editor' },
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

describe('ProjectTab — блок «Владение» (ADR-140 Ф3)', () => {
  it('владельцу видны блок и кнопка передачи; текущий владелец показан по имени', async () => {
    await renderTab()

    expect(byTestId('project-transfer')).not.toBeNull()
    expect(byTestId('project-transfer-open')).not.toBeNull()
    expect(byTestId('project-transfer-owner')?.textContent).toBe('Owner')
  })

  it('ADMIN (не владелец) тоже видит кнопку передачи', async () => {
    useAuthStore.setState({ user: { id: 'u9', username: 'admin', roles: ['ADMIN'] } as never })
    await renderTab()

    expect(byTestId('project-transfer-open')).not.toBeNull()
  })

  it('участнику с ролью editor кнопки нет', async () => {
    useAuthStore.setState({ user: { id: 'u2', username: 'editor', roles: [] } as never })
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u2: 'editor' } })
    await renderTab()

    expect(byTestId('project-transfer')).not.toBeNull()
    expect(byTestId('project-transfer-open')).toBeNull()
  })

  it('участнику с ролью viewer кнопки нет', async () => {
    useAuthStore.setState({ user: { id: 'u3', username: 'viewer', roles: [] } as never })
    mocks.getProject.mockResolvedValue({ ...PROJECT, members: { u1: 'owner', u3: 'viewer' } })
    await renderTab()

    expect(byTestId('project-transfer-open')).toBeNull()
  })

  it('постороннему (не участнику) кнопки нет', async () => {
    useAuthStore.setState({ user: { id: 'u9', username: 'stranger', roles: [] } as never })
    await renderTab()

    expect(byTestId('project-transfer-open')).toBeNull()
  })

  it('текущий владелец не предлагается в списке получателей', async () => {
    await renderTab()

    await click(byTestId('project-transfer-open'))

    expect(byTestId('project-transfer-user-u1')).toBeNull()
    expect(byTestId('project-transfer-user-u2')).not.toBeNull()
    expect(byTestId('project-transfer-user-u3')).not.toBeNull()
  })

  it('выбор получателя и подтверждение → один запрос передачи', async () => {
    await renderTab()

    await click(byTestId('project-transfer-open'))
    await click(byTestId('project-transfer-user-u2'))

    const dialog = transferDialog()
    expect(dialog, 'нет диалога подтверждения').toBeTruthy()
    expect(dialog?.textContent).toContain(
      enDict['project.access.transfer.confirmText'].replace('{name}', 'Ivan'),
    )

    await click(byTestId('project-transfer-confirm'))
    await act(async () => {})

    expect(mocks.transferProject).toHaveBeenCalledTimes(1)
    expect(mocks.transferProject).toHaveBeenCalledWith('p1', 'u2')
  })

  it('отмена подтверждения — запроса передачи нет', async () => {
    await renderTab()

    await click(byTestId('project-transfer-open'))
    await click(byTestId('project-transfer-user-u2'))

    const dialog = transferDialog()
    expect(dialog).toBeTruthy()
    await click(dialogButton(dialog!, enDict['common.cancel']))
    await act(async () => {})

    expect(mocks.transferProject).not.toHaveBeenCalled()
  })

  it('успех обновляет проект (новый владелец) и показывает уведомление', async () => {
    await renderTab()

    await click(byTestId('project-transfer-open'))
    await click(byTestId('project-transfer-user-u2'))
    await click(byTestId('project-transfer-confirm'))
    await act(async () => {})

    const stored = useProjectsStore.getState().projects.find((p) => p.id === 'p1')
    expect(stored?.owner_id).toBe('u2')
    expect(byTestId('project-transfer-owner')?.textContent).toMatch(/u2|Ivan/)
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: enDict['project.access.transfer.success'],
        type: 'success',
      }),
    )
  })

  it('403 — понятное сообщение, владение не меняется', async () => {
    mocks.transferProject.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    await renderTab()

    await click(byTestId('project-transfer-open'))
    await click(byTestId('project-transfer-user-u2'))
    await click(byTestId('project-transfer-confirm'))
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: enDict['project.access.transfer.forbidden'],
        type: 'error',
      }),
    )
    const stored = useProjectsStore.getState().projects.find((p) => p.id === 'p1')
    expect(stored?.owner_id).toBe('u1')
  })

  it('400 — сервер отклонил получателя: понятное сообщение', async () => {
    mocks.transferProject.mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }))
    await renderTab()

    await click(byTestId('project-transfer-open'))
    await click(byTestId('project-transfer-user-u2'))
    await click(byTestId('project-transfer-confirm'))
    await act(async () => {})

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: enDict['project.access.transfer.invalid'],
        type: 'error',
      }),
    )
  })
})
