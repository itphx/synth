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
  getScheduleJobs: vi.fn(),
  listTimers: vi.fn(),
  createTimer: vi.fn(),
  patchTimer: vi.fn(),
  pauseTimer: vi.fn(),
  resumeTimer: vi.fn(),
  removeTimer: vi.fn(),
  getTimerFirings: vi.fn(),
  getSessions: vi.fn(),
  getProjects: vi.fn(),
  getProjectsPage: vi.fn(),
  getAgents: vi.fn(),
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationTab } from './AutomationTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useTimersStore } from '@/stores/timersStore'
import { useUIStore } from '@/stores/useUIStore'
import type { Schedule, Timer } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

vi.setConfig({ testTimeout: 15_000 })

/** Доводит отложенные промисы (мок-API) и эффекты React до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Ждёт наблюдаемого состояния (пере-проверка) вместо фиксированной задержки. */
async function waitFor(assertion: () => void, timeout = 5000): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion, { timeout, interval: 10 })
  })
}

const SESSION = { id: 's1', name: 'Session One', settings: {}, project_id: 'p1' }
const SESSION_TWO = { id: 's2', name: 'Session Two', settings: {}, project_id: 'p1' }
const PROJECT = { id: 'p1', name: 'Project One' }
const AGENT = { id: 'assistant', display_name: 'Assistant', enabled: true }

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_1',
    name: 'Nightly build',
    enabled: true,
    projectId: 'p1',
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

function timer(overrides: Partial<Timer> = {}): Timer {
  return {
    id: 'tmr_1',
    kind: 'timer',
    name: 'Coffee',
    comment: 'выпить кофе',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'local',
    repeat: { mode: 'once' },
    status: 'active',
    firesAt: '2026-10-09T03:15:00.000Z',
    createdAt: '2026-10-09T03:00:00.000Z',
    updatedAt: '2026-10-09T03:00:00.000Z',
    ...overrides,
  }
}

function timersPage(timers: Timer[]) {
  return { timers, total: timers.length, offset: 0, limit: 50, next_offset: null }
}

/** Установить значение контролируемого input/textarea так, как это делает React. */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Выбирает опцию нативного `<select>` по значению (как это делает React). */
async function setNativeSelect(el: HTMLSelectElement | null, value: string): Promise<void> {
  expect(el, 'нативный селект не найден').toBeTruthy()
  const select = el as HTMLSelectElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
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
        <TooltipProvider>
          <AutomationTab />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await flush()
  return container
}

const click = async (el: Element | null | undefined) => {
  expect(el, 'элемент для клика не найден').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

const query = (container: HTMLElement, testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSchedules.mockResolvedValue({ schedules: [schedule()] })
  mocks.createSchedule.mockResolvedValue(schedule())
  mocks.updateSchedule.mockResolvedValue(schedule())
  mocks.deleteSchedule.mockResolvedValue(undefined)
  mocks.runSchedule.mockResolvedValue(schedule())
  mocks.getScheduleJobs.mockResolvedValue({ jobs: [] })
  mocks.listTimers.mockResolvedValue(timersPage([]))
  mocks.createTimer.mockResolvedValue(timer())
  mocks.patchTimer.mockResolvedValue(timer())
  mocks.pauseTimer.mockResolvedValue(timer({ status: 'paused' }))
  mocks.resumeTimer.mockResolvedValue(timer({ status: 'active' }))
  mocks.removeTimer.mockResolvedValue(undefined)
  mocks.getTimerFirings.mockResolvedValue([])
  mocks.getSessions.mockResolvedValue([SESSION, SESSION_TWO])
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.getProjectsPage.mockResolvedValue({
    projects: [PROJECT],
    total: 1,
    offset: 0,
    limit: 100,
    next_offset: null,
  })
  mocks.getAgents.mockResolvedValue({ agents: [AGENT], default_agent: 'assistant' })
  mocks.confirm.mockResolvedValue(true)

  useSessionsStore.setState({ sessions: [SESSION, SESSION_TWO] as never })
  useProjectsStore.setState({ projects: [PROJECT] as never })
  useAgentsStore.setState({ agents: [AGENT] as never })
  useUIStore.setState({ scheduleDraft: null })
  // Реестр таймеров — синглтон модуля: сбрасываем между тестами.
  useTimersStore.setState({ byId: {}, order: [], pendingIds: [], loading: false, error: null })
  // Контекст: сессия s1 в проекте p1.
  useUIStore.setState({
    selectedProjectId: null,
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
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
  document.body.innerHTML = ''
})

describe('AutomationTab — секции и счётчики', () => {
  it('рендерит три секции: расписания, таймеры, будильники', async () => {
    const container = await renderTab()

    expect(query(container, 'automation-section-schedule')).not.toBeNull()
    expect(query(container, 'automation-section-timer')).not.toBeNull()
    expect(query(container, 'automation-section-alarm')).not.toBeNull()
  })

  it('счётчики секций — ICU-плараль по числу записей', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer(), timer({ id: 'tmr_2', kind: 'alarm' })]))

    const container = await renderTab()

    expect(query(container, 'automation-section-schedule-count')?.textContent).toBe('1 schedule')
    expect(query(container, 'automation-section-timer-count')?.textContent).toBe('1 timer')
    expect(query(container, 'automation-section-alarm-count')?.textContent).toBe('1 alarm')
  })

  it('карточка расписания показывает цель, триггер и времена', async () => {
    const container = await renderTab()

    const card = query(container, 'automation-item-sch_1')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Session One')
    expect(card!.textContent).toContain('Cron 0 3 * * *')
    expect(card!.textContent).toContain('run build')
  })

  it('карточка таймера показывает триггер, цель и обратный отсчёт', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer()]))

    const container = await renderTab()

    const card = query(container, 'automation-item-tmr_1')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Coffee')
    expect(card!.textContent).toContain('Session One')
    expect(card!.textContent).toContain('In 15 min')
    expect(card!.textContent).toContain('Remaining')
  })

  it('карточка будильника показывает ежедневное правило', async () => {
    mocks.listTimers.mockResolvedValue(
      timersPage([
        timer({
          id: 'tmr_alarm',
          kind: 'alarm',
          name: 'Standup',
          repeat: { mode: 'daily', time: '09:00', timezone: 'Europe/Moscow' },
        }),
      ]),
    )

    const container = await renderTab()

    const card = query(container, 'automation-item-tmr_alarm')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Every day at 09:00')
  })
})

