import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// Base UI (floating-ui) создаёт ResizeObserver — в jsdom его нет.
vi.hoisted(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    configurable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', {
      value: ResizeObserverStub,
      configurable: true,
    })
  }
})

const mocks = vi.hoisted(() => ({
  getProjectPlan: vi.fn(),
  getSessionTodos: vi.fn(),
  getProjectLogPage: vi.fn(),
  getProjectInvariants: vi.fn(),
  moveProjectPlanItem: vi.fn(),
  deleteProjectPlanItem: vi.fn(),
  createProjectPlanItem: vi.fn(),
  updateProjectPlanItem: vi.fn(),
  updateProjectPlanColumn: vi.fn(),
  createProjectPlanColumn: vi.fn(),
  createProjectLogEntry: vi.fn(),
  updateProjectLogEntry: vi.fn(),
  deleteProjectLogEntry: vi.fn(),
  putProjectInvariants: vi.fn(),
  createSessionTodo: vi.fn(),
  updateSessionTodo: vi.fn(),
  deleteSessionTodo: vi.fn(),
  clearSessionTodos: vi.fn(),
  reorderSessionTodos: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { WorkModal } from './WorkModal'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: React.ReactNode): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<I18nProvider>{node}</I18nProvider>)
  })
  await act(async () => {})
  return container
}

