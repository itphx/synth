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
  listProcesses: vi.fn(),
  getProcessLogs: vi.fn(),
  stopProcess: vi.fn(),
  removeProcess: vi.fn(),
  runSessionScript: vi.fn(),
  resumeSubagent: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
  listTerminals: vi.fn(),
  openProcessLogTab: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listProcesses: mocks.listProcesses,
    getProcessLogs: mocks.getProcessLogs,
    stopProcess: mocks.stopProcess,
    removeProcess: mocks.removeProcess,
    runSessionScript: mocks.runSessionScript,
    resumeSubagent: mocks.resumeSubagent,
  },
}))
// Список терминалов проекта — серверный; в тесте перехватываем запрос.
vi.mock('@/lib/api/terminals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/terminals')>()
  return {
    ...actual,
    terminalsApi: { ...actual.terminalsApi, list: mocks.listTerminals },
  }
})
// Экран вывода — отдельная центральная вкладка; в тесте проверяем вызов.
vi.mock('@/lib/processTabs', () => ({ openProcessLogTab: mocks.openProcessLogTab }))
vi.mock('@/lib/confirm', () => ({ confirm: mocks.confirm }))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notify,
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ProcessesTab } from './ProcessesTab'
import { useUIStore } from '@/stores/useUIStore'
import { useProcessesStore } from '@/stores/processesStore'
import { useSessionsStore } from '@/stores/sessionsStore'
import { useTerminalsStore } from '@/stores/terminalsStore'
import type { TerminalDto } from '@/lib/api/terminals'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Фоновый прогон (процесс или саб-агент). */
function makeRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Снимок терминала проекта. */
function makeTerminal(id: string, overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id,
    projectId: 'p1',
    sessionId: 's1',
    ownerId: null,
    cwd: '/workspace/demo',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    title: `Terminal ${id}`,
    can_write: true,
    attached_clients: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    exitCode: null,
    signal: null,
    target: null,
    ...overrides,
  }
}

/** Доводит отложенные промисы эффектов/обработчиков до завершения. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderProcesses(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <ProcessesTab />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  await flush()
  return container
}

/** Клик по кнопке с указанным `data-testid`. */
async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  expect(button, `элемент ${testId} не найден`).toBeTruthy()
  await act(async () => {
    button!.click()
  })
  await flush()
}

