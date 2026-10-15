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
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CreateProjectPopover } from './CreateProjectPopover'
import { useAuthStore } from '@/stores/authStore'
import { useHybridStore } from '@/stores/hybridStore'
import { useProjectsStore } from '@/stores/projectsStore'
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

interface RenderResult {
  container: HTMLElement
  onCreated: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
}

async function renderPopover(): Promise<RenderResult> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const onCreated = vi.fn()
  const onError = vi.fn()
  await act(async () => {
    root.render(
      <I18nProvider>
        <CreateProjectPopover
          trigger={<button data-testid="create-project-trigger">New</button>}
          onCreated={onCreated}
          onError={onError}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {
    ;(container.querySelector('[data-testid="create-project-trigger"]') as HTMLElement).click()
  })
  await act(async () => {})
  return { container, onCreated, onError }
}

const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector(`[data-testid="${id}"]`)

const setInputValue = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click()
  })
  const listId = trigger.getAttribute('aria-controls')
  const scope = listId ? document.getElementById(listId) ?? document.body : document.body
  const option = [...scope.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent?.trim().startsWith(label),
  ) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
}

beforeEach(() => {
  mocks.createProject.mockResolvedValue(PROJECT)
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
  document.body.innerHTML = ''
})

describe('CreateProjectPopover — workspace (ADR-075)', () => {
  it('standalone/local: путь передаётся при создании', async () => {
    const { onCreated } = await renderPopover()
    await setInputValue(byTestId('create-project-workspace') as HTMLInputElement, '/home/user/ws')
    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'My project')

    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'My project',
      origin: 'local',
      workspace: '/home/user/ws',
    })
    expect(onCreated).toHaveBeenCalled()
  })

  it('managed: поле скрыто, workspace не передаётся', async () => {
    useAuthStore.setState({ deployment: 'managed' } as never)
    await renderPopover()

    expect(byTestId('create-project-workspace')).toBeNull()
    expect(byTestId('create-project-workspace-readonly')).not.toBeNull()

    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'Managed project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({ name: 'Managed project', origin: 'local' })
  })

  it('remote-проект в гибриде: поле скрыто, workspace не передаётся', async () => {
    useHybridStore.setState({ enabled: true, connected: true, backendUrl: 'http://srv', user: null, loading: false })
    await renderPopover()

    // Локальный режим: поле есть.
    expect(byTestId('create-project-workspace')).not.toBeNull()

    const trigger = document.body.querySelector('[data-slot="select-trigger"]') as HTMLElement
    await selectOption(trigger, 'On server')

    // Remote: поле скрыто, показывается пояснение об автосоздании.
    expect(byTestId('create-project-workspace')).toBeNull()
    expect(byTestId('create-project-workspace-readonly')).not.toBeNull()

    const nameInput = document.body.querySelector('input[placeholder="Project name"]') as HTMLInputElement
    await setInputValue(nameInput, 'Remote project')
    await click(byTestId('create-project-submit'))
    await act(async () => {})

    expect(mocks.createProject).toHaveBeenCalledWith({ name: 'Remote project', origin: 'remote' })
  })
})
