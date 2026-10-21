import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'

// persist (zustand) в useUIStore/useAuthStore пишет в localStorage — в Node/vitest его нет.
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
  getPipelineRun: vi.fn(),
  resumePipelineRun: vi.fn(),
  cancelPipelineRun: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { PipelineRunTab } from './PipelineRunTab'
import { useAuthStore } from '@/stores/authStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useUIStore, type CenterTab } from '@/stores/useUIStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const TAB: CenterTab = {
  id: 'pipeline-run-run1',
  type: 'pipeline-run',
  title: 'Run',
  data: { projectId: 'p1', pipelineId: 'pl1', runId: 'run1' },
}

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
}

const VIEWER_PROJECT = {
  ...PROJECT,
  owner_id: 'u-other',
  members: { u1: 'viewer' },
}

const EVENTS = [
  { runId: 'run1', ts: '2026-10-20T12:00:00.000Z', type: 'run.started' as const },
  { runId: 'run1', ts: '2026-10-20T12:00:01.000Z', type: 'gate.awaiting' as const, payload: { node: 'gate' } },
]

/** Деталь прогона с заданным статусом. */
function detail(status: string) {
  return {
    run: {
      id: 'run1',
      pipelineId: 'pl1',
      version: 2,
      projectId: 'p1',
      status,
      currentNode: 'gate',
      trigger: { kind: 'manual' },
      startedAt: '2026-10-20T12:00:00.000Z',
    },
    events: EVENTS,
  }
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
        <PipelineRunTab tab={TAB} />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const action = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector(`[data-action="${name}"]`)

beforeEach(() => {
  mocks.getPipelineRun.mockResolvedValue(detail('awaiting_human'))
  mocks.resumePipelineRun.mockResolvedValue(detail('running'))
  mocks.cancelPipelineRun.mockResolvedValue(detail('cancelled'))

  useAuthStore.setState({
    user: { id: 'u1', username: 'u1', email: null, roles: ['USER'] },
  })
  useUIStore.setState({ centerTabs: [TAB], activeCenterTabId: TAB.id })
  useProjectsStore.setState({ projects: [PROJECT] as never, loading: false, error: null })
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
    runsByPipeline: {},
    runDetail: {},
    runSignal: {},
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

describe('PipelineRunTab — HITL-гейт (ADR-101, Э7)', () => {
  it('при статусе awaiting_human кнопки «Одобрить»/«Отклонить» есть', async () => {
    const container = await renderTab()

    expect(action(container, 'approve')).toBeTruthy()
    expect(action(container, 'reject')).toBeTruthy()
    expect(container.textContent ?? '').toContain('The run is waiting for a human decision')
  })

  it('при других статусах HITL-кнопок нет', async () => {
    mocks.getPipelineRun.mockResolvedValue(detail('running'))
    const container = await renderTab()

    expect(action(container, 'approve')).toBeNull()
    expect(action(container, 'reject')).toBeNull()
  })

  it('одобрение вызывает resume с approved=true', async () => {
    const container = await renderTab()

    const approve = action(container, 'approve') as HTMLButtonElement
    await act(async () => {
      approve.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.resumePipelineRun).toHaveBeenCalledWith('run1', { approved: true })
  })

  it('отклонение вызывает resume с approved=false', async () => {
    const container = await renderTab()

    const reject = action(container, 'reject') as HTMLButtonElement
    await act(async () => {
      reject.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.resumePipelineRun).toHaveBeenCalledWith('run1', { approved: false })
  })

  it('комментарий человека уходит в resume', async () => {
    const container = await renderTab()

    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ок')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {})

    const approve = action(container, 'approve') as HTMLButtonElement
    await act(async () => {
      approve.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.resumePipelineRun).toHaveBeenCalledWith('run1', { approved: true, comment: 'ок' })
  })

  it('VIEWER не видит HITL-кнопок', async () => {
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })
    const container = await renderTab()

    expect(action(container, 'approve')).toBeNull()
    expect(action(container, 'reject')).toBeNull()
  })
})

describe('PipelineRunTab — отмена прогона', () => {
  it('кнопка отмены есть у активного прогона', async () => {
    mocks.getPipelineRun.mockResolvedValue(detail('running'))
    const container = await renderTab()

    expect(action(container, 'cancel-run')).toBeTruthy()
  })

  it('у завершённого прогона кнопки отмены нет', async () => {
    mocks.getPipelineRun.mockResolvedValue(detail('done'))
    const container = await renderTab()

    expect(action(container, 'cancel-run')).toBeNull()
  })

  it('клик отменяет прогон', async () => {
    mocks.getPipelineRun.mockResolvedValue(detail('running'))
    const container = await renderTab()

    const cancel = action(container, 'cancel-run') as HTMLButtonElement
    await act(async () => {
      cancel.click()
    })
    await act(async () => {})
    await act(async () => {})

    expect(mocks.cancelPipelineRun).toHaveBeenCalledWith('run1')
  })

  it('VIEWER не видит кнопку отмены', async () => {
    mocks.getPipelineRun.mockResolvedValue(detail('running'))
    useProjectsStore.setState({ projects: [VIEWER_PROJECT] as never, loading: false, error: null })
    const container = await renderTab()

    expect(action(container, 'cancel-run')).toBeNull()
  })
})

describe('PipelineRunTab — журнал прогона', () => {
  it('события журнала выводятся списком', async () => {
    const container = await renderTab()
    const text = container.textContent ?? ''

    expect(text).toContain('Journal')
    expect(text).toContain('run.started')
    expect(text).toContain('gate.awaiting')
  })

  it('пустой журнал — подсказка', async () => {
    mocks.getPipelineRun.mockResolvedValue({ ...detail('done'), events: [] })
    const container = await renderTab()

    expect(container.textContent ?? '').toContain('No events yet')
  })
})