/** Клик по тумблеру «Весь проект». */
async function toggleWholeProject(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector(
    '[data-testid="processes-whole-project"] [role="switch"]',
  ) as HTMLElement | null
  expect(toggle, 'тумблер «Весь проект» не найден').toBeTruthy()
  await act(async () => {
    toggle!.click()
  })
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listProcesses.mockResolvedValue([])
  mocks.listTerminals.mockResolvedValue({
    terminals: [],
    total: 0,
    offset: 0,
    limit: 50,
    nextOffset: null,
  })
  mocks.getProcessLogs.mockResolvedValue({
    content: 'вывод процесса\n',
    offset: 0,
    nextOffset: 15,
    totalBytes: 15,
    truncated: false,
  })
  mocks.stopProcess.mockResolvedValue({ status: 'stopping' })
  mocks.removeProcess.mockResolvedValue(undefined)
  mocks.resumeSubagent.mockResolvedValue({ status: 'started' })
  mocks.runSessionScript.mockResolvedValue({
    run_id: 'bgr_2',
    process_id: 'proc_2',
    log_path: 'processes/bgr_2.log',
    status: 'running',
  })
  mocks.confirm.mockResolvedValue(true)

  useProcessesStore.setState({
    byId: {},
    order: [],
    logs: {},
    pendingIds: [],
    error: null,
  })

  useTerminalsStore.setState({
    terminalsById: {},
    order: [],
    queryIds: {},
    loading: false,
    error: null,
  })

  // Сессия s1 в проекте p1, s2 — тоже в p1, s3 — в чужом проекте.
  useSessionsStore.setState({
    sessions: [
      { id: 's1', name: 'Session one', project_id: 'p1' },
      { id: 's2', name: 'Session two', project_id: 'p1' },
      { id: 's3', name: 'Session three', project_id: 'p9' },
    ] as never,
  })

  useUIStore.setState({
    activeCenterTabId: 'tab-1',
    centerTabs: [{ id: 'tab-1', type: 'chat', title: 'Chat', data: { sessionId: 's1' } }],
    selectedProjectId: null,
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
})

describe('ProcessesTab — реестр фоновой работы (PROP-096/097)', () => {
  it('рендерит карточки прогонов: вид, статус, команда', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { command: 'npm run build', cwd: '/work' }),
      makeRun('bgr_2', {
        kind: 'subagent',
        status: 'completed',
        childSessionId: 'child-1',
        description: 'Рефакторинг',
        exitCode: 0,
        finishedAt: '2026-10-01T00:05:00.000Z',
      }),
    ])

    const container = await renderProcesses()

    expect(mocks.listProcesses).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()

    // Вид прогона и статус.
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')?.getAttribute('data-kind')).toBe(
      'process',
    )
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')?.getAttribute('data-kind')).toBe(
      'subagent',
    )
    expect(container.querySelector('[data-testid="processes-status-bgr_1"]')?.textContent).toContain('running')
    expect(container.querySelector('[data-testid="processes-status-bgr_2"]')?.textContent).toContain('completed')

    // Команда и каталог процесса.
    const text = container.textContent ?? ''
    expect(text).toContain('npm run build')
    expect(text).toContain('/work')
    expect(text).toContain('Рефакторинг')
  })

  it('в карточке прогона есть строка «Время работы»', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()

    expect(container.textContent).toContain('Uptime')
  })

  it('три секции с заголовками и счётчиками', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { command: 'npm test' }),
      makeRun('bgr_2', { kind: 'subagent', childSessionId: 'child-1' }),
    ])
    mocks.listTerminals.mockResolvedValue({
      terminals: [makeTerminal('t1')],
      total: 1,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="terminals-section-title"]')?.textContent).toBe(
      'Terminals',
    )
    expect(container.querySelector('[data-testid="terminals-section-count"]')?.textContent).toBe(
      '1 terminal',
    )
    expect(container.querySelector('[data-testid="processes-section-process-title"]')?.textContent).toBe(
      'Background processes',
    )
    expect(
      container.querySelector('[data-testid="processes-section-process-count"]')?.textContent,
    ).toBe('1 process')
    expect(container.querySelector('[data-testid="processes-section-subagent-title"]')?.textContent).toBe(
      'Sub-agents',
    )
    expect(
      container.querySelector('[data-testid="processes-section-subagent-count"]')?.textContent,
    ).toBe('1 sub-agent')
  })

  it('пустые состояния секций — крупные блоки без кнопок', async () => {
    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-empty-process"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-empty-process"]')?.textContent).toContain(
      'No background processes',
    )
    expect(container.querySelector('[data-testid="processes-empty-subagent"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-empty-subagent"]')?.textContent).toContain(
      'No sub-agents',
    )
    expect(container.querySelector('[data-testid="terminals-empty"]')).not.toBeNull()
    // Кнопка создания терминала в пустом блоке не осталась — только «+» в шапке.
    expect(container.querySelector('[data-testid="terminals-create"]')).toBeNull()
    expect(container.querySelector('[data-testid="terminals-create-header"]')).not.toBeNull()
  })

  it('счётчиков «N прогонов» и «N выполняется» больше нет', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-count"]')).toBeNull()
    expect(container.querySelector('[data-testid="processes-running-count"]')).toBeNull()
  })

  it('инлайн-лога в панели нет — вывод открывается отдельным экраном', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-log"]')).toBeNull()
    expect(container.querySelector('[data-testid="processes-log-content"]')).toBeNull()
    expect(mocks.getProcessLogs).not.toHaveBeenCalled()
  })

  it('«Вывод» открывает экран вывода процесса', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()
    await click(container, 'processes-output-bgr_1')

    expect(mocks.openProcessLogTab).toHaveBeenCalledTimes(1)
    expect(mocks.openProcessLogTab.mock.calls[0]?.[0]).toMatchObject({ id: 'bgr_1' })
  })

  it('фильтр вида «Саб-агенты» оставляет только фоновых саб-агентов', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1'),
      makeRun('bgr_2', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()

    await click(container, 'processes-filter-subagent')

    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).toBeNull()
    // Остальные секции скрыты.
    expect(container.querySelector('[data-testid="processes-section-process"]')).toBeNull()
    expect(container.querySelector('[data-testid="terminals-section"]')).toBeNull()
  })

  it('«Остановить» вызывает stopProcess (после подтверждения)', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'sleep 100' })])

    const container = await renderProcesses()
    await click(container, 'processes-stop-bgr_1')

    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.stopProcess).toHaveBeenCalledWith('bgr_1')
  })

  it('отказ в подтверждении не вызывает stopProcess', async () => {
    mocks.confirm.mockResolvedValue(false)
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1')])

    const container = await renderProcesses()
    await click(container, 'processes-stop-bgr_1')

    expect(mocks.stopProcess).not.toHaveBeenCalled()
  })

  it('«Удалить» вызывает removeProcess и убирает запись', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { status: 'completed', finishedAt: '2026-10-01T00:05:00.000Z' }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-remove-bgr_1')

    expect(mocks.removeProcess).toHaveBeenCalledWith('bgr_1')
    expect(useProcessesStore.getState().byId['bgr_1']).toBeUndefined()
  })

  it('«Открыть сессию» открывает дочернюю сессию в центральной вкладке', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-open-bgr_1')

    const tabs = useUIStore.getState().centerTabs
    const opened = tabs.find((tab) => tab.data.sessionId === 'child-1')
    expect(opened).toBeDefined()
    expect(opened?.type).toBe('chat')
  })

  it('у саб-агента кнопки «Вывод» нет (лог есть только у процесса)', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-output-bgr_1"]')).toBeNull()
  })

  it('ошибка загрузки списка показывается в баннере', async () => {
    mocks.listProcesses.mockRejectedValue(new Error('доступ запрещён'))

    const container = await renderProcesses()

    const error = container.querySelector('[data-testid="processes-error"]')
    expect(error?.textContent).toContain('доступ запрещён')
  })

  it('компактные кнопки: фильтры и действия строк без min-h-10/min-w-10 (десктоп)', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { command: 'npm test' }),
      makeRun('bgr_2', { status: 'completed', finishedAt: '2026-10-01T00:05:00.000Z' }),
    ])

    const container = await renderProcesses()

    // Фильтры — как сегментные кнопки в других вкладках: без принудительных 40px.
    const filter = container.querySelector('[data-testid="processes-filter-all"]') as HTMLElement
    expect(filter).not.toBeNull()
    expect(filter.className).not.toContain('min-h-10')
    expect(filter.className).not.toContain('min-w-10')

    // Кнопки-действия строк — компактные (size="icon" → 32px), не 40px.
    for (const testId of ['processes-stop-bgr_1', 'processes-output-bgr_1', 'processes-remove-bgr_2']) {
      const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
      expect(button, `элемент ${testId} не найден`).toBeTruthy()
      expect(button.className).not.toContain('min-h-10')
      expect(button.className).not.toContain('min-w-10')
      expect(button.className).toContain('size-8')
      // Тач-таргет ≥40px на coarse-указателе (ADR-044).
      expect(button.className).toContain('pointer-coarse:size-10')
    }
  })
})

