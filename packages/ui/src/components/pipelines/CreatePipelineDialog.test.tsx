import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) пишет в localStorage — в Node/vitest его нет.
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
  createProjectPipeline: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CreatePipelineDialog } from './CreatePipelineDialog'
import type { ProjectData } from '@/lib/api/synthApi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
  id: 'p1',
  name: 'Proj1',
  owner_id: 'u1',
  members: {},
  description: '',
  current_task: '',
  invariants: '',
  icon: null,
  color: null,
  workspace: '/ws/p1',
  repos: [],
  status_messages: [],
  plan: null,
  created_at: '',
  updated_at: '',
} as unknown as ProjectData

/** Поля диалога: имя, описание (портал — ищем в document.body). */
function inputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input'))
}

/** Кнопка создания — по подписи из i18n. */
function createButton(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (el) => el.textContent?.trim() === enDict['pipelines.create'],
  )
  expect(button, 'кнопка создания найдена').toBeTruthy()
  return button as HTMLButtonElement
}

async function setInputValue(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderDialog(project: ProjectData = PROJECT): Promise<void> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <CreatePipelineDialog project={project} onClose={() => {}} onCreated={() => {}} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
}

beforeEach(() => {
  mocks.createProjectPipeline.mockResolvedValue({
    id: 'pl_1',
    name: 'Release',
    scope: 'project',
    projectId: 'p1',
    draftVersion: 1,
    hasDraft: true,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
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
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CreatePipelineDialog — тело создания пайплайна', () => {
  it('спецификация уходит без серверных полей (id/version/status/projectId)', async () => {
    await renderDialog()

    await setInputValue(inputs()[0], 'Release')
    await act(async () => {
      createButton().click()
    })
    await act(async () => {})

    expect(mocks.createProjectPipeline).toHaveBeenCalledTimes(1)
    const [projectId, body] = mocks.createProjectPipeline.mock.calls[0] as [
      string,
      { name: string; description?: string; spec: Record<string, unknown> },
    ]
    expect(projectId).toBe('p1')
    expect(body.name).toBe('Release')
    // Серверные поля проставляет сервер — клиент их не присылает.
    expect(body.spec).not.toHaveProperty('id')
    expect(body.spec).not.toHaveProperty('version')
    expect(body.spec).not.toHaveProperty('status')
    expect(body.spec).not.toHaveProperty('projectId')
    // Содержимое спецификации — каркас: один агентский узел и выход `none`.
    expect(body.spec.name).toBe('Release')
    expect(body.spec.mode).toBe('plan')
    expect(body.spec.nodes).toHaveLength(1)
    expect(body.spec.exits).toHaveLength(1)
  })

  it('описание пайплайна уходит в тело', async () => {
    await renderDialog()

    await setInputValue(inputs()[0], 'Release')
    await setInputValue(inputs()[1], 'Релизы')
    await act(async () => {
      createButton().click()
    })
    await act(async () => {})

    const [, body] = mocks.createProjectPipeline.mock.calls[0] as [
      string,
      { name: string; description?: string; spec: Record<string, unknown> },
    ]
    expect(body.description).toBe('Релизы')
    expect(body.spec.description).toBe('Релизы')
  })

  it('без имени — запрос не уходит', async () => {
    await renderDialog()

    await act(async () => {
      createButton().click()
    })
    await act(async () => {})

    expect(mocks.createProjectPipeline).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(enDict['pipelines.nameRequired'])
  })
})
