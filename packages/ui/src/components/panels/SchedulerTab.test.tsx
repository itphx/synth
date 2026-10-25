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
  getSessions: vi.fn(),
  getAgents: vi.fn(),
  getProjects: vi.fn(),
  getProjectPipelines: vi.fn(),
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
import { SchedulerTab } from './SchedulerTab'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useAgentsStore } from '@/stores/agentsStore'
import { useProjectsStore } from '@/stores/projectsStore'
import { usePipelinesStore } from '@/stores/pipelinesStore'
import { useUIStore } from '@/stores/useUIStore'
import type { Schedule, ScheduleJob } from '@itphx/synth-shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

// jsdom + React-рендер под высокой конкуренцией: начальные загрузки/эффекты могут
// занимать больше дефолтных 5 c. Поднимаем таймаут теста (ассерты не смягчаем) —
// сами ожидания сведены к наблюдаемым фактам (waitFor/flush ниже), без «магических» пауз.
vi.setConfig({ testTimeout: 15_000 })

/**
 * Детерминированно доводит отложенные промисы (мок-API) и эффекты React до
 * завершения. Макро-барьер `setTimeout(0)` гарантирует, что очередь микрозадач
 * (в т.ч. вложенные загрузки «список → секции») полностью опустела — в отличие
 * от фиксированной паузы, не зависит от нагрузки. Внутри `act`, чтобы обновления
 * React были синхронными.
 */
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

const SESSION = { id: 's1', name: 'Session One', settings: {} }
const AGENT = { id: 'assistant', display_name: 'Assistant', enabled: true }
const PROJECT = { id: 'p1', name: 'Project One' }
const PROJECT_TWO = { id: 'p2', name: 'Project Two' }

/** Пайплайн проекта (ADR-101) — краткое представление из `GET /projects/:id/pipelines`. */
function projectPipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pl_1',
    name: 'Digest',
    scope: 'project',
    projectId: 'p1',
    draftVersion: 2,
    publishedVersion: 2,
    hasDraft: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

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