describe('ProcessesTab — продолжение потерянного прогона саб-агента (PROP-142 §2)', () => {
  it('у потерянного саб-агента есть «Продолжить»: клик возобновляет дочернюю сессию', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', status: 'orphaned', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()

    const button = container.querySelector('[data-testid="processes-resume-bgr_1"]')
    expect(button).not.toBeNull()

    await click(container, 'processes-resume-bgr_1')

    // Адресат — дочерняя сессия прогона, а не запись реестра.
    expect(mocks.resumeSubagent).toHaveBeenCalledWith('child-1')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Subagent run resumed', type: 'success' }),
    )
  })

  it('у шелл-процесса кнопки «Продолжить» нет, даже при status=orphaned', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', {
        kind: 'process',
        status: 'orphaned',
        childSessionId: 'child-1',
        command: 'npm test',
      }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-resume-bgr_1"]')).toBeNull()
  })

  it('у завершённого саб-агента (не orphaned) кнопки «Продолжить» нет', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', {
        kind: 'subagent',
        status: 'completed',
        childSessionId: 'child-1',
        finishedAt: '2026-10-01T00:05:00.000Z',
      }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-resume-bgr_1"]')).toBeNull()
  })

  it('ошибка продолжения показывается тостом ошибки', async () => {
    mocks.resumeSubagent.mockRejectedValue(new Error('нельзя продолжить'))
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { kind: 'subagent', status: 'orphaned', childSessionId: 'child-1' }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-resume-bgr_1')

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('нельзя продолжить'),
        type: 'error',
      }),
    )
  })
})