describe('AutomationTab — фильтры', () => {
  it('фильтр вида переключает показываемые секции', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-filter-timer'))

    expect(query(container, 'automation-section-timer')).not.toBeNull()
    expect(query(container, 'automation-section-schedule')).toBeNull()
    expect(query(container, 'automation-section-alarm')).toBeNull()
  })

  it('фильтр состояния оставляет только подходящие записи', async () => {
    mocks.getSchedules.mockResolvedValue({
      schedules: [schedule(), schedule({ id: 'sch_2', name: 'Paused one', enabled: false })],
    })

    const container = await renderTab()
    expect(query(container, 'automation-item-sch_2')).not.toBeNull()

    await click(query(container, 'automation-status-paused'))

    expect(query(container, 'automation-item-sch_1')).toBeNull()
    expect(query(container, 'automation-item-sch_2')).not.toBeNull()
  })

  it('тумблер «Весь проект» переключает запрос на projectId', async () => {
    const container = await renderTab()

    await waitFor(() => {
      expect(mocks.getSchedules).toHaveBeenCalledWith({ sessionId: 's1' })
    })

    await click(container.querySelector('[data-testid="automation-whole-project"] button'))

    await waitFor(() => {
      expect(mocks.getSchedules).toHaveBeenCalledWith({ projectId: 'p1' })
    })
  })

  it('тумблер «Весь проект» скрыт без сессии', async () => {
    useUIStore.setState({
      selectedProjectId: 'p1',
      activeCenterTabId: 'tab-1',
      centerTabs: [],
    })

    const container = await renderTab()

    expect(query(container, 'automation-whole-project')).toBeNull()
  })
})

describe('AutomationTab — пустые состояния и ошибка', () => {
  it('пустые секции показывают подсказку', async () => {
    mocks.getSchedules.mockResolvedValue({ schedules: [] })

    const container = await renderTab()

    expect(query(container, 'automation-empty-schedule')).not.toBeNull()
    expect(query(container, 'automation-empty-timer')).not.toBeNull()
    expect(query(container, 'automation-empty-alarm')).not.toBeNull()
  })

  it('ошибка загрузки показывается баннером role="alert"', async () => {
    mocks.getSchedules.mockRejectedValue(new Error('boom'))

    const container = await renderTab()

    const banner = query(container, 'automation-error')
    expect(banner).not.toBeNull()
    expect(banner!.getAttribute('role')).toBe('alert')
    expect(banner!.textContent).toContain('boom')
  })

  it('без сессии и проекта — пустое состояние «выберите сессию или проект»', async () => {
    useUIStore.setState({ selectedProjectId: null, activeCenterTabId: 'tab-1', centerTabs: [] })

    const container = await renderTab()

    expect(query(container, 'automation-no-context')).not.toBeNull()
  })
})