/** Открывает Base UI select и кликает опцию по подписи (опции рендерятся в portal). */
async function selectOption(trigger: HTMLElement | null, label: string): Promise<void> {
  expect(trigger, 'триггер селекта не найден').toBeTruthy()
  await act(async () => {
    ;(trigger as HTMLElement).click()
  })
  const allOptions = [...document.body.querySelectorAll('[role="option"]')]
  const option = allOptions.find((o) => o.textContent?.trim().startsWith(label)) as HTMLElement | undefined
  expect(option, `option "${label}"`).toBeTruthy()
  await act(async () => {
    option!.click()
  })
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
          <SchedulerTab />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  // Наблюдаемо ждём завершения начальной загрузки (список / пусто / ошибка) и
  // доводим вложенные эффекты (сессии) макро-барьером.
  await waitFor(() => {
    expect(
      container.querySelector(
        '[data-testid="scheduler-list"], [data-testid="scheduler-empty"], [role="alert"]',
      ),
    ).not.toBeNull()
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

beforeEach(() => {
  mocks.getSchedules.mockResolvedValue({ schedules: [schedule()] })
  mocks.createSchedule.mockResolvedValue(schedule())
  mocks.updateSchedule.mockResolvedValue(schedule())
  mocks.deleteSchedule.mockResolvedValue(undefined)
  mocks.runSchedule.mockResolvedValue(schedule())
  mocks.getScheduleJobs.mockResolvedValue({ jobs: [] })
  mocks.getSessions.mockResolvedValue([SESSION])
  mocks.getAgents.mockResolvedValue({ agents: [AGENT], default_agent: 'assistant' })
  mocks.getProjects.mockResolvedValue([PROJECT])
  mocks.getProjectPipelines.mockResolvedValue([projectPipeline()])
  mocks.confirm.mockResolvedValue(true)

  useSessionsStore.setState({ sessions: [SESSION] as never })
  useAgentsStore.setState({ agents: [AGENT] as never })
  useProjectsStore.setState({ projects: [PROJECT] as never })
  // Стор пайплайнов — синглтон модуля: сбрасываем кэш между тестами.
  usePipelinesStore.setState({
    pipelinesByProject: {},
    loadedProjects: new Set<string>(),
    loadingProjects: new Set<string>(),
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
  document.body.innerHTML = ''
})

describe('SchedulerTab — список расписаний (ADR-051/ADR-089)', () => {
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
    await act(async () => {
      setInputValue(name, '  Morning digest ')
    })
    await selectOption(
      container.querySelector('[data-testid="scheduler-session"]'),
      'Session One',
    )

    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

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
    await flush()

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
    await act(async () => {
      setInputValue(name, 'X')
    })
    await selectOption(
      container.querySelector('[data-testid="scheduler-session"]'),
      'Session One',
    )
    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

    expect(container.textContent).toContain('invalid cron')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    )
  })
})

describe('SchedulerTab — цель `pipeline` (ADR-101)', () => {
  /** Открывает форму создания и переключает цель на `pipeline`. */
  async function openPipelineEditor(container: HTMLElement): Promise<void> {
    await click(container.querySelector('[data-testid="scheduler-add"]'))
    await setNativeSelect(
      container.querySelector('[data-testid="scheduler-target"]') as HTMLSelectElement,
      'pipeline',
    )
    await flush()
  }

  /** Заполняет имя расписания. */
  async function setName(container: HTMLElement, value: string): Promise<void> {
    const name = container.querySelector('[data-testid="scheduler-name"]') as HTMLInputElement
    await act(async () => {
      setInputValue(name, value)
    })
  }

  it('создание с целью `pipeline` шлёт projectId/pipelineId/payload', async () => {
    const container = await renderTab()
    await openPipelineEditor(container)
    await setName(container, 'Nightly digest')

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project One',
    )
    await flush()
    await selectOption(container.querySelector('[data-testid="scheduler-pipeline"]'), 'Digest')

    const payload = container.querySelector('[data-testid="scheduler-payload"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(payload, '{"sessionId":"ses_1"}')
    })

    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

    expect(mocks.createSchedule).toHaveBeenCalledTimes(1)
    expect(mocks.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nightly digest',
        target: {
          mode: 'pipeline',
          projectId: 'p1',
          pipelineId: 'pl_1',
          payload: { sessionId: 'ses_1' },
        },
      }),
    )
  })

  it('пустой pipelineId → ошибка, запрос не уходит', async () => {
    const container = await renderTab()
    await openPipelineEditor(container)
    await setName(container, 'No pipeline')

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project One',
    )
    await flush()
    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

    expect(mocks.createSchedule).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Select a pipeline')
  })

  it('невалидный JSON в payload → ошибка, запрос не уходит', async () => {
    const container = await renderTab()
    await openPipelineEditor(container)
    await setName(container, 'Broken payload')

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project One',
    )
    await flush()
    await selectOption(container.querySelector('[data-testid="scheduler-pipeline"]'), 'Digest')

    const payload = container.querySelector('[data-testid="scheduler-payload"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(payload, '{oops')
    })
    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

    expect(mocks.createSchedule).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Payload must be a JSON object')
  })

  it('подпись цели показывает имя проекта и пайплайна', async () => {
    mocks.getSchedules.mockResolvedValue({
      schedules: [
        schedule({ target: { mode: 'pipeline', projectId: 'p1', pipelineId: 'pl_1' } }),
      ],
    })
    const container = await renderTab()

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="scheduler-item-sch_1"]')?.textContent,
      ).toContain('Pipeline run: Project One / Digest')
    })
  })

  it('подпись цели без имени пайплайна показывает id', async () => {
    mocks.getSchedules.mockResolvedValue({
      schedules: [
        schedule({ target: { mode: 'pipeline', projectId: 'p1', pipelineId: 'pl_x' } }),
      ],
    })
    mocks.getProjectPipelines.mockResolvedValue([])
    const container = await renderTab()

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="scheduler-item-sch_1"]')?.textContent,
      ).toContain('Pipeline run: Project One / pl_x')
    })
  })

  it('при смене проекта список пайплайнов перезапрашивается', async () => {
    mocks.getProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    const container = await renderTab()
    await openPipelineEditor(container)
    await waitFor(() => {
      expect(useProjectsStore.getState().projects).toHaveLength(2)
    })

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project One',
    )
    await flush()
    expect(mocks.getProjectPipelines).toHaveBeenCalledWith('p1')

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project Two',
    )
    await flush()
    expect(mocks.getProjectPipelines).toHaveBeenCalledWith('p2')
  })

  it('неопубликованный пайплайн показывает предупреждение, но сохраняется', async () => {
    mocks.getProjectPipelines.mockResolvedValue([
      projectPipeline({ publishedVersion: undefined, hasDraft: true }),
    ])
    const container = await renderTab()
    await openPipelineEditor(container)
    await setName(container, 'Draft pipeline')

    await selectOption(
      container.querySelector('[data-testid="scheduler-pipeline-project"]'),
      'Project One',
    )
    await flush()
    await selectOption(container.querySelector('[data-testid="scheduler-pipeline"]'), 'Digest')

    expect(container.querySelector('[data-testid="scheduler-pipeline-warning"]')).not.toBeNull()
    expect(container.textContent).toContain('not published')

    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()
    expect(mocks.createSchedule).toHaveBeenCalledTimes(1)
  })

  it('правка расписания с целью `pipeline` сохраняет цель (в т.ч. версию)', async () => {
    mocks.getSchedules.mockResolvedValue({
      schedules: [
        schedule({
          target: {
            mode: 'pipeline',
            projectId: 'p1',
            pipelineId: 'pl_1',
            version: 2,
            payload: { sessionId: 'ses_1' },
          },
        }),
      ],
    })
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-edit-sch_1"]'))
    await setName(container, 'Renamed digest')

    await click(container.querySelector('[data-testid="scheduler-save"]'))
    await flush()

    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      'sch_1',
      expect.objectContaining({
        name: 'Renamed digest',
        target: {
          mode: 'pipeline',
          projectId: 'p1',
          pipelineId: 'pl_1',
          version: 2,
          payload: { sessionId: 'ses_1' },
        },
      }),
    )
  })
})