describe('ProcessesTab — скоуп показа (сессия / проект)', () => {
  it('список грузится с серверным фильтром сессии', async () => {
    await renderProcesses()

    expect(mocks.listProcesses).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('после «Весь проект» список перечитывается с фильтром проекта', async () => {
    const container = await renderProcesses()
    expect(mocks.listProcesses).toHaveBeenLastCalledWith({ sessionId: 's1' })

    await toggleWholeProject(container)

    expect(mocks.listProcesses).toHaveBeenLastCalledWith({ projectId: 'p1' })
  })

  it('в режиме выделенного проекта список грузится с фильтром проекта', async () => {
    useUIStore.setState({
      selectedProjectId: 'p1',
      activeCenterTabId: null,
      centerTabs: [],
    })

    await renderProcesses()

    expect(mocks.listProcesses).toHaveBeenCalledWith({ projectId: 'p1' })
  })

  it('по умолчанию видны только записи текущей сессии', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { sessionId: 's1' }),
      makeRun('bgr_2', { sessionId: 's2' }),
      makeRun('bgr_3', { sessionId: 's3' }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_3"]')).toBeNull()
  })

  it('тумблер «Весь проект» показывает записи других сессий проекта', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { sessionId: 's1' }),
      makeRun('bgr_2', { sessionId: 's2' }),
      makeRun('bgr_3', { sessionId: 's3' }),
    ])

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="processes-whole-project"]')).not.toBeNull()

    await toggleWholeProject(container)

    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()
    // Чужой проект — не показываем.
    expect(container.querySelector('[data-testid="processes-item-bgr_3"]')).toBeNull()
  })

  it('прогон с собственным projectId попадает в скоуп проекта', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { sessionId: 's1' }),
      makeRun('bgr_4', { sessionId: 's5', projectId: 'p1' }),
    ])

    const container = await renderProcesses()
    await toggleWholeProject(container)

    expect(container.querySelector('[data-testid="processes-item-bgr_4"]')).not.toBeNull()
  })

  it('в режиме выделенного проекта тумблера нет, скоуп всегда проектный', async () => {
    useUIStore.setState({
      selectedProjectId: 'p1',
      activeCenterTabId: null,
      centerTabs: [],
    })
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', { sessionId: 's1' }),
      makeRun('bgr_2', { sessionId: 's2' }),
      makeRun('bgr_3', { sessionId: 's3' }),
    ])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-whole-project"]')).toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="processes-item-bgr_3"]')).toBeNull()
  })

  it('без сессии и проекта — пустое состояние «Выберите сессию или проект»', async () => {
    useUIStore.setState({ activeCenterTabId: null, centerTabs: [], selectedProjectId: null })

    const container = await renderProcesses()

    const empty = container.querySelector('[data-testid="processes-no-context"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('Select a session or a project')
    expect(container.querySelector('[data-testid="processes-section-process"]')).toBeNull()
  })
})