describe('AutomationTab — действия', () => {
  it('переключатель расписания выключает его', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-item-sch_1-toggle'))

    await waitFor(() => {
      expect(mocks.updateSchedule).toHaveBeenCalledWith(
        'sch_1',
        expect.objectContaining({ enabled: false }),
      )
    })
  })

  it('«Запустить сейчас» дёргает принудительный запуск', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-item-sch_1-run'))

    await waitFor(() => {
      expect(mocks.runSchedule).toHaveBeenCalledWith('sch_1')
    })
  })

  it('удаление расписания спрашивает подтверждение', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-item-sch_1-delete'))

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalled()
      expect(mocks.deleteSchedule).toHaveBeenCalledWith('sch_1')
    })
  })

  it('пауза таймера вызывает pauseTimer', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer()]))

    const container = await renderTab()

    await click(query(container, 'automation-item-tmr_1-pause'))

    await waitFor(() => {
      expect(mocks.pauseTimer).toHaveBeenCalledWith('tmr_1')
    })
  })

  it('возобновление таймера вызывает resumeTimer', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer({ status: 'paused' })]))

    const container = await renderTab()

    await click(query(container, 'automation-item-tmr_1-pause'))

    await waitFor(() => {
      expect(mocks.resumeTimer).toHaveBeenCalledWith('tmr_1')
    })
  })

  it('удаление таймера убирает его из реестра', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer()]))

    const container = await renderTab()

    await click(query(container, 'automation-item-tmr_1-delete'))

    await waitFor(() => {
      expect(mocks.removeTimer).toHaveBeenCalledWith('tmr_1')
    })
  })
})

describe('AutomationTab — история', () => {
  it('история расписания раскрывается и грузит Job-историю', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-history-sch_1-toggle'))

    await waitFor(() => {
      expect(mocks.getScheduleJobs).toHaveBeenCalledWith('sch_1')
    })
  })

  it('история таймера грузит срабатывания', async () => {
    mocks.listTimers.mockResolvedValue(timersPage([timer()]))

    const container = await renderTab()

    await click(query(container, 'automation-history-tmr_1-toggle'))

    await waitFor(() => {
      expect(mocks.getTimerFirings).toHaveBeenCalledWith('tmr_1')
    })
  })
})

describe('AutomationTab — редакторы', () => {
  it('кнопка «+» в секции расписаний открывает модалку', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-schedule'))

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="schedule-editor-dialog"]')).not.toBeNull()
    })
  })

  it('модалка расписания сохраняет форму через API', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-schedule'))
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="schedule-editor-dialog"]')).not.toBeNull()
    })

    const name = document.body.querySelector('[data-testid="schedule-name"]') as HTMLInputElement
    setInputValue(name, 'Новое расписание')
    await flush()

    await click(document.body.querySelector('[data-testid="schedule-save"]'))

    await waitFor(() => {
      expect(mocks.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Новое расписание' }),
      )
    })
  })

  it('кнопка «+» в секции таймеров открывает модалку таймера', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-timer'))

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="timer-editor-dialog"]')).not.toBeNull()
    })
  })

  it('модалка таймера требует комментарий (валидация на месте)', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-timer'))
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="timer-editor-dialog"]')).not.toBeNull()
    })

    await click(document.body.querySelector('[data-testid="timer-save"]'))

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="timer-editor"]')?.textContent,
      ).toContain('Add a comment')
    })
    expect(mocks.createTimer).not.toHaveBeenCalled()
  })

  it('модалка таймера создаёт таймер через API', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-timer'))
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="timer-editor-dialog"]')).not.toBeNull()
    })

    const comment = document.body.querySelector('[data-testid="timer-comment"]') as HTMLTextAreaElement
    setInputValue(comment, 'позвонить в сервис')
    await flush()

    // Сессия по умолчанию — текущий контекст панели.
    await click(document.body.querySelector('[data-testid="timer-save"]'))

    await waitFor(() => {
      expect(mocks.createTimer).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'timer',
          comment: 'позвонить в сервис',
          sessionId: 's1',
          delaySec: 900,
        }),
      )
    })
  })

  it('модалка будильника предлагает правило «ежедневно»', async () => {
    const container = await renderTab()

    await click(query(container, 'automation-add-alarm'))
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="timer-editor-dialog"]')).not.toBeNull()
    })

    const repeat = document.body.querySelector('[data-testid="timer-repeat"]') as HTMLSelectElement
    expect([...repeat.options].map((option) => option.value)).toEqual(['once', 'daily', 'every'])

    await setNativeSelect(repeat, 'daily')
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="timer-time"]')).not.toBeNull()
    })
  })
})