describe('SchedulerTab — действия над расписанием', () => {
  it('«Запустить сейчас» вызывает runSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-run-sch_1"]'))
    await flush()
    expect(mocks.runSchedule).toHaveBeenCalledWith('sch_1')
  })

  it('toggle включает/выключает через updateSchedule', async () => {
    const container = await renderTab()
    const row = container.querySelector('[data-testid="scheduler-item-sch_1"]')!
    const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await click(toggle)
    await flush()

    expect(mocks.updateSchedule).toHaveBeenCalledWith(
      'sch_1',
      expect.objectContaining({ enabled: false, target: { mode: 'bound', sessionId: 's1' } }),
    )
  })

  it('удаление подтверждается через confirm и вызывает deleteSchedule', async () => {
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-delete-sch_1"]'))
    await flush()

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.deleteSchedule).toHaveBeenCalledWith('sch_1')
  })

  it('отмена подтверждения не удаляет расписание', async () => {
    mocks.confirm.mockResolvedValue(false)
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-delete-sch_1"]'))
    await flush()
    expect(mocks.deleteSchedule).not.toHaveBeenCalled()
  })
})

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: 'job_1',
    scheduleId: 'sch_1',
    scheduleName: 'Nightly build',
    trigger: 'cron',
    status: 'ok',
    startedAt: '2026-10-08T03:00:00.000Z',
    finishedAt: '2026-10-08T03:00:01.200Z',
    durationMs: 1200,
    target: { mode: 'bound', sessionId: 's1' },
    ...overrides,
  }
}

describe('SchedulerTab — рекомендация контекста (ADR-051)', () => {
  it('показывает рекомендацию и кнопка открывает вкладку «Контекст»', async () => {
    useUIStore.setState({ rightPanelTab: 'scheduler' })
    const container = await renderTab()

    expect(container.querySelector('[data-testid="scheduler-context-hint"]')).not.toBeNull()
    expect(container.textContent).toContain('context optimization')

    await click(container.querySelector('[data-testid="scheduler-open-context"]'))
    expect(useUIStore.getState().rightPanelTab).toBe('context')
  })
})

describe('SchedulerTab — история запусков (ADR-051)', () => {
  it('история лениво грузится при первом раскрытии и рендерит поля Job', async () => {
    mocks.getScheduleJobs.mockResolvedValue({
      jobs: [
        job({ id: 'job_1', trigger: 'manual', status: 'ok', decision: 'bound', sessionId: 's1' }),
        job({
          id: 'job_2',
          trigger: 'cron',
          status: 'skipped',
          durationMs: 0,
          reason: 'busy',
        }),
        job({
          id: 'job_3',
          trigger: 'catchup',
          status: 'skipped',
          reason: 'no_route',
          decision: 'drop',
        }),
      ],
    })
    const container = await renderTab()
    expect(mocks.getScheduleJobs).not.toHaveBeenCalled()

    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await flush()

    expect(mocks.getScheduleJobs).toHaveBeenCalledWith('sch_1')
    const history = container.querySelector('[data-testid="scheduler-history-sch_1"]')!
    expect(history.textContent).toContain('Manual')
    expect(history.textContent).toContain('Catch-up')
    expect(history.textContent).toContain('skipped · busy')
    expect(history.textContent).toContain('drop · no_route')
    expect(history.textContent).toContain('s1')
  })

  it('повторное раскрытие берёт историю из кэша (без нового запроса)', async () => {
    mocks.getScheduleJobs.mockResolvedValue({ jobs: [job()] })
    const container = await renderTab()

    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await flush()
    expect(mocks.getScheduleJobs).toHaveBeenCalledTimes(1)

    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await flush()
    expect(mocks.getScheduleJobs).toHaveBeenCalledTimes(1)
  })

  it('пустая история → «No runs yet»', async () => {
    mocks.getScheduleJobs.mockResolvedValue({ jobs: [] })
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await flush()
    expect(container.textContent).toContain('No runs yet')
  })

  it('ошибка загрузки истории показывается пользователю', async () => {
    mocks.getScheduleJobs.mockRejectedValue(new Error('history boom'))
    const container = await renderTab()
    await click(container.querySelector('[data-testid="scheduler-history-toggle-sch_1"]'))
    await flush()
    expect(container.textContent).toContain('history boom')
  })
})