describe('ProcessesTab — скриптовые прогоны (ADR-126 §5)', () => {
  it('скриптовый прогон помечен бейджем «скрипт: <имя>»', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', {
        command: './scripts/dev.sh',
        metadata: { script: 'dev' },
      }),
    ])

    const container = await renderProcesses()

    const badge = container.querySelector('[data-testid="processes-script-bgr_1"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('script: dev')
  })

  it('у обычного процесса бейджа и кнопки «Запустить снова» нет', async () => {
    mocks.listProcesses.mockResolvedValue([makeRun('bgr_1', { command: 'npm test' })])

    const container = await renderProcesses()

    expect(container.querySelector('[data-testid="processes-script-bgr_1"]')).toBeNull()
    expect(container.querySelector('[data-testid="processes-rerun-bgr_1"]')).toBeNull()
  })

  it('«Запустить снова» вызывает runSessionScript без аргументов и сообщает об успехе', async () => {
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', {
        command: './scripts/dev.sh',
        metadata: { script: 'dev' },
      }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-rerun-bgr_1')

    expect(mocks.runSessionScript).toHaveBeenCalledWith('s1', 'dev')
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Script started', type: 'success' }),
    )
  })

  it('ошибка повторного запуска показывается тостом', async () => {
    mocks.runSessionScript.mockRejectedValue(new Error('скрипт запрещён'))
    mocks.listProcesses.mockResolvedValue([
      makeRun('bgr_1', {
        command: './scripts/dev.sh',
        metadata: { script: 'dev' },
      }),
    ])

    const container = await renderProcesses()
    await click(container, 'processes-rerun-bgr_1')

    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('скрипт запрещён'), type: 'error' }),
    )
  })
})

describe('ProcessesTab — терминалы при активной вкладке терминала (PROP-132)', () => {
  /** Активная вкладка — терминал сессии s1 проекта p1. */
  function activateTerminalTab(): void {
    useUIStore.setState({
      activeCenterTabId: 'tab-term',
      centerTabs: [
        {
          id: 'tab-term',
          type: 'terminal',
          title: 'Terminal',
          data: { terminalId: 't1', projectId: 'p1', sessionId: 's1' },
        },
      ],
    })
  }

  it('терминалы проекта видны (живые и завершённые)', async () => {
    activateTerminalTab()
    mocks.listTerminals.mockResolvedValue({
      terminals: [
        makeTerminal('t1'),
        makeTerminal('t2', { status: 'exited', sessionId: 's2', restored: true }),
      ],
      total: 2,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })

    const container = await renderProcesses()

    // Проект взят из данных вкладки терминала (useActiveProject).
    expect(mocks.listTerminals).toHaveBeenCalledWith({ projectId: 'p1', includeExited: true })
    expect(container.querySelector('[data-testid="terminals-item-t1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-no-project"]')).toBeNull()

    // Скоуп сессии: терминал чужой сессии скрыт.
    expect(container.querySelector('[data-testid="terminals-item-t2"]')).toBeNull()

    // «Весь проект» — терминалы всех сессий проекта.
    await toggleWholeProject(container)
    expect(container.querySelector('[data-testid="terminals-item-t2"]')).not.toBeNull()
  })

  it('скоуп сессии оставляет терминалы только этой сессии', async () => {
    activateTerminalTab()
    mocks.listTerminals.mockResolvedValue({
      terminals: [makeTerminal('t1', { sessionId: 's1' }), makeTerminal('t2', { sessionId: 's2' })],
      total: 2,
      offset: 0,
      limit: 50,
      nextOffset: null,
    })

    const container = await renderProcesses()
    expect(container.querySelector('[data-testid="terminals-item-t1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-item-t2"]')).toBeNull()

    await toggleWholeProject(container)

    expect(container.querySelector('[data-testid="terminals-item-t1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="terminals-item-t2"]')).not.toBeNull()
  })
})
