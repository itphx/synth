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
  getSchedules: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runSchedule: vi.fn(),
  getSessions: vi.fn(),
  getAgents: vi.fn(),
  getProjects: vi.fn(),
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
import { SchedulerTab } from './SchedulerTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import type { Schedule } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const SESSION = { id: 's1', name: 'Session One', engine: 'synth', settings: {} }
const AGENT = { id: 'assistant', display_name: 'Assistant', enabled: true }
const PROJECT = { id: 'p1', name: 'Project One' }

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_1',
    name: 'Nightly build',
    enabled: true,
    cron: '0 3 * * *',
    target: { mode: 'bound', sessionId: 's1' },
    prompt: 'run build',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    nextRunAt: '2026-10-09T03:00:00.000Z',
    lastRunAt: '2026-10-08T03:00:00.000Z',
    lastStatus: 'ok',
    ...overrides,
  }
}

/** Установить значение контролируемого input/textarea так, как это делает React. */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Установить значение нативного select. */
function setSelectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
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
        <SchedulerTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.getSchedules.mockResolvedValue({ schedules: [schedule()] })
  mocks.createSchedule.mockResolvedValue(schedule())
  mocks.updateSchedule.mockResolvedValue(schedule())
  mocks.deleteSchedule.mockResolvedValue(undefined)
  mocks.runSchedule.mockResolvedValue(schedule())
  mocks.getSessions.mockResolvedValue([SESSION])
  mocks.getAgents.mockResolvedValue({ agents: [AGENT], default_agent: 'assistant' })
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.confirm.mockResolvedValue(true)

  useSessionsStore.setState({ sessions: [SESSION] as never })
  useAgentsStore.setState({ agents: [AGENT] as never })
  useProjectsStore.setState({ projects: [PROJECT] as never })
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

describe('SchedulerTab — список расписаний (AD-051/AD-089)', () => {
  it('рендерит список: имя, триггер, цель, статус и времена', async () => {
    const container = await renderTab()

    expect(container.querySelector('[data-testid="scheduler-list"]')).not.toBeNull()
    const row = container.querySelector('[data-testid="scheduler-item-sch_1"]')!
    expect(row.textContent).toContain('Nightly build')
    expect(row.textContent).toContain('Cron 0 3 * * *')
    expect(row.textContent).toContain('Session: Session One')
    expect(row.textContent).toContain('ok')
    expect(mocks.getSchedules).toHaveBeenCalledTimes(1)
  })

  it('пустое состояние, когда расписаний нет', async () => {
    mocks.getSchedules.mockResolvedValue({ schedules: [] })
    const container = await renderTab()
    expect(container.querySelector('[data-testid="scheduler-empty"]')).not.toBeNull()
    expect(container.textContent).toContain('No schedules configured')
  })

  it('ошибка загрузки показывается в блоке alert', async () => {
    mocks.getSchedules.mockRejectedValue(new Error('boom'))
    const container = await renderTab()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom')
  })

  it('показывает ошибку последнего запуска', async () => {
    mocks.getSchedules.mockResolvedValue({
      schedules: [schedule({ lastStatus: 'error', lastError: 'delivery failed' })],
    })
    const container = await renderTab()
    expect(container.querySelector('[data-testid="scheduler-error-sch_1"]')?.textContent).toContain(
      'delivery failed',
    )
  })
})

describe('SchedulerTab — создание и редактирование', () => {
  it('создание шлёт name/target/cron через createSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-add"]'))

    const name = container.querySelector('[data-testid="scheduler-name"]') as HTMLInputElement
    const session = container.querySelector('[data-testid="scheduler-session"]') as HTMLSelectElement
    await act(async () => {
      setInputValue(name, '  Morning digest ')
      setSelectValue(session, 's1')
    })

    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await act(async () => {})

    expect(mocks.createSchedule).toHaveBeenCalledTimes(1)
    expect(mocks.createSchedule).toHaveBeenCalledWith({
      name: 'Morning digest',
      enabled: true,
      cron: '*/5 * * * *',
      every: undefined,
      target: { mode: 'bound', sessionId: 's1' },
      prompt: undefined,
    })
  })

  it('создание без имени не вызывает API и показывает ошибку', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-add"]'))
    await click(container.querySelector('[data-testid="scheduler-save"]'))

    expect(mocks.createSchedule).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Name is required')
  })

  it('форма редактирования подставляет текущие значения и шлёт updateSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-edit-sch_1"]'))

    expect((container.querySelector('[data-testid="scheduler-name"]') as HTMLInputElement).value).toBe(
      'Nightly build',
    )

    const name = container.querySelector('[data-testid="scheduler-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, 'Renamed')
    })
    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await act(async () => {})

    expect(mocks.updateSchedule).toHaveBeenCalledWith('sch_1', {
      name: 'Renamed',
      enabled: true,
      cron: '0 3 * * *',
      every: undefined,
      target: { mode: 'bound', sessionId: 's1' },
      prompt: 'run build',
    })
  })

  it('ошибка сохранения показывает saveError и уведомление', async () => {
    mocks.createSchedule.mockRejectedValueOnce(new Error('invalid cron'))
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-add"]'))
    const name = container.querySelector('[data-testid="scheduler-name"]') as HTMLInputElement
    const session = container.querySelector('[data-testid="scheduler-session"]') as HTMLSelectElement
    await act(async () => {
      setInputValue(name, 'X')
      setSelectValue(session, 's1')
    })
    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await act(async () => {})

    expect(container.textContent).toContain('invalid cron')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    )
  })
})

describe('SchedulerTab — действия над расписанием', () => {
  it('«Запустить сейчас» вызывает runSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-run-sch_1"]'))
    await act(async () => {})
    expect(mocks.runSchedule).toHaveBeenCalledWith('sch_1')
  })

  it('toggle включает/выключает через updateSchedule', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="scheduler-item-sch_1"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await click(toggle)
    await act(async () => {})

    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      'sch_1',
      expect.objectContaining({ enabled: false, target: { mode: 'bound', sessionId: 's1' } }),
    )
  })

  it('удаление подтверждается через confirm и вызывает deleteSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-delete-sch_1"]'))
    await act(async () => {})

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteSchedule).toHaveBeenCalledWith('sch_1')
  })

  it('отмена подтверждения не удаляет расписание', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-delete-sch_1"]'))
    await act(async () => {})
    expect(mocks.deleteSchedule).not.toHaveBeenCalled()
  })
})