const PLAN = {
  version: 2,
  updatedAt: '2026-11-01T00:00:00.000Z',
  columns: [{ id: 'c1', name: 'Backlog', order: 0 }],
  items: [
    {
      id: 'i1',
      title: 'Пункт',
      columnId: 'c1',
      priority: 'high' as const,
      order: 0,
      dependsOn: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
}

beforeEach(() => {
  mocks.getProjectPlan.mockResolvedValue({ plan: PLAN })
  mocks.getSessionTodos.mockResolvedValue({ todos: [] })
  mocks.getProjectLogPage.mockResolvedValue({
    entries: [{ id: 'e1', text: 'запись', created_at: '2026-11-01T00:00:00.000Z', author: 'leader' }],
    total: 1,
    offset: 0,
    limit: 50,
    next_offset: null,
  })
  mocks.getProjectInvariants.mockResolvedValue({ invariants: 'правило', updated_at: '2026-11-01T00:00:00.000Z' })
  mocks.createSessionTodo.mockResolvedValue({ todos: [] })
  mocks.updateSessionTodo.mockResolvedValue({ todos: [] })
  mocks.deleteSessionTodo.mockResolvedValue({ todos: [] })
  mocks.clearSessionTodos.mockResolvedValue({ todos: [] })
  mocks.reorderSessionTodos.mockResolvedValue({ todos: [] })
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

describe('WorkModal: вкладки рабочего окна', () => {
  it('открывает вкладку по initialTab и грузит данные', async () => {
    await render(
      <WorkModal open onOpenChange={() => {}} projectId="p1" sessionId="s1" initialTab="journal" testId="wm" />,
    )
    expect(mocks.getProjectPlan).toHaveBeenCalledWith('p1')
    expect(mocks.getSessionTodos).toHaveBeenCalledWith('s1')
    expect(mocks.getProjectLogPage).toHaveBeenCalledWith('p1', { limit: 50, offset: 0 })
    expect(mocks.getProjectInvariants).toHaveBeenCalledWith('p1')
    expect(document.querySelector('[data-testid="work-modal-body-journal"]')).not.toBeNull()
  })

  it('вкладка «Доска» рисует колонки плана', async () => {
    await render(<WorkModal open onOpenChange={() => {}} projectId="p1" initialTab="board" testId="wm" />)
    const body = document.querySelector('[data-testid="work-modal-body-board"]')!
    expect(body.querySelector('[data-testid="work-modal-board-column-c1"]')).not.toBeNull()
  })

  it('переключение вкладки «Статистика» показывает счётчики', async () => {
    await render(<WorkModal open onOpenChange={() => {}} projectId="p1" initialTab="board" testId="wm" />)
    const statsTab = [...document.querySelectorAll('button[role="tab"]')].find(
      (b) => b.textContent === 'Statistics',
    ) as HTMLButtonElement
    await act(async () => {
      statsTab.click()
    })
    expect(document.querySelector('[data-testid="work-modal-body-stats"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="work-modal-stats"]')).not.toBeNull()
  })

  it('вкладка «Инварианты» показывает редактор с текущим текстом', async () => {
    await render(
      <WorkModal open onOpenChange={() => {}} projectId="p1" initialTab="invariants" testId="wm" />,
    )
    const textarea = document.querySelector('[data-testid="work-modal-invariants-markdown-textarea"]') as HTMLTextAreaElement
    expect(textarea?.value).toBe('правило')
  })

  it('canEdit=false: доска только для чтения', async () => {
    await render(
      <WorkModal open onOpenChange={() => {}} projectId="p1" canEdit={false} initialTab="board" testId="wm" />,
    )
    const board = document.querySelector('[data-testid="work-modal-board"]')!
    expect(board.querySelector('[data-testid="work-modal-board-item-i1-move"]')).toBeNull()
  })

  it('canEdit=true: перемещение карточки зовёт moveProjectPlanItem с версией плана', async () => {
    mocks.moveProjectPlanItem.mockResolvedValue({ plan: PLAN })
    await render(
      <WorkModal open onOpenChange={() => {}} projectId="p1" canEdit initialTab="board" testId="wm" />,
    )
    const moveButton = document.querySelector('[data-testid="work-modal-board-item-i1-move"]') as HTMLButtonElement
    await act(async () => {
      moveButton.click()
    })
    const target = document.querySelector('[data-testid="work-modal-board-item-i1-move-c1"]') as HTMLButtonElement
    await act(async () => {
      target.click()
    })
    expect(mocks.moveProjectPlanItem).toHaveBeenCalledWith('p1', 'i1', { columnId: 'c1', version: 2 })
  })

  it('ошибка загрузки показывает баннер', async () => {
    mocks.getProjectPlan.mockRejectedValue(new Error('boom'))
    await render(<WorkModal open onOpenChange={() => {}} projectId="p1" initialTab="board" testId="wm" />)
    expect(document.querySelector('[data-testid="work-modal-error"]')!.textContent).toContain('Failed to load')
  })
})

describe('WorkModal: вкладка ToDo (PROP-054)', () => {
  const TODOS = [
    { id: 't1', content: 'Первая задача', status: 'pending' as const, priority: 'medium' as const },
  ]

  it('вкладка ToDo показывает пункты сессии', async () => {
    mocks.getSessionTodos.mockResolvedValue({ todos: TODOS })
    await render(
      <WorkModal open onOpenChange={() => {}} projectId="p1" sessionId="s1" initialTab="todos" testId="wm" />,
    )
    expect(document.querySelector('[data-testid="work-modal-body-todos"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="work-modal-todos-item-t1"]')).not.toBeNull()
  })

  it('canEditTodos=false: кнопок правки ToDo нет', async () => {
    mocks.getSessionTodos.mockResolvedValue({ todos: TODOS })
    await render(
      <WorkModal
        open
        onOpenChange={() => {}}
        projectId="p1"
        sessionId="s1"
        initialTab="todos"
        canEdit
        canEditTodos={false}
        testId="wm"
      />,
    )
    expect(document.querySelector('[data-testid="work-modal-todos-add"]')).toBeNull()
    expect(document.querySelector('[data-testid="work-modal-todos-item-t1-delete"]')).toBeNull()
  })

  it('canEditTodos=true: создание пункта вызывает createSessionTodo', async () => {
    mocks.getSessionTodos.mockResolvedValue({ todos: TODOS })
    await render(
      <WorkModal
        open
        onOpenChange={() => {}}
        projectId="p1"
        sessionId="s1"
        initialTab="todos"
        canEditTodos
        testId="wm"
      />,
    )
    const add = document.querySelector('[data-testid="work-modal-todos-add"]') as HTMLButtonElement
    expect(add).toBeTruthy()
    await act(async () => {
      add.click()
    })
    const textarea = document.querySelector('[data-testid="work-modal-todos-add-textarea"]') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'Новая задача')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = document.querySelector('[data-testid="work-modal-todos-add-submit"]') as HTMLButtonElement
    await act(async () => {
      submit.click()
    })
    expect(mocks.createSessionTodo).toHaveBeenCalledWith('s1', { content: 'Новая задача', status: 'pending' })
  })
})
