import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в сторах пишет в localStorage — в Node/vitest его нет.
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
  createProject: vi.fn(),
  getDirectory: vi.fn(),
  getInstanceCapabilities: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CreateProjectPopover } from './CreateProjectPopover'
import { useAuthStore } from '@/stores/authStore'
import { useHybridStore } from '@/stores/hybridStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useInstanceCapabilitiesStore } from '@/stores/instanceCapabilitiesStore'
import type { ProjectData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT: ProjectData = {
  id: 'p1',
  origin: 'local',
  name: 'X',
  owner_id: 'u1',
  members: {},
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
  users: [{ id: 'u2', username: 'ivan', display_name: 'Иван' }],
  total: 1,
  offset: 0,
  limit: 50,
  next_offset: null,
}

async function renderPopover(): Promise<void> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <CreateProjectPopover
          trigger={<button data-testid="create-project-trigger">New</button>}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {
    ;(container.querySelector('[data-testid="create-project-trigger"]') as HTMLElement).click()
  })
  await act(async () => {})
  await act(async () => {})
}

const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${id}"]`)

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const setInputValue = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createProject.mockResolvedValue(PROJECT)
  mocks.getDirectory.mockResolvedValue(DIRECTORY)
  mocks.getInstanceCapabilities.mockResolvedValue({
    messageModel: 2,
    eventSeq: true,
    replay: true,
    version: '0.13.9',
    features: { users: true },
  })
  useInstanceCapabilitiesStore.getState().resetForTests()
  useAuthStore.setState({ deployment: 'standalone' } as never)
  useHybridStore.setState({ enabled: false, connected: false, backendUrl: null, user: null, loading: false })
  useProjectsStore.setState({ projects: [] })
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
  document.body.innerHTML = ''
})

describe('CreateProjectPopover — проекция доступа (PROP-133 §4)', () => {
  it('по умолчанию «Только автору» — состояние доступа не отправляется', async () => {
    await renderPopover()

    expect(byTestId('create-project-access-author')).toBeTruthy()
    expect((byTestId('create-project-access-author') as HTMLInputElement).checked).toBe(true)

    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'My project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({ name: 'My project', origin: 'local' })
  })

  it('«Всем пользователям»: viewer по умолчанию, editor — только явным выбором', async () => {
    await renderPopover()

    await click(byTestId('create-project-access-all'))
    await act(async () => {})

    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'Shared project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'Shared project',
      origin: 'local',
      members: {},
      everyone_role: 'viewer',
    })

    // Второй проект — с включённым редактированием.
    await click(byTestId('create-project-trigger'))
    await act(async () => {})
    await click(byTestId('create-project-access-all'))
    await act(async () => {})
    const toggle = document.body.querySelector(
      '[data-testid="create-project-access-all-editor"] button[role="switch"]',
    ) as HTMLButtonElement
    await click(toggle)
    await act(async () => {})

    const nameInput2 = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput2, 'Editable project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenLastCalledWith({
      name: 'Editable project',
      origin: 'local',
      members: {},
      everyone_role: 'editor',
    })
  })

  it('«Только выбранным»: выбранный участник уходит в `members`', async () => {
    await renderPopover()

    await click(byTestId('create-project-access-selected'))
    await act(async () => {})
    await click(byTestId('create-project-access-user-u2'))
    await act(async () => {})

    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'Team project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'Team project',
      origin: 'local',
      members: { u2: 'viewer' },
      everyone_role: null,
    })
  })

  it('без features.users выбор проекции не предлагается', async () => {
    mocks.getInstanceCapabilities.mockResolvedValue({
      messageModel: 2,
      eventSeq: true,
      replay: true,
      version: '0.13.9',
      features: { users: false },
    })

    await renderPopover()

    expect(byTestId('create-project-access')).toBeNull()
    expect(mocks.getDirectory).not.toHaveBeenCalled()
  })
})
