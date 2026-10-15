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
  updateProject: vi.fn(),
  updateSession: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { EntityEditDialog } from './EntityEditDialog'
import { useEntityEditStore, type EntityEditTarget } from '@/stores/entityEditStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useUIStore } from '@/stores/useUIStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const PROJECT = {
  id: 'p1',
  name: 'P',
  owner_id: 'u1',
  members: { u1: 'owner' },
  description: 'old description',
  current_task: '',
  invariants: '',
  icon: null as string | null,
  color: null as string | null,
  workspace: null,
  repos: null,
  status_messages: [],
  log: [],
  plan: null,
  created_at: '',
  updated_at: '',
}

async function renderDialog(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <EntityEditDialog />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

function open(target: EntityEditTarget) {
  return act(async () => {
    useEntityEditStore.getState().openEntityEdit(target)
  })
}

async function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(el: Element | null | undefined) {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  const project = { ...PROJECT }
  mocks.updateProject.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
    ...project,
    ...data,
  }))
  mocks.updateSession.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
    id: 's1',
    name: 'S',
    project_id: null,
    settings: { model: 'm' },
    ...data,
  }))
  useEntityEditStore.setState({ target: null })
  useProjectsStore.setState({ projects: [{ ...PROJECT }] as never })
  useSessionsStore.setState({
    sessions: [{ id: 's1', name: 'S', project_id: null, settings: { model: 'm' } }],
  } as never)
  useUIStore.setState({
    activeCenterTabId: null,
    centerTabs: [],
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

describe('EntityEditDialog', () => {
  it('открывается с данными проекта: имя, описание, пикер', async () => {
    await renderDialog()
    await open({ kind: 'project', id: 'p1', name: 'P', description: 'old description', icon: 'rocket', color: 'a11' })

    const dialog = document.body.querySelector('[data-testid="entity-edit-dialog"]')
    expect(dialog, 'диалог открыт').not.toBeNull()
    expect(dialog!.textContent).toContain('Project settings')
    expect((document.body.querySelector('[data-testid="entity-edit-name"]') as HTMLInputElement).value).toBe('P')
    expect((document.body.querySelector('[data-testid="entity-edit-description"]') as HTMLTextAreaElement).value).toBe('old description')
    expect(document.body.querySelector('[data-testid="entity-picker"]')).not.toBeNull()
  })

  it('для сессии описание не показывается', async () => {
    await renderDialog()
    await open({ kind: 'session', id: 's1', name: 'S', icon: null, color: null })

    expect(document.body.textContent).toContain('Session settings')
    expect(document.body.querySelector('[data-testid="entity-edit-description"]')).toBeNull()
  })

  it('Save отправляет черновик (имя/описание/иконка/цвет) в updateProject и закрывает диалог', async () => {
    await renderDialog()
    await open({ kind: 'project', id: 'p1', name: 'P', description: 'old description', icon: null, color: null })

    await setInputValue(document.body.querySelector('[data-testid="entity-edit-name"]')!, 'New name')
    await click(document.body.querySelector('[data-testid="entity-icon-rocket"]'))
    await click(document.body.querySelector('[data-testid="entity-color-a1"]'))
    await click(document.body.querySelector('[data-testid="entity-edit-save"]'))
    await act(async () => {})

    expect(mocks.updateProject).toHaveBeenCalledWith('p1', {
      name: 'New name',
      description: 'old description',
      icon: 'rocket',
      color: 'a1',
    })
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ text: enDict['panel.saved'], type: 'success' }))
    expect(useEntityEditStore.getState().target).toBeNull()
  })

  it('Save сессии отправляет только имя/иконку/цвет в updateSession', async () => {
    await renderDialog()
    await open({ kind: 'session', id: 's1', name: 'S', icon: null, color: null })

    await setInputValue(document.body.querySelector('[data-testid="entity-edit-name"]')!, 'Renamed')
    await click(document.body.querySelector('[data-testid="entity-edit-save"]'))
    await act(async () => {})

    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { name: 'Renamed', icon: null, color: null })
    expect(mocks.updateProject).not.toHaveBeenCalled()
  })

  it('Cancel не вызывает API и закрывает диалог', async () => {
    await renderDialog()
    await open({ kind: 'project', id: 'p1', name: 'P', description: 'old description', icon: null, color: null })

    await setInputValue(document.body.querySelector('[data-testid="entity-edit-name"]')!, 'Discarded')
    await click(document.body.querySelector('[data-testid="entity-edit-cancel"]'))

    expect(mocks.updateProject).not.toHaveBeenCalled()
    expect(useEntityEditStore.getState().target).toBeNull()
  })

  // Регресс: Cancel в EntityEditDialog должен быть активен всегда (в отличие от
  // общего правила ADR-072 «Save/Cancel активны только при dirty») и просто
  // закрывать окно без сохранения.
  it('Cancel активен при отсутствии изменений и закрывает окно без запроса API', async () => {
    await renderDialog()
    await open({ kind: 'project', id: 'p1', name: 'P', description: 'old description', icon: null, color: null })

    const cancel = document.body.querySelector('[data-testid="entity-edit-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    expect(cancel.disabled, 'Cancel активен без изменений').toBe(false)

    await click(cancel)

    expect(mocks.updateProject).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(useEntityEditStore.getState().target).toBeNull()
  })

  it('при закрытии черновик сбрасывается — повторное открытие показывает исходное значение', async () => {
    await renderDialog()
    const target = { kind: 'project' as const, id: 'p1', name: 'P', description: 'old description', icon: null, color: null }
    await open(target)
    await setInputValue(document.body.querySelector('[data-testid="entity-edit-name"]')!, 'Unsaved')
    await click(document.body.querySelector('[data-testid="entity-edit-cancel"]'))
    expect(useEntityEditStore.getState().target).toBeNull()

    await open(target)
    expect((document.body.querySelector('[data-testid="entity-edit-name"]') as HTMLInputElement).value).toBe('P')
  })
})
